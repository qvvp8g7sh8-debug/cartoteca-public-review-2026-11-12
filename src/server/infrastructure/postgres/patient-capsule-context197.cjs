const path = require('node:path');
const { fail } = require('../../../shared/errors.cjs');
const { authorityValue } = require('./read-session152.cjs');

async function preparePatientOperation197({
  engine,
  scope,
  current,
  url,
  token,
  config,
  relativeDirectory,
  keyCache,
  assertActive,
}) {
  const point = url.pathname === '/api/cabinet/patient';
  if (
    !['/api/cabinet/patient/history', '/api/cabinet/patient/upcoming'].includes(url.pathname) &&
    !(point && url.searchParams.get('view') === 'card') &&
    !(
      point &&
      url.searchParams.get('view') === 'appointment' &&
      url.searchParams.get('details') !== '1'
    )
  )
    return null;
  const catalog = engine.patientCapsuleCatalog197?.(scope);
  if (!catalog) return null;
  assertActive();
  const { prepareUnkeyedPatientSelection198 } = require('./read-patient-capsule197.cjs');
  const unkeyed = prepareUnkeyedPatientSelection198({ url, current, catalog });
  if (unkeyed) {
    assertActive();
    return { selection: unkeyed, current, token };
  }
  const checked = await keyCache.forOperation(
    path.resolve(config.dataDir, relativeDirectory),
    assertActive,
  );
  const selection = require('./read-patient-capsule197.cjs').preparePatientCapsule197({
    url,
    current,
    crypto: checked.cabinet,
    catalog,
  });
  return selection ? { selection, current, token } : null;
}

// Called after fresh P+C asset validation following SQL, before body decode.
// The ordinary post-COMMIT authority check remains a separate acceptance step.
function validatePatientOperation197(operation, prepared, current) {
  const rows = operation.patientCapsuleAuthority197;
  if (!rows) return;
  const authority = authorityValue(rows, prepared.platformDecode197);
  if (!authority.supported) throw fail(403, 'Доступ изменился. Повторите операцию.');
  const fresh = authority.current;
  if (!fresh) throw fail(401, 'Войдите в картотеку.');
  if (
    ['sessionId', 'accountId', 'organizationId', 'role', 'globalAdmin'].some(
      (key) => fresh[key] !== current[key],
    )
  )
    throw fail(403, 'Доступ изменился. Повторите операцию.');
  if (!Number.isSafeInteger(fresh.expiresAt) || fresh.expiresAt <= Date.now())
    throw fail(401, 'Войдите в картотеку.');
}

module.exports = { preparePatientOperation197, validatePatientOperation197 };
