function createAccounts(context) {
  const { db, emailHash, open } = context;
  function publicAccount(row) {
    const value = open(row.value);
    return {
      id: row.id,
      email: value.email,
      displayName: value.displayName,
      globalAdmin: Boolean(row.global_admin),
      status: row.status,
    };
  }
  function accountByEmail(email) {
    const row = db.prepare('SELECT * FROM accounts WHERE email_hash=?').get(emailHash(email));
    return row ? { row, value: open(row.value) } : null;
  }
  return { publicAccount, accountByEmail };
}
module.exports = { createAccounts };
