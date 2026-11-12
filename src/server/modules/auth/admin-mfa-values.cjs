const OTPAuth = require('otpauth');
const crypto = require('node:crypto');
const STEP = 30000;
const passwordProof = (value) =>
  crypto
    .createHash('sha256')
    .update(value.salt + '\0' + value.passwordHash)
    .digest('hex');
function totp(secret, label = 'Administrator') {
  return new OTPAuth.TOTP({
    issuer: 'Картотека',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
}
function consume(mfa, code, accountId, now = Date.now()) {
  if (typeof code !== 'string' || code.length > 64) return null;
  const token = code.replace(/[ -]/g, '');
  if (/^\d{6}$/.test(token)) {
    const delta = totp(mfa.secret).validate({ token, window: 1, timestamp: now });
    const counter = Math.floor(now / STEP) + (delta ?? 0);
    return delta !== null && counter > (mfa.lastCounter ?? -1)
      ? { ...mfa, lastCounter: counter }
      : null;
  }
  const digest = recoveryHash(accountId, token.toLowerCase());
  const index = (mfa.recoveryHashes || []).indexOf(digest);
  return /^[a-fA-F0-9]{20}$/.test(token) && index >= 0
    ? { ...mfa, recoveryHashes: mfa.recoveryHashes.filter((_, i) => i !== index) }
    : null;
}
function recoveryHash(accountId, code) {
  return crypto
    .createHash('sha256')
    .update('admin-mfa-recovery:' + accountId + ':' + code)
    .digest('hex');
}
function recoveryCodes(accountId) {
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(10).toString('hex'));
  return {
    codes: codes.map((code) => code.match(/.{1,5}/g).join('-')),
    hashes: codes.map((code) => recoveryHash(accountId, code)),
  };
}
module.exports = { totp, consume, passwordProof, recoveryCodes };
