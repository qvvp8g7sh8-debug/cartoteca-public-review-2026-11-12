const { fail } = require('./errors.cjs');
const PRIVACY_VERSION = '2026-10-06.1';

function privacyConsent(values, purpose, now = Date.now()) {
  if (values?.privacyConsent !== true)
    throw fail(400, 'Дайте согласие на обработку персональных данных.');
  if (values.privacyConsentVersion !== PRIVACY_VERSION)
    throw fail(409, 'Документы обновились. Обновите страницу и ознакомьтесь с согласием.');
  return { granted: true, version: PRIVACY_VERSION, purpose, at: now };
}

module.exports = { PRIVACY_VERSION, privacyConsent };
