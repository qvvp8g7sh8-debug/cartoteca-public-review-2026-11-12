const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  fixture,
  openRows,
  addCurrentReservation,
  seedLegacy,
  transaction,
} = require('./helpers/assistant-state-rows-fixture.cjs');
const {
  prepareAssistantStateRowsCopy,
} = require('../src/server/migrations/prepare-assistant-state-rows.cjs');
const {
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
  recoverUpgradeCopy,
} = require('../src/server/infrastructure/backup/service.cjs');
const { restoreDrill } = require('../src/server/infrastructure/backup/drill.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { createSentinel } = require('../src/server/modules/assistant/access/row-sentinel.cjs');
const rows = require('../src/server/modules/assistant/access/row-schema.cjs');
const { encode } = require('../src/server/modules/assistant/access/row-codec.cjs');
const { stateName } = require('../src/server/modules/assistant/access/state-file.cjs');
const { assistantContext } = require('../src/server/infrastructure/backup/assistant-state.cjs');
const { readKey } = require('../src/server/infrastructure/backup/snapshot.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');
const { organizationRestoreFixture } = require('./helpers/organization-restore-fixture.cjs');
const {
  prepareOrganizationRestore,
  verifyOrganizationRestore,
} = require('../src/server/infrastructure/backup/organization-restore.cjs');
const fingerprint = (directory) => inventoryFingerprint(dataInventory(directory));
function assistantRows(directory) {
  const db = new DatabaseSync(path.join(directory, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    return ['assistant_state_schema', ...rows.tables].map((name) => [
      name,
      db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all(),
    ]);
  } finally {
    db.close();
  }
}

test('upgrade copy preserves rows/fence; disaster restore settles current pending debt and revokes only capabilities', async (t) => {
  const f = await fixture(t);
  await prepareAssistantStateRowsCopy({ ...f, offline: true });
  const changed = await addCurrentReservation(f, f.destination);
  const source = f.destination,
    before = fingerprint(source),
    expectedRows = assistantRows(source);
  const backup = await createV2Backup({ ...f, source });
  await verifyV2Backup(backup.file, f.keyFile);
  const upgrade = path.join(f.root, 'upgrade');
  await recoverUpgradeCopy(backup.file, f.keyFile, upgrade);
  assert.deepEqual(assistantRows(upgrade), expectedRows);
  assert.deepEqual(
    fs.readFileSync(path.join(upgrade, 'platform', stateName)),
    fs.readFileSync(path.join(source, 'platform', stateName)),
  );
  const recovered = path.join(f.root, 'recovered');
  await restoreV2Backup(backup.file, f.keyFile, recovered);
  const opened = openRows(recovered);
  try {
    const restored = opened.repository.exportLegacyState();
    assert.equal(restored.revision, changed.state.revision + 1);
    assert.equal(restored.policy.mode, 'off');
    assert.deepEqual(restored.credentials, {});
    assert.deepEqual(restored.grants, []);
    assert.deepEqual(restored.reservations, {});
    assert.deepEqual(restored.operations, []);
    assert.deepEqual(restored.audit, []);
    assert.deepEqual(restored.history, []);
    assert.deepEqual(restored.daily, changed.state.daily);
    assert.equal(restored.usage[f.month].spentRub, 7.75);
    assert.equal(restored.usage[f.month].calls, 4);
    assert.equal(restored.usage[f.month].uncertainCalls, 3);
    assert.equal(
      opened.db.prepare('SELECT enabled,grant_version FROM assistant_grants').get().enabled,
      0,
    );
    assert.ok(
      opened.db.prepare('SELECT grant_version FROM assistant_grants').get().grant_version > 1,
    );
    assert.equal(opened.repository.grant(f.owner.organizationId, f.owner.accountId), null);
    transaction(opened.db, () =>
      opened.repository.updateAdmin((state) => {
        state.revision++;
        state.policy.mode = 'selected';
      }),
    );
  } finally {
    opened.close();
  }
  assert.deepEqual(
    fs.readFileSync(path.join(recovered, 'platform', stateName)),
    fs.readFileSync(path.join(source, 'platform', stateName)),
    'Reset never overwrites the old-binary fence with a legacy file',
  );
  const fresh = createPlatformStore(path.join(recovered, 'platform'), {
    notificationSchema: 19,
    assistantStateBackend: 'rows-v1',
  });
  try {
    assert.equal(
      fresh.assistant.access({
        organizationId: f.owner.organizationId,
        accountId: f.owner.accountId,
        role: 'owner',
      }).enabled,
      false,
    );
  } finally {
    fresh.close();
  }
  assert.deepEqual(await restoreDrill(backup.file, f.keyFile, path.join(f.root, 'drill')), {
    restored: true,
    started: true,
    notificationsPaused: true,
  });
  assert.equal(fingerprint(source), before);
});

test('streaming backup accepts valid row history that cannot fit the legacy collection cap', async (t) => {
  const f = await fixture(t);
  await prepareAssistantStateRowsCopy({ ...f, offline: true });
  const opened = openRows(f.destination);
  try {
    const registration = rows.validate(opened.db);
    transaction(opened.db, () => {
      for (let index = 0; index < 25; index++) {
        const month =
          2020 + Math.floor(index / 12) + '-' + String((index % 12) + 1).padStart(2, '0');
        opened.db.prepare('INSERT INTO assistant_usage_months VALUES(?,1,0,1,0,?)').run(
          month,
          encode(opened.context, registration, 'assistant_usage_months', [month], {
            original: null,
          }),
        );
      }
    });
    assert.throws(() => opened.repository.exportLegacyState(), /assistant state/i);
  } finally {
    opened.close();
  }
  const before = fingerprint(f.destination),
    result = await createV2Backup({ ...f, source: f.destination });
  await verifyV2Backup(result.file, f.keyFile);
  await assert.rejects(
    prepareAssistantStateRowsCopy({
      ...f,
      source: f.destination,
      destination: path.join(f.root, 'collection-limit-rollback'),
      offline: true,
      rollback: true,
    }),
    /assistant state/i,
  );
  assert.equal(fingerprint(f.destination), before);
});

test('missing, transposed or damaged sentinel/component cannot start or publish a backup', async (t) => {
  const f = await fixture(t);
  await prepareAssistantStateRowsCopy({ ...f, offline: true });
  const filename = path.join(f.destination, 'platform', stateName),
    bytes = fs.readFileSync(filename);
  const opened = openRows(f.destination);
  try {
    const registration = rows.validate(opened.db),
      falseIdentity = opened.context.seal({
        ...createSentinel(registration),
        storeId: randomUUID(),
      });
    for (const replacement of [null, falseIdentity, Buffer.alloc(bytes.length, 3)]) {
      if (replacement) fs.writeFileSync(filename, replacement);
      else fs.unlinkSync(filename);
      await assert.rejects(createV2Backup({ ...f, source: f.destination }));
      assert.throws(() =>
        createPlatformStore(path.join(f.destination, 'platform'), {
          notificationSchema: 19,
          assistantStateBackend: 'rows-v1',
        }),
      );
      fs.writeFileSync(filename, bytes);
    }
    opened.db.exec('DROP INDEX assistant_grants_account');
    await assert.rejects(createV2Backup({ ...f, source: f.destination }), /component schema/);
    assert.throws(
      () =>
        createPlatformStore(path.join(f.destination, 'platform'), {
          notificationSchema: 19,
          assistantStateBackend: 'rows-v1',
        }),
      /component schema/,
    );
  } finally {
    opened.close();
  }
});

test('orphan authenticated fence, wrong row identity and inconsistent accounting fail archive validation', async (t) => {
  const f = await fixture(t);
  const legacy = new DatabaseSync(path.join(f.platformDirectory, 'platform.sqlite'));
  const original = fs.readFileSync(path.join(f.platformDirectory, stateName));
  try {
    const context = assistantContext(
      legacy,
      readKey(path.join(f.platformDirectory, 'platform.key')),
      f.platformDirectory,
    );
    fs.writeFileSync(
      path.join(f.platformDirectory, stateName),
      context.seal(createSentinel({ store_id: randomUUID(), import_sha256: 'a'.repeat(64) })),
    );
    await assert.rejects(createV2Backup(f));
    assert.throws(
      () => createPlatformStore(f.platformDirectory, { notificationSchema: 19 }),
      /component is missing/,
    );
  } finally {
    fs.writeFileSync(path.join(f.platformDirectory, stateName), original);
    legacy.close();
  }
  await prepareAssistantStateRowsCopy({ ...f, offline: true });
  const opened = openRows(f.destination);
  try {
    const good = opened.db.prepare('SELECT value FROM assistant_grants').get().value;
    transaction(opened.db, () =>
      opened.db
        .prepare(
          'UPDATE assistant_grants SET value=(SELECT value FROM assistant_settings WHERE id=1)',
        )
        .run(),
    );
    await assert.rejects(
      createV2Backup({ ...f, source: f.destination }),
      /encrypted identity mismatch/,
    );
    opened.db.prepare('UPDATE assistant_grants SET value=?').run(good);
    opened.db
      .prepare('UPDATE assistant_usage_months SET reserved_microrub=reserved_microrub+1')
      .run();
    await assert.rejects(createV2Backup({ ...f, source: f.destination }), /aggregate mismatch/);
  } finally {
    opened.close();
  }
});

test('legacy dangling grants are rejected on conversion and guard91 remains mandatory', async (t) => {
  const f = await fixture(t),
    raw = new DatabaseSync(path.join(f.platformDirectory, 'platform.sqlite'));
  try {
    const context = assistantContext(
      raw,
      readKey(path.join(f.platformDirectory, 'platform.key')),
      f.platformDirectory,
    );
    const filename = path.join(f.platformDirectory, stateName),
      value = context.open(fs.readFileSync(filename));
    value.grants[0].accountId = 'no-such-synthetic-account';
    fs.writeFileSync(filename, context.seal(value));
  } finally {
    raw.close();
  }
  const before = fingerprint(f.source);
  await assert.rejects(
    prepareAssistantStateRowsCopy({ ...f, offline: true }),
    /FOREIGN KEY|integrity/i,
  );
  assert.equal(fingerprint(f.source), before);
  assert.equal(fs.existsSync(path.join(f.destination, '.restore-in-progress')), true);
  const broken = new DatabaseSync(path.join(f.platformDirectory, 'platform.sqlite'));
  try {
    broken.exec('DROP INDEX billing_entries_wallet');
  } finally {
    broken.close();
  }
  await assert.rejects(
    prepareAssistantStateRowsCopy({
      ...f,
      destination: path.join(f.root, 'bad-financial'),
      offline: true,
    }),
    /Financial schema index/,
  );
});

test('selective clinical restore preserves every current assistant row and fence across a pre-component archive', async (t) => {
  const f = await organizationRestoreFixture(t, 19);
  seedLegacy(f.source, f.owners[0]);
  const source = path.join(f.directory, 'assistant-rows-current');
  const prepared = await prepareAssistantStateRowsCopy({
    source: f.source,
    destination: source,
    directory: path.join(f.directory, 'rows-archives'),
    keyFile: f.keyFile,
    offline: true,
  });
  const before = fingerprint(source),
    expected = assistantRows(source),
    fence = fs.readFileSync(path.join(source, 'platform', stateName));
  const jobDirectory = path.join(f.directory, 'rows-selective-job');
  await prepareOrganizationRestore({ ...f.options, source, jobDirectory });
  await verifyOrganizationRestore({ source, jobDirectory, keyFile: f.keyFile });
  const candidate = path.join(jobDirectory, 'candidate');
  assert.deepEqual(assistantRows(candidate), expected);
  assert.deepEqual(fs.readFileSync(path.join(candidate, 'platform', stateName)), fence);
  assert.equal(fingerprint(source), before);
  // The opposite direction cannot silently abandon historical row capabilities.
  await assert.rejects(
    prepareOrganizationRestore({
      ...f.options,
      archive: prepared.preparedArchive,
      jobDirectory: path.join(f.directory, 'reverse-selective-job'),
    }),
    /Prepare current assistant rows/,
  );
});
