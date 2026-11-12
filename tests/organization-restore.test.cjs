const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStorage } = require('../storage.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { organizationRestoreFixture } = require('./helpers/organization-restore-fixture.cjs');
const {
  prepareOrganizationRestore,
  verifyOrganizationRestore,
  readRestorePlan,
} = require('../src/server/infrastructure/backup/organization-restore.cjs');
const {
  applyOrganizationRestore,
  rollbackOrganizationRestore,
} = require('../src/server/infrastructure/backup/organization-switch.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');
const { switchMarker } = require('../src/server/infrastructure/backup/organization-guard.cjs');
const { signDocument } = require('../src/server/infrastructure/backup/organization-signature.cjs');
const { atomicJson } = require('../src/server/infrastructure/backup/durable.cjs');

const fingerprint = (directory) => inventoryFingerprint(dataInventory(directory));
function notes(directory, org) {
  const cabinet = createStorage(path.join(directory, 'tenants', org));
  try {
    return cabinet.read().patients[0].notes;
  } finally {
    cabinet.close();
  }
}
function switchOptions(f, prepared) {
  return {
    source: f.source,
    jobDirectory: f.jobDirectory,
    keyFile: f.keyFile,
    confirmation: prepared.id,
    stopped: true,
  };
}
for (const version of [11, 15, 16, 17, 18, 19, 20])
  test(`organization restore schema ${version}: isolated preparation, offline apply and lossless rollback`, async (t) => {
    const f = await organizationRestoreFixture(t, version),
      before = fingerprint(f.source);
    const prepared = await prepareOrganizationRestore(f.options),
      candidate = path.join(f.jobDirectory, 'candidate');
    assert.equal(prepared.state, 'prepared');
    assert.equal(fingerprint(f.source), before);
    assert.equal(notes(candidate, f.owners[0].organizationId), 'OLD PRIVATE NOTE');
    for (const other of f.owners.slice(1))
      assert.equal(notes(candidate, other.organizationId), 'CURRENT PRIVATE NOTE');
    assert.throws(
      () => createMultiServer({ dataDir: candidate, notificationSchema: version }),
      /incomplete/,
    );
    assert.equal((await verifyOrganizationRestore(f)).id, prepared.id);
    const sourcePlatform = f.openPlatform();
    const originalIdentity = sourcePlatform.db.prepare('SELECT * FROM accounts ORDER BY id').all();
    const originalAccess = sourcePlatform.db
      .prepare('SELECT * FROM memberships ORDER BY account_id')
      .all();
    sourcePlatform.db.close();
    await applyOrganizationRestore(switchOptions(f, prepared));
    assert.equal(notes(f.source, f.owners[0].organizationId), 'OLD PRIVATE NOTE');
    for (const other of f.owners.slice(1))
      assert.equal(notes(f.source, other.organizationId), 'CURRENT PRIVATE NOTE');
    assert.equal(
      fs.readFileSync(path.join(f.source, 'platform', 'operator-note.txt'), 'utf8'),
      'synthetic retained metadata',
    );
    assert.equal(
      fs.readFileSync(
        path.join(f.source, 'tenants', f.owners[1].organizationId, 'photos', 'orphan.enc'),
        'utf8',
      ),
      'synthetic unrelated orphan',
    );
    const platform = f.openPlatform();
    try {
      assert.deepEqual(
        platform.db.prepare('SELECT * FROM accounts ORDER BY id').all(),
        originalIdentity,
      );
      assert.deepEqual(
        platform.db.prepare('SELECT * FROM memberships ORDER BY account_id').all(),
        originalAccess,
      );
      assert.equal(
        platform.open(
          platform.db
            .prepare('SELECT value FROM telegram_settings WHERE organization_id=?')
            .get(f.owners[0].organizationId).value,
        ).enabled,
        false,
      );
      assert.equal(
        platform.db
          .prepare('SELECT status FROM booking_requests WHERE id=?')
          .get('synthetic-request').status,
        'expired',
      );
      assert.equal(
        platform.open(
          platform.db
            .prepare('SELECT value FROM work_schedule_profiles WHERE organization_id=?')
            .get(f.owners[0].organizationId).value,
        ).allowSelfEdit,
        false,
      );
      if (version >= 12) {
        const readLink = (owner) =>
          platform.open(
            platform.db
              .prepare('SELECT value FROM max_client_links WHERE organization_id=?')
              .get(owner.organizationId).value,
          );
        assert.equal(readLink(f.owners[0]).restoredPaused, true);
        assert.equal(readLink(f.owners[1]).restoredPaused, false);
      }
      if (version >= 13) {
        assert.equal(
          platform.db
            .prepare('SELECT status FROM notification_jobs WHERE id=?')
            .get('synthetic-job-0').status,
          'failed',
        );
        assert.equal(
          platform.db
            .prepare('SELECT status FROM notification_jobs WHERE id=?')
            .get('synthetic-job-1').status,
          'pending',
        );
        assert.notEqual(
          platform.db
            .prepare('SELECT callback_hash FROM notification_jobs WHERE id=?')
            .get('synthetic-job-0').callback_hash,
          'synthetic-callback-0',
        );
        assert.equal(
          platform.open(
            platform.db
              .prepare('SELECT value FROM notification_confirmations WHERE organization_id=?')
              .get(f.owners[0].organizationId).value,
          ).confirmedAt,
          123,
        );
      }
      if (version >= 16) {
        assert.equal(
          platform.open(
            platform.db
              .prepare('SELECT value FROM staff_max_links WHERE organization_id=?')
              .get(f.owners[0].organizationId).value,
          ).enabled,
          false,
        );
        assert.equal(
          platform.open(
            platform.db
              .prepare('SELECT value FROM staff_max_links WHERE organization_id=?')
              .get(f.owners[1].organizationId).value,
          ).enabled,
          true,
        );
      }
    } finally {
      platform.db.close();
    }
    assert.equal(fs.existsSync(switchMarker(f.source)), false);
    assert.equal(rollbackOrganizationRestore(switchOptions(f, prepared)).state, 'rolled-back');
    assert.equal(fingerprint(f.source), before);
    assert.equal(notes(f.source, f.owners[0].organizationId), 'CURRENT PRIVATE NOTE');
  });

test('second-half interrupted switch recovers both components without touching unrelated files', async (t) => {
  const f = await organizationRestoreFixture(t),
    prepared = await prepareOrganizationRestore(f.options),
    before = fingerprint(f.source);
  const previous = f.source + '.before-restore-' + prepared.id;
  atomicJson(
    switchMarker(f.source),
    signDocument(
      {
        format: 1,
        id: prepared.id,
        source: f.source,
        jobDirectory: f.jobDirectory,
        previous,
        phase: 'cabinet-saved',
      },
      f.keyFile,
    ),
  );
  fs.mkdirSync(previous);
  fs.renameSync(path.join(f.source, 'platform'), path.join(previous, 'platform'));
  fs.renameSync(
    path.join(f.jobDirectory, 'candidate', 'platform'),
    path.join(f.source, 'platform'),
  );
  fs.renameSync(
    path.join(f.source, 'tenants', f.owners[0].organizationId),
    path.join(previous, 'cabinet'),
  );
  assert.throws(() => createMultiServer({ dataDir: f.source }), /incomplete/);
  assert.equal(rollbackOrganizationRestore(switchOptions(f, prepared)).state, 'rolled-back');
  assert.equal(fingerprint(f.source), before);
  assert.equal(
    fs.readFileSync(path.join(f.source, 'platform', 'operator-note.txt'), 'utf8'),
    'synthetic retained metadata',
  );
});

test('missing active photograph and incompatible historical platform schema are rejected', async (t) => {
  const f = await organizationRestoreFixture(t),
    before = fingerprint(f.source);
  const archive = require('../src/server/infrastructure/backup/archive.cjs');
  const { readKey } = require('../src/server/infrastructure/backup/snapshot.cjs');
  const stage = path.join(f.directory, 'synthetic-archive');
  fs.mkdirSync(stage);
  const extracted = await archive.extractArchive(f.archive, readKey(f.keyFile), stage);
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted.recovered, 'manifest.json')));
  const photo = manifest.files.find((entry) => entry.name.includes('/photos/'));
  fs.unlinkSync(path.join(extracted.recovered, photo.name));
  manifest.files = manifest.files.filter((entry) => entry.name !== photo.name);
  fs.writeFileSync(path.join(extracted.recovered, 'manifest.json'), JSON.stringify(manifest));
  const bad = path.join(f.directory, 'missing-photo.enc');
  await archive.writeArchive(
    extracted.recovered,
    ['manifest.json', ...manifest.files.map((entry) => entry.name)],
    bad,
    readKey(f.keyFile),
  );
  await assert.rejects(prepareOrganizationRestore({ ...f.options, archive: bad }));
  assert.equal(fingerprint(f.source), before);
  const { migrateMaxConnections } = require('../src/server/migrations/012-max-connections.cjs');
  const db = f.openPlatform();
  migrateMaxConnections(db, path.join(f.source, 'platform'));
  db.db.close();
  await assert.rejects(
    prepareOrganizationRestore({
      ...f.options,
      jobDirectory: path.join(f.directory, 'schema-job'),
    }),
    /equal supported/,
  );
});

test('restore rejects missing historical membership and keeps all source data', async (t) => {
  const f = await organizationRestoreFixture(t),
    db = f.openPlatform();
  db.db.prepare('DELETE FROM memberships WHERE organization_id=?').run(f.owners[0].organizationId);
  db.db.close();
  const before = fingerprint(f.source);
  await assert.rejects(prepareOrganizationRestore(f.options), /staff reference/);
  assert.equal(fingerprint(f.source), before);
});
test('restore never reopens current suspended membership', async (t) => {
  const f = await organizationRestoreFixture(t),
    db = f.openPlatform();
  db.db
    .prepare("UPDATE memberships SET status='suspended' WHERE organization_id=?")
    .run(f.owners[0].organizationId);
  db.db.close();
  await prepareOrganizationRestore(f.options);
  const candidate = new DatabaseSync(
    path.join(f.jobDirectory, 'candidate', 'platform', 'platform.sqlite'),
    { readOnly: true },
  );
  try {
    assert.equal(
      candidate
        .prepare('SELECT status FROM memberships WHERE organization_id=?')
        .get(f.owners[0].organizationId).status,
      'suspended',
    );
  } finally {
    candidate.close();
  }
});

test('restore does not resurrect withdrawn client messaging bindings', async (t) => {
  const f = await organizationRestoreFixture(t, 15),
    db = f.openPlatform();
  const org = f.owners[0].organizationId;
  db.db.prepare('DELETE FROM telegram_links WHERE organization_id=?').run(org);
  db.db.prepare('DELETE FROM max_client_links WHERE organization_id=?').run(org);
  db.db.close();
  await prepareOrganizationRestore(f.options);
  const candidate = new DatabaseSync(
    path.join(f.jobDirectory, 'candidate', 'platform', 'platform.sqlite'),
    { readOnly: true },
  );
  try {
    assert.equal(
      candidate.prepare('SELECT 1 FROM telegram_links WHERE organization_id=?').get(org),
      undefined,
    );
    assert.equal(
      candidate.prepare('SELECT 1 FROM max_client_links WHERE organization_id=?').get(org),
      undefined,
    );
  } finally {
    candidate.close();
  }
});
test('offline apply requires explicit stopped writers and exact confirmation', async (t) => {
  const f = await organizationRestoreFixture(t),
    prepared = await prepareOrganizationRestore(f.options),
    before = fingerprint(f.source);
  await assert.rejects(
    applyOrganizationRestore({ ...switchOptions(f, prepared), stopped: false }),
    /Stop ALL/,
  );
  await assert.rejects(
    applyOrganizationRestore({ ...switchOptions(f, prepared), confirmation: 'wrong' }),
    /confirmation/,
  );
  assert.equal(fingerprint(f.source), before);
  assert.equal(fs.existsSync(switchMarker(f.source)), false);
});
test('source writes after preparation refuse switching; candidate mutation refuses verification', async (t) => {
  const f = await organizationRestoreFixture(t),
    prepared = await prepareOrganizationRestore(f.options);
  const cabinet = createStorage(path.join(f.source, 'tenants', f.owners[1].organizationId));
  const state = cabinet.read();
  state.patients[0].notes = 'NEW WRITE';
  cabinet.write(state);
  cabinet.close();
  await assert.rejects(applyOrganizationRestore(switchOptions(f, prepared)), /Source changed/);
  const candidate = createStorage(
    path.join(f.jobDirectory, 'candidate', 'tenants', f.owners[0].organizationId),
  );
  const changed = candidate.read();
  changed.patients[0].notes = 'CHANGED CANDIDATE';
  candidate.write(changed);
  candidate.close();
  await assert.rejects(verifyOrganizationRestore(f), /Prepared data changed/);
});
test('rollback refuses new platform/organization data after activation', async (t) => {
  const f = await organizationRestoreFixture(t),
    prepared = await prepareOrganizationRestore(f.options);
  await applyOrganizationRestore(switchOptions(f, prepared));
  const cabinet = createStorage(path.join(f.source, 'tenants', f.owners[0].organizationId));
  const state = cabinet.read();
  state.patients[0].notes = 'POST-RESTORE WRITE';
  cabinet.write(state);
  cabinet.close();
  assert.throws(() => rollbackOrganizationRestore(switchOptions(f, prepared)), /New data/);
  assert.equal(notes(f.source, f.owners[0].organizationId), 'POST-RESTORE WRITE');
});
test('interrupted first platform rename blocks startup and returns original safely', async (t) => {
  const f = await organizationRestoreFixture(t),
    prepared = await prepareOrganizationRestore(f.options),
    before = fingerprint(f.source);
  const plan = readRestorePlan(f.jobDirectory, f.keyFile),
    previous = f.source + '.before-restore-' + prepared.id;
  atomicJson(
    switchMarker(f.source),
    signDocument(
      {
        format: 1,
        id: prepared.id,
        source: f.source,
        jobDirectory: f.jobDirectory,
        previous,
        phase: 'intent',
      },
      f.keyFile,
    ),
  );
  fs.mkdirSync(previous);
  fs.renameSync(path.join(f.source, 'platform'), path.join(previous, 'platform'));
  assert.throws(() => createMultiServer({ dataDir: f.source }), /incomplete/);
  assert.equal(rollbackOrganizationRestore(switchOptions(f, prepared)).state, 'rolled-back');
  assert.equal(fingerprint(f.source), before);
  assert.equal(plan.sourceFingerprint, before);
});
test('tampered signed plan and corrupted historical archive are rejected without source changes', async (t) => {
  const f = await organizationRestoreFixture(t),
    before = fingerprint(f.source);
  const bytes = fs.readFileSync(f.archive);
  bytes[bytes.length - 1] ^= 1;
  const bad = path.join(f.directory, 'bad.enc');
  fs.writeFileSync(bad, bytes);
  await assert.rejects(prepareOrganizationRestore({ ...f.options, archive: bad }));
  assert.equal(fingerprint(f.source), before);
  const jobDirectory = path.join(f.directory, 'valid-job');
  await prepareOrganizationRestore({ ...f.options, jobDirectory });
  const filename = path.join(jobDirectory, 'plan.json'),
    plan = JSON.parse(fs.readFileSync(filename));
  plan.organizationId = f.owners[1].organizationId;
  fs.writeFileSync(filename, JSON.stringify(plan));
  await assert.rejects(
    verifyOrganizationRestore({ jobDirectory, keyFile: f.keyFile }),
    /authentication/,
  );
});
test('unknown scoped table, changed time zone and overlapping destination fail closed', async (t) => {
  const f = await organizationRestoreFixture(t),
    db = f.openPlatform();
  db.db.exec('CREATE TABLE future_org_state(organization_id TEXT,value BLOB)');
  db.db.close();
  await assert.rejects(prepareOrganizationRestore(f.options), /Unclassified/);
  const updated = f.openPlatform();
  updated.db.exec('DROP TABLE future_org_state');
  const row = updated.db
    .prepare('SELECT value FROM organizations WHERE id=?')
    .get(f.owners[0].organizationId);
  updated.db
    .prepare('UPDATE organizations SET value=? WHERE id=?')
    .run(
      updated.seal({ ...updated.open(row.value), timeZone: 'Asia/Yerevan' }),
      f.owners[0].organizationId,
    );
  updated.db.close();
  await assert.rejects(
    prepareOrganizationRestore({ ...f.options, jobDirectory: path.join(f.directory, 'zone-job') }),
    /Time zone/,
  );
  await assert.rejects(
    prepareOrganizationRestore({ ...f.options, jobDirectory: path.join(f.source, 'unsafe-job') }),
    /independent/,
  );
  await assert.rejects(
    prepareOrganizationRestore({
      ...f.options,
      organizationId: '../outside',
      jobDirectory: path.join(f.directory, 'id-job'),
    }),
    /identifier/,
  );
});

test('rollback refuses platform writes but preserves unrelated cabinet writes', async (t) => {
  const f = await organizationRestoreFixture(t),
    prepared = await prepareOrganizationRestore(f.options);
  await applyOrganizationRestore(switchOptions(f, prepared));
  const platform = f.openPlatform();
  const account = platform.db
    .prepare('SELECT value FROM accounts WHERE id=?')
    .get(f.owners[1].accountId);
  platform.db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
    platform.seal({
      ...platform.open(account.value),
      displayName: 'SYNTHETIC POST-RESTORE WRITE',
    }),
    f.owners[1].accountId,
  );
  platform.db.close();
  const changed = fingerprint(f.source);
  assert.throws(() => rollbackOrganizationRestore(switchOptions(f, prepared)), /New data/);
  assert.equal(fingerprint(f.source), changed);
  assert.equal(fs.existsSync(switchMarker(f.source)), false);

  // Return only the synthetic write so the second assertion exercises cabinet-only changes.
  const original = f.openPlatform();
  original.db
    .prepare('UPDATE accounts SET value=? WHERE id=?')
    .run(account.value, f.owners[1].accountId);
  original.db.close();
  const other = createStorage(path.join(f.source, 'tenants', f.owners[1].organizationId));
  const state = other.read();
  state.patients[0].notes = 'UNRELATED POST-RESTORE WRITE';
  other.write(state);
  other.close();
  assert.equal(rollbackOrganizationRestore(switchOptions(f, prepared)).state, 'rolled-back');
  assert.equal(notes(f.source, f.owners[1].organizationId), 'UNRELATED POST-RESTORE WRITE');
  assert.equal(notes(f.source, f.owners[0].organizationId), 'CURRENT PRIVATE NOTE');
});

for (const phase of ['intent', 'cabinet-parked', 'cabinet-returned'])
  test(`interrupted rollback at ${phase} safely resumes from actual component layout`, async (t) => {
    const f = await organizationRestoreFixture(t),
      prepared = await prepareOrganizationRestore(f.options),
      before = fingerprint(f.source);
    await applyOrganizationRestore(switchOptions(f, prepared));
    const previous = f.source + '.before-restore-' + prepared.id;
    atomicJson(
      switchMarker(f.source),
      signDocument(
        {
          format: 1,
          id: prepared.id,
          source: f.source,
          jobDirectory: f.jobDirectory,
          previous,
          phase,
        },
        f.keyFile,
      ),
    );
    const current = path.join(f.source, 'tenants', f.owners[0].organizationId);
    if (phase !== 'intent') {
      fs.renameSync(
        current,
        path.join(f.jobDirectory, 'candidate', 'tenants', f.owners[0].organizationId),
      );
      if (phase === 'cabinet-returned') fs.renameSync(path.join(previous, 'cabinet'), current);
    }
    assert.throws(() => createMultiServer({ dataDir: f.source }), /incomplete/);
    assert.equal(rollbackOrganizationRestore(switchOptions(f, prepared)).state, 'rolled-back');
    assert.equal(fingerprint(f.source), before);
    assert.equal(fs.existsSync(switchMarker(f.source)), false);
  });
