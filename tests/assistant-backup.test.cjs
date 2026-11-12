const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createAssistantStore, stateName } = require('../src/server/modules/assistant/access/store.cjs');
const { createV2Backup, verifyV2Backup, restoreV2Backup, recoverUpgradeCopy, createBackupKey } =
  require('../src/server/infrastructure/backup/service.cjs');
const { dataInventory, componentFingerprint } =
  require('../src/server/infrastructure/backup/organization-inventory.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-assistant-backup-'));
  t.after(() => {
    if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('cartoteca-assistant-backup-'))
      fs.rmSync(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, 'source'), platformDirectory = path.join(source, 'platform');
  createPlatformStore(platformDirectory).close();
  const db = createPlatformDatabase(platformDirectory);
  try {
    const store = createAssistantStore({ directory: platformDirectory, seal: db.seal, open: db.open });
    db.transaction(() => store.update((state) => {
      state.revision = 7;
      state.policy.mode = 'selected';
      state.credentials.timeweb = 'synthetic-never-live-key';
      state.grants = [{ organizationId: 'synthetic-org', accountId: 'synthetic-account', membershipId: 's'.repeat(43), enabled: true }];
      state.usage['2026-10'] = { spentRub: 4, calls: 1, uncertainCalls: 0 };
    }));
  } finally { db.db.close(); }
  const keyFile = path.join(dir, 'keys', 'backup.key');
  createBackupKey(keyFile);
  return { dir, source, platformDirectory, keyFile,
    options: { source, directory: path.join(dir, 'archives'), keyFile } };
}
function readState(directory) {
  const platformDirectory = path.join(directory, 'platform');
  const db = createPlatformDatabase(platformDirectory);
  try { return createAssistantStore({ directory: platformDirectory, seal: db.seal, open: db.open }).read(); }
  finally { db.db.close(); }
}

test('assistant encrypted configuration survives upgrade copy; disaster recovery revokes pilot and provider credentials', async (t) => {
  const f = fixture(t), backup = await createV2Backup(f.options);
  await verifyV2Backup(backup.file, f.keyFile);
  const copy = path.join(f.dir, 'upgrade');
  await recoverUpgradeCopy(backup.file, f.keyFile, copy);
  const current = readState(copy);
  assert.equal(current.revision, 7);
  assert.equal(current.policy.mode, 'selected');
  assert.equal(current.grants.length, 1);
  assert.equal(current.credentials.timeweb, 'synthetic-never-live-key');
  assert.deepEqual(fs.readFileSync(path.join(copy, 'platform', stateName)),
    fs.readFileSync(path.join(f.platformDirectory, stateName)));
  assert.ok(dataInventory(copy).some((entry) => entry.name === 'platform/' + stateName));
  const before = componentFingerprint(path.join(copy, 'platform'), 'platform');
  const recovered = path.join(f.dir, 'restored');
  await restoreV2Backup(backup.file, f.keyFile, recovered);
  const disabled = readState(recovered);
  assert.equal(disabled.revision, 8);
  assert.equal(disabled.policy.mode, 'off');
  assert.deepEqual(disabled.grants, []);
  assert.deepEqual(disabled.credentials, {});
  assert.deepEqual(disabled.operations, []);
  assert.deepEqual(disabled.reservations, {});
  assert.deepEqual(disabled.usage, current.usage);
  assert.notEqual(componentFingerprint(path.join(recovered, 'platform'), 'platform'), before);
});

test('backup refuses damaged assistant ciphertext instead of silently omitting the settings', async (t) => {
  const f = fixture(t), filename = path.join(f.platformDirectory, stateName);
  const bytes = fs.readFileSync(filename);
  bytes[30] ^= 1;
  fs.writeFileSync(filename, bytes);
  await assert.rejects(createV2Backup(f.options));
});
