const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { uuid169 } = require('./hot-metadata-component169.cjs');
const { authorityValue } = require('./read-session152.cjs');
const { operationScope } = require('./read-operation-context145.cjs');
const { calendarToken163 } = require('./calendar-token163.cjs');
const roles169 = new Set(['owner', 'salon_admin', 'cosmetologist']);

// Classification cannot raise calendar-plan errors before fresh authority.
function hotCalendarCandidate169(url, headers) {
  const version = url.searchParams.get('version');
  return (
    url.pathname === '/api/cabinet/calendar' &&
    url.searchParams.get('compact') === '1' &&
    typeof version === 'string' &&
    version.length <= 2048 &&
    /^c163\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(version) &&
    uuid169(headers['x-cartoteca-account-id']) &&
    uuid169(headers['x-cartoteca-organization-id'])
  );
}

async function prepareHotCalendar169({
  url,
  token,
  headers,
  assertActive,
  engine,
  keyCache,
  config,
}) {
  if (!hotCalendarCandidate169(url, headers) || typeof engine.hotMetadata169 !== 'function')
    return null;
  const accountId = headers['x-cartoteca-account-id'];
  const organizationId = headers['x-cartoteca-organization-id'];
  const metadata = await engine.hotMetadata169(
    {
      claimedAccountId: accountId,
      claimedOrganizationId: organizationId,
      tokenHash: createHash('sha256')
        .update(String(token || ''))
        .digest('hex'),
    },
    assertActive,
  );
  // The old cold path handles explicitly unsupported metadata, including large
  // authority rows and session selection; this never catches database errors.
  if (!metadata.authorityRows) return null;
  const row = metadata.authorityRows[0];
  const cabinetAssets =
    metadata.eligible &&
    row.account_id === accountId &&
    row.organization_id === organizationId &&
    Number(row.global_admin) === 0 &&
    row.account_status === 'active' &&
    row.membership_status === 'active' &&
    row.organization_status === 'active' &&
    roles169.has(row.membership_role) &&
    Number(row.expires_at) > Date.now();
  let platformCrypto, cabinetCrypto;
  if (cabinetAssets) {
    const selected = operationScope(engine.marker, organizationId);
    if (selected.unsupported || selected.scope.storeId !== metadata.scope.storeId)
      throw fail(503, 'Подготовленный кабинет недоступен.');
    const crypto = await keyCache.forOperation(
      path.resolve(config.dataDir, selected.relativeDirectory),
      assertActive,
    );
    platformCrypto = crypto.platform;
    cabinetCrypto = crypto.cabinet;
  } else platformCrypto = await keyCache.forPlatform(assertActive);
  let used = false;
  // This closure is private to the live borrowed job, never retained in a cache.
  return ({ contextMatches, runtime, respond, acceptColdAuthority171 }) => {
    if (used) throw fail(503, 'Проверка чтения уже завершена.');
    used = true;
    assertActive();
    const authority = authorityValue(metadata.authorityRows, platformCrypto.decode);
    if (!authority.supported) return null;
    const current = authority.current;
    if (!current) throw fail(401, 'Войдите в картотеку.');
    contextMatches(current);
    if (current.globalAdmin)
      throw fail(403, 'Главному администратору недоступны данные картотеки.');
    if (!current.organizationId) throw fail(403, 'Выберите кабинет.');
    if (!metadata.eligible || !cabinetCrypto || !roles169.has(current.role)) return null;
    const observed = runtime();
    const fingerprint = calendarToken163({
      current,
      url,
      hash: cabinetCrypto.hash,
      versions: metadata.versions,
      runtime: [observed.telegram, ...['telegram', 'max'].map((c) => observed.providers[c])],
      renderConfig: [
        config.commonNotificationsEnabled === true,
        config.notificationChannels || null,
      ],
    });
    const value = fingerprint?.read();
    if (!value) {
      if (typeof acceptColdAuthority171 === 'function') acceptColdAuthority171(current);
      return null;
    }
    assertActive();
    return respond(observed, value);
  };
}
module.exports = { hotCalendarCandidate169, prepareHotCalendar169 };
