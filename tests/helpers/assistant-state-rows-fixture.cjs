const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../../src/server/application/platform.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const { createAssistantStore } = require('../../src/server/modules/assistant/access/store.cjs');
const { createBackupKey } = require('../../src/server/infrastructure/backup/service.cjs');
const { assistantContext } = require('../../src/server/infrastructure/backup/assistant-state.cjs');
const { readKey } = require('../../src/server/infrastructure/backup/snapshot.cjs');
const {
  createAssistantRowStore,
} = require('../../src/server/modules/assistant/access/row-store.cjs');
function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
function openRows(directory) {
  const platformDirectory = path.join(directory, 'platform');
  const db = new DatabaseSync(path.join(platformDirectory, 'platform.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  const context = assistantContext(
    db,
    readKey(path.join(platformDirectory, 'platform.key')),
    platformDirectory,
  );
  context.asyncTransaction = async (callback) => transaction(db, callback);
  return {
    db,
    context,
    repository: createAssistantRowStore(context, { directory: platformDirectory }),
    close: () => db.close(),
  };
}
function seedLegacy(directory, owner) {
  const platformDirectory = path.join(directory, 'platform'),
    db = new DatabaseSync(path.join(platformDirectory, 'platform.sqlite'));
  try {
    const context = assistantContext(
      db,
      readKey(path.join(platformDirectory, 'platform.key')),
      platformDirectory,
    );
    const membership = db
      .prepare('SELECT created_at FROM memberships WHERE organization_id=? AND account_id=?')
      .get(owner.organizationId, owner.accountId);
    const membershipId = crypto
      .createHash('sha256')
      .update(JSON.stringify([owner.organizationId, owner.accountId, membership.created_at]))
      .digest('base64url');
    const now = Date.now(),
      date = new Date(now).toISOString().slice(0, 10),
      month = date.slice(0, 7);
    const store = createAssistantStore(context);
    transaction(db, () =>
      store.update((state) => {
        state.revision = 7;
        state.policy.mode = 'selected';
        state.credentials.timeweb = 'synthetic-rows-key-never-sent';
        state.grants = [
          { organizationId: owner.organizationId, accountId: owner.accountId, membershipId },
        ];
        state.usage[month] = { spentRub: 4, calls: 2, uncertainCalls: 1 };
        state.daily[date + ':' + membershipId] = 3;
        state.reservations['imported-reservation'] = {
          month,
          amount: 1.25,
          kind: 'llm',
          createdAt: now - 121000,
        };
      }),
    );
    return { initial: store.read(), membershipId, date, month, owner };
  } finally {
    db.close();
  }
}
async function fixture(t, version = 19) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-assistant-rows-synthetic-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cartoteca-assistant-rows-synthetic-/);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const source = path.join(root, 'source'),
    platformDirectory = path.join(source, 'platform');
  createStorage(source).close();
  const platform = createPlatformStore(platformDirectory);
  let owner;
  try {
    owner = await platform.registerOwner({
      email: 'rows@example.test',
      password: 'Synthetic-rows-password',
      displayName: 'Synthetic',
      organizationName: 'Synthetic',
    });
  } finally {
    platform.close();
  }
  const database = createPlatformDatabase(platformDirectory);
  try {
    for (const [file, method] of [
      ['012-max-connections', 'migrateMaxConnections'],
      ['013-notification-queue', 'migrateNotificationQueue'],
      ['014-notification-channels', 'migrateNotificationChannels'],
      ['015-max-inbox', 'migrateMaxInbox'],
      ['016-staff-max', 'migrateStaffMax'],
      ['017-staff-push', 'migrateStaffPush'],
      ['018-notification-schedule', 'migrateNotificationSchedule'],
      ['019-paid-services', 'migratePaidServices'],
    ])
      require('../../src/server/migrations/' + file + '.cjs')[method](database, platformDirectory);
    if (version === 20)
      require('../../src/server/migrations/020-multi-service-billing.cjs').migrateMultiServiceBilling(
        database,
        platformDirectory,
        { offline: true },
      );
  } finally {
    database.closeWriter();
    database.db.close();
  }
  const seeded = seedLegacy(source, owner),
    keyFile = path.join(root, 'keys', 'backup.key');
  createBackupKey(keyFile);
  return {
    root,
    source,
    platformDirectory,
    version,
    keyFile,
    directory: path.join(root, 'archives'),
    destination: path.join(root, 'prepared'),
    ...seeded,
  };
}
async function addCurrentReservation(f, directory) {
  const opened = openRows(directory);
  try {
    const { repository, context } = opened;
    const current = { organizationId: f.owner.organizationId, accountId: f.owner.accountId };
    const assertScope = () => ({
      state: repository.readPolicy(),
      scope: { limits: repository.readPolicy().policy.limits },
      member: { ...current, membershipId: f.membershipId },
    });
    const reservation = await repository.reservePilot({
      current,
      revision: repository.readPolicy().revision,
      kind: 'llm',
      amount: 2.5,
      provider: 'demo',
      pricing: {},
      assertScope,
    });
    await repository.markOutbound(reservation, assertScope);
    transaction(context.db, () =>
      repository.updateAdmin((state) => {
        state.revision++;
        state.policy.dictionary = 'Новый словарь после подготовки';
      }),
    );
    return { reservation, state: repository.exportLegacyState() };
  } finally {
    opened.close();
  }
}
function financial(directory) {
  const db = new DatabaseSync(path.join(directory, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'billing_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all()]);
  } finally {
    db.close();
  }
}
module.exports = { fixture, openRows, seedLegacy, addCurrentReservation, financial, transaction };
