function createPasswords(context) {
  const { crypto, passwordOptions, passwordRule, scrypt } = context;
  async function passwordFields(password, credentialId) {
    passwordRule(password);
    const salt = crypto.randomBytes(16).toString('hex');
    return {
      salt,
      passwordHash: (await scrypt(password, salt, 64, passwordOptions, credentialId)).toString(
        'hex',
      ),
    };
  }
  async function verifyPassword(account, password, credentialId) {
    if (typeof password !== 'string' || password.length > 128) return false;
    const derived = await scrypt(password, account.salt, 64, passwordOptions, credentialId);
    return crypto.timingSafeEqual(derived, Buffer.from(account.passwordHash, 'hex'));
  }
  return { passwordFields, verifyPassword };
}
module.exports = { createPasswords };
