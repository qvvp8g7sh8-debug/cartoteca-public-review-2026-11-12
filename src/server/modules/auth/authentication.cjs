function createAuthentication(context) {
  const { accountByEmail, fail, memberships, normalizeEmail, publicAccount, verifyPassword } =
    context;
  async function authenticate(email, password) {
    const found = accountByEmail(normalizeEmail(email));
    if (
      !found ||
      found.row.status !== 'active' ||
      !(await verifyPassword(found.value, password, found.row.id))
    )
      throw fail(401, 'Неверная почта или пароль.');
    const fresh = accountByEmail(normalizeEmail(email));
    if (
      !fresh ||
      fresh.row.id !== found.row.id ||
      fresh.row.status !== 'active' ||
      fresh.value.passwordHash !== found.value.passwordHash ||
      fresh.value.salt !== found.value.salt
    )
      throw fail(401, 'Неверная почта или пароль.');
    return {
      account: publicAccount(fresh.row),
      memberships: memberships(fresh.row.id),
      credentialProof: require('./admin-mfa-values.cjs').passwordProof(fresh.value),
    };
  }
  return { authenticate };
}
module.exports = { createAuthentication };
