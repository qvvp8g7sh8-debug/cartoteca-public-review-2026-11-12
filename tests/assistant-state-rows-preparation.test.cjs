const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  fixture,
  openRows,
  addCurrentReservation,
  financial,
} = require('./helpers/assistant-state-rows-fixture.cjs');
const {
  prepareAssistantStateRowsCopy,
} = require('../src/server/migrations/prepare-assistant-state-rows.cjs');
const {
  migrateAssistantStateRows,
  MARKER,
} = require('../src/server/migrations/001-assistant-state-rows.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { createMultiServer } = require('../src/server/application/server.cjs');
const { createAssistantFileStore } = require('../src/server/modules/assistant/access/store.cjs');
const { MAX_BYTES, stateName } = require('../src/server/modules/assistant/access/state-file.cjs');
const rows = require('../src/server/modules/assistant/access/row-schema.cjs');
const repository = require('../src/server/modules/assistant/access/row-store.cjs');
const { decode } = require('../src/server/modules/assistant/access/row-codec.cjs');
const { assistantContext } = require('../src/server/infrastructure/backup/assistant-state.cjs');
const {
  createV2Backup,
  verifyV2Backup,
  recoverUpgradeCopy,
} = require('../src/server/infrastructure/backup/service.cjs');
const { readKey } = require('../src/server/infrastructure/backup/snapshot.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');
const { configuration } = require('../src/server/config.cjs');
const fingerprint = (directory) => inventoryFingerprint(dataInventory(directory));
const blocked = (directory) =>
  assert.throws(
    () =>
      createMultiServer({
        dataDir: directory,
        notificationSchema: 19,
        assistantStateBackend: 'rows-v1',
        sendMail: null,
        telegramBot: null,
        production: false,
        origin: '',
      }),
    /publication is incomplete/,
  );

for (const version of [19, 20])
  test(`rows component on schema${version}: complete copy, exact source, guarded startup and fresh-current rollback`, async (t) => {
    const f = await fixture(t, version),
      before = fingerprint(f.source),
      finances = financial(f.source);
    const result = await prepareAssistantStateRowsCopy({ ...f, offline: true });
    assert.equal(result.platformVersion, version);
    assert.equal(result.componentVersion, 1);
    assert.equal(result.backend, 'rows-v1');
    assert.equal(result.importSummary.grants, 1);
    assert.equal(result.importSummary.reservations, 1);
    assert.deepEqual(result.importSummary.rounding, {
      unit: 'microrub',
      mode: 'upward',
      roundedUpValues: 0,
      adjustmentRub: 0,
    });
    assert.equal(JSON.stringify(result).includes(f.initial.credentials.timeweb), false);
    assert.equal(fs.existsSync(path.join(f.destination, '.restore-in-progress')), false);
    assert.equal(fingerprint(f.source), before);
    assert.deepEqual(financial(f.destination), finances);
    await verifyV2Backup(result.preparedArchive, f.keyFile);
    const opened = openRows(f.destination);
    try {
      assert.deepEqual(opened.repository.exportLegacyState(), f.initial);
      const registration = rows.validate(opened.db, { required: true });
      assert.equal(
        registration.import_sha256,
        createHash('sha256')
          .update(fs.readFileSync(path.join(f.platformDirectory, stateName)))
          .digest('hex'),
      );
      assert.equal(opened.db.prepare('PRAGMA user_version').get().user_version, version);
    } finally {
      opened.close();
    }
    assert.throws(
      () =>
        createPlatformStore(path.join(f.destination, 'platform'), { notificationSchema: version }),
      /backend|mode|prepar/i,
    );
    const ready = createPlatformStore(path.join(f.destination, 'platform'), {
      notificationSchema: version,
      assistantStateBackend: 'rows-v1',
    });
    assert.equal(ready.notificationSchedule.enabled, false);
    ready.close();
    const changed = await addCurrentReservation(f, f.destination);
    const currentFingerprint = fingerprint(f.destination),
      rollback = path.join(f.root, 'rollback');
    const rolled = await prepareAssistantStateRowsCopy({
      ...f,
      source: f.destination,
      destination: rollback,
      offline: true,
      rollback: true,
    });
    assert.equal(rolled.backend, 'file');
    assert.equal(rolled.exportedRevision, changed.state.revision);
    assert.equal(fingerprint(f.destination), currentFingerprint);
    assert.equal(fingerprint(f.source), before);
    assert.deepEqual(financial(rollback), finances);
    const raw = new DatabaseSync(path.join(rollback, 'platform', 'platform.sqlite'));
    try {
      assert.equal(rows.validate(raw), null);
      const context = assistantContext(
        raw,
        readKey(path.join(rollback, 'platform', 'platform.key')),
        path.join(rollback, 'platform'),
      );
      assert.deepEqual(createAssistantFileStore(context).read(), changed.state);
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, version);
    } finally {
      raw.close();
    }
    const legacy = createPlatformStore(path.join(rollback, 'platform'), {
      notificationSchema: version,
    });
    legacy.close();
    assert.throws(
      () =>
        createPlatformStore(path.join(rollback, 'platform'), {
          notificationSchema: version,
          assistantStateBackend: 'rows-v1',
        }),
      /backend|mode|prepar/i,
    );
  });

test('a warmed original file store cannot read, regain grants or overwrite the encrypted sentinel', async (t) => {
  const f = await fixture(t),
    backup = await createV2Backup(f);
  await recoverUpgradeCopy(backup.file, f.keyFile, f.destination, { preparationMarker: MARKER });
  const directory = path.join(f.destination, 'platform'),
    db = new DatabaseSync(path.join(directory, 'platform.sqlite'));
  try {
    const context = assistantContext(db, readKey(path.join(directory, 'platform.key')), directory),
      old = createAssistantFileStore(context);
    assert.equal(old.read().grants.length, 1);
    migrateAssistantStateRows(directory);
    const bytes = fs.readFileSync(path.join(directory, stateName));
    assert.throws(() => old.read(), /assistant state/i);
    let called = false;
    assert.throws(
      () =>
        old.update(() => {
          called = true;
        }),
      /assistant state/i,
    );
    assert.equal(called, false);
    assert.deepEqual(fs.readFileSync(path.join(directory, stateName)), bytes);
    assert.equal(fs.existsSync(path.join(directory, 'assistant-state.lock')), false);
    blocked(f.destination);
  } finally {
    db.close();
  }
});

test('preparation requires stopped independent complete copy and retains barrier after a post-SQL file failure', async (t) => {
  const f = await fixture(t),
    before = fingerprint(f.source);
  await assert.rejects(prepareAssistantStateRowsCopy(f), /Stop every writer/);
  await assert.rejects(
    prepareAssistantStateRowsCopy({ ...f, destination: f.source, offline: true }),
    /separate/,
  );
  assert.throws(() => migrateAssistantStateRows(f.platformDirectory), /ENOENT/);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(to) === path.join(f.destination, 'platform', stateName))
      throw Error('Synthetic sentinel publication failure');
    return rename(from, to);
  });
  await assert.rejects(
    prepareAssistantStateRowsCopy({ ...f, offline: true }),
    /Synthetic sentinel/,
  );
  assert.equal(fs.readFileSync(path.join(f.destination, '.restore-in-progress'), 'utf8'), MARKER);
  blocked(f.destination);
  assert.equal(fingerprint(f.source), before);
  const raw = new DatabaseSync(path.join(f.destination, 'platform', 'platform.sqlite'));
  try {
    assert.equal(rows.validate(raw).backend, 'rows-v1');
  } finally {
    raw.close();
  }
});

test('rollback refuses an unrepresentable current export before dropping any rows or replacing the fence', async (t) => {
  const f = await fixture(t);
  await prepareAssistantStateRowsCopy({ ...f, offline: true });
  const source = f.destination,
    before = fingerprint(source),
    destination = path.join(f.root, 'oversized-rollback');
  const factory = repository.createAssistantRowStore;
  t.mock.method(repository, 'createAssistantRowStore', (...args) => {
    const store = factory(...args);
    return {
      ...store,
      exportLegacyState() {
        return { ...store.exportLegacyState(), syntheticLegacyExtension: 'x'.repeat(MAX_BYTES) };
      },
    };
  });
  await assert.rejects(
    prepareAssistantStateRowsCopy({ ...f, source, destination, offline: true, rollback: true }),
    /legacy state limit/,
  );
  assert.equal(fingerprint(source), before);
  assert.equal(fs.readFileSync(path.join(destination, '.restore-in-progress'), 'utf8'), MARKER);
  const opened = openRows(destination);
  try {
    assert.equal(rows.validate(opened.db).backend, 'rows-v1');
    assert.equal(opened.repository.readPolicy().revision, 7);
  } finally {
    opened.close();
  }
});

test('state backend configuration is closed, default file and independent of scheduled notifications', () => {
  assert.equal(configuration({}, {}).assistantStateBackend, 'file');
  const value = configuration({}, { CARTOTECA_ASSISTANT_STATE_BACKEND: 'rows-v1' });
  assert.equal(value.assistantStateBackend, 'rows-v1');
  assert.equal(value.scheduledNotifications, false);
  assert.equal(value.paymentNetworkEnabled, false);
  for (const assistantStateBackend of [true, 1, '', 'rows', 'auto'])
    assert.throws(
      () => configuration({ assistantStateBackend }, {}),
      /Invalid assistant state backend/,
    );
});

test('no legacy assistant file imports an explicitly OFF empty state without touching the source', async (t) => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.platformDirectory, stateName));
  const before = fingerprint(f.source);
  await prepareAssistantStateRowsCopy({ ...f, offline: true });
  const opened = openRows(f.destination);
  try {
    assert.equal(
      rows.validate(opened.db).import_sha256,
      createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    );
    assert.equal(opened.repository.readPolicy().policy.mode, 'off');
    assert.deepEqual(opened.repository.exportLegacyState().grants, []);
  } finally {
    opened.close();
  }
  assert.equal(fingerprint(f.source), before);
  assert.equal(fs.existsSync(path.join(f.platformDirectory, stateName)), false);
});

test('ordinary legacy corruption keeps its existing lazy disabled behavior without a global startup outage', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.platformDirectory, stateName),
    bytes = fs.readFileSync(filename);
  bytes[30] ^= 1;
  fs.writeFileSync(filename, bytes);
  const platform = createPlatformStore(f.platformDirectory, { notificationSchema: 19 });
  try {
    assert.equal(platform.hasAccounts(), true);
    assert.equal(
      platform.assistant.access({
        organizationId: f.owner.organizationId,
        accountId: f.owner.accountId,
        role: 'owner',
      }).enabled,
      false,
    );
  } finally {
    platform.close();
  }
  await assert.rejects(createV2Backup(f));
});

test('preparation reports conservative microrub rounding while retaining source and original evidence', async (t) => {
  const f = await fixture(t),
    db = new DatabaseSync(path.join(f.platformDirectory, 'platform.sqlite'));
  try {
    const context = assistantContext(
      db,
      readKey(path.join(f.platformDirectory, 'platform.key')),
      f.platformDirectory,
    );
    const old = createAssistantFileStore(context);
    db.exec('BEGIN IMMEDIATE');
    old.update((state) => {
      state.usage[f.month].spentRub = 4.0000001;
    });
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  const before = fingerprint(f.source),
    result = await prepareAssistantStateRowsCopy({ ...f, offline: true });
  assert.equal(result.importSummary.rounding.roundedUpValues, 1);
  assert.ok(Math.abs(result.importSummary.rounding.adjustmentRub - 0.0000009) < 1e-12);
  const opened = openRows(f.destination);
  try {
    assert.equal(opened.repository.month(f.month).spentRub, 4.000001);
    const saved = opened.db
      .prepare('SELECT value FROM assistant_usage_months WHERE month=?')
      .get(f.month);
    const evidence = decode(
      opened.context,
      rows.validate(opened.db),
      'assistant_usage_months',
      [f.month],
      saved.value,
    );
    assert.equal(evidence.original.spentRub, 4.0000001);
  } finally {
    opened.close();
  }
  assert.equal(fingerprint(f.source), before);
});
