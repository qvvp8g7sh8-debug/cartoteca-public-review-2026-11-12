const capabilities = Object.freeze([
  'organizations.read',
  'organizations.profile',
  'organizations.access',
  'subscriptions.manage',
  'accounts.read',
  'accounts.access',
  'accounts.recover',
  'accounts.sessions',
  'support.read',
  'support.manage',
  'audit.read',
  'system.read',
]);

function createAdminPolicy({ db, fail }) {
  function assert(actorId, capability) {
    if (typeof actorId !== 'string') throw fail(403, 'Недостаточно платформенных полномочий.');
    const row = db
      .prepare("SELECT global_admin FROM accounts WHERE id=? AND status='active'")
      .get(actorId);
    if (!capabilities.includes(capability) || !row?.global_admin)
      throw fail(403, 'Недостаточно платформенных полномочий.');
    return row;
  }
  function targetAccount(accountId) {
    if (typeof accountId !== 'string' || !accountId) throw fail(400, 'Выберите пользователя.');
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
    if (!row) throw fail(404, 'Пользователь не найден.');
    if (row.global_admin)
      throw fail(403, 'Системную учётную запись нельзя менять через восстановление доступа.');
    return row;
  }
  return { assert, targetAccount, capabilities };
}
module.exports = { createAdminPolicy, capabilities };
