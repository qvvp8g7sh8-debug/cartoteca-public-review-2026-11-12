const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');

const password = 'Synthetic-platform-password-2026';
async function adminFixture(t, { extraAccounts = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-admin-'));
  const platformDirectory = path.join(directory, 'platform');
  let store = createPlatformStore(platformDirectory), database;
  const cleanups = [];
  const owner = await store.registerOwner({ email: 'owner@admin.test', password, displayName: 'Анна Тестовая',
    organizationName: 'Тестовая студия', city: 'Казань', phone: '+7 918 123-45-67' });
  store.verifyEmail(owner.verificationToken);
  const other = await store.registerOwner({ email: 'other@admin.test', password, displayName: 'Мария Другая',
    organizationName: 'Другая организация', city: 'Самара' });
  store.verifyEmail(other.verificationToken);
  const admin = await store.bootstrapGlobalAdmin({ email: 'root@admin.test', password, displayName: 'Оператор Тестовый' });
  database = createPlatformDatabase(platformDirectory);
  if (extraAccounts) {
    const template = database.open(database.db.prepare('SELECT value FROM accounts WHERE id=?').get(owner.accountId).value);
    for (let index = 0; index < extraAccounts; index++) {
      const accountId = database.id(), email = `extra-${index}@admin.test`;
      database.db.prepare('INSERT INTO accounts VALUES(?,?,?,0,?,?)').run(accountId,
        database.emailHash(email), database.seal({ ...template, email, displayName: 'Дополнительный ' + index }), 'active', 1000000 + index);
    }
    store.close(); database.db.close();
    store = createPlatformStore(platformDirectory); database = createPlatformDatabase(platformDirectory);
  }
  const ownerSession = await store.login('owner@admin.test', password);
  const adminSession = await store.login('root@admin.test', password);
  let closed = false;
  const fixture = {
    directory, platformDirectory, owner, other, admin, password, ownerSession, adminSession,
    get store() { return store; }, get database() { return database; },
    cleanup(fn) { cleanups.push(fn); },
    reopen() {
      store.close(); database.db.close();
      store = createPlatformStore(platformDirectory); database = createPlatformDatabase(platformDirectory);
    },
    command(kind, targetId, changes = {}) {
      const target = kind === 'organization' || kind === 'subscription' ? 'organizationId' : kind === 'support' ? 'caseId' : 'accountId';
      return { requestId: database.id(), expectedRevision: database.db.prepare(
        'SELECT revision FROM admin_resource_versions WHERE kind=? AND resource_id=?').get(kind, targetId)?.revision || 0,
        [target]: targetId, reason: 'Синтетическая проверка оператора', ...changes };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const cleanup of cleanups.reverse()) await cleanup();
      store.close(); database.db.close();
      if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cartoteca-admin-'))
        throw Error('Unsafe synthetic fixture cleanup');
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
  t?.after(() => fixture.close());
  return fixture;
}
module.exports = { adminFixture, password };
