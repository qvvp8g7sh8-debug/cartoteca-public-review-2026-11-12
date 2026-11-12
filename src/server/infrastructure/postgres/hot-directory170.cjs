const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { authorityValue } = require('./read-session152.cjs');
const { operationScope } = require('./read-operation-context145.cjs');
const { fullDirectoryKey170, directoryClaimKey170 } = require('./directory-key170.cjs');
const {
  directorySnapshotKey180,
  directorySnapshotClaim180,
} = require('./directory-snapshot-key180.cjs');
const roles170 = new Set(['owner', 'salon_admin', 'cosmetologist']);

async function prepareHotDirectory170({
  url,
  token,
  headers,
  assertActive,
  engine,
  keyCache,
  config,
  epoch,
  cache,
  snapshots180 = null,
}) {
  const claim = directoryClaimKey170({
    epoch,
    platformStoreId: engine.marker.platformStoreId,
    token,
    headers,
    url,
  });
  // The hint exposes neither an old current identity nor a body. No retained
  // clinical reference crosses an await; the final lookup is repeated below.
  const snapshotClaim180 = snapshots180
    ? directorySnapshotClaim180({
        epoch,
        platformStoreId: engine.marker.platformStoreId,
        token,
        headers,
        url,
      })
    : null;
  if (
    (!claim || !cache.hasClaim170(claim)) &&
    (!snapshotClaim180 || !snapshots180.hasClaim180(snapshotClaim180))
  )
    return null;
  if (typeof engine.hotMetadata169 !== 'function') return null;
  const accountId = headers['x-cartoteca-account-id'];
  const organizationId = headers['x-cartoteca-organization-id'];
  const logical196 = await require('./hot-directory196.cjs').prepareLogicalHint196({
    engine,
    snapshots180,
    snapshotClaim180,
    headers,
    keyCache,
    config,
    assertActive,
    url,
  });
  const metadata = await engine.hotMetadata169(
    {
      ...(logical196
        ? {
            directory196: true,
            audience: logical196.hint.audience,
            selectedIds: logical196.hint.proofs.map((row) => row.id),
          }
        : {}),
      claimedAccountId: accountId,
      claimedOrganizationId: organizationId,
      tokenHash: createHash('sha256')
        .update(String(token || ''))
        .digest('hex'),
    },
    assertActive,
  );
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
    roles170.has(row.membership_role) &&
    Number(row.expires_at) > Date.now();
  // This is only a no-body source hint built from the validated SQL row,
  // not accepted current authority. A false hint can only force ordinary RR.
  const keyHint171 = cabinetAssets
    ? fullDirectoryKey170({
        epoch,
        storeId: metadata.scope.storeId,
        current: {
          accountId: row.account_id,
          organizationId: row.organization_id,
          sessionId: row.id,
          role: row.membership_role,
        },
        url,
      })
    : null;
  const bodyCandidate171 =
    cabinetAssets &&
    (typeof cache.hasStamp171 !== 'function' || cache.hasStamp171(keyHint171, metadata.versions));
  const snapshotKeyHint180 = cabinetAssets
    ? directorySnapshotKey180({
        epoch,
        storeId: metadata.scope.storeId,
        current: {
          accountId: row.account_id,
          organizationId: row.organization_id,
          sessionId: row.id,
          role: row.membership_role,
        },
      })
    : null;
  const snapshotCandidate180 =
    cabinetAssets &&
    (snapshots180?.hasStamp180(snapshotKeyHint180, metadata.versions) ||
      !!(logical196 && metadata.directory196));
  let platformCrypto, cabinetCrypto180;
  if (bodyCandidate171 || snapshotCandidate180) {
    const selected = operationScope(engine.marker, organizationId);
    if (selected.unsupported || selected.scope.storeId !== metadata.scope.storeId)
      throw fail(503, 'Подготовленный кабинет недоступен.');
    const checked = await keyCache.forOperation(
      path.resolve(config.dataDir, selected.relativeDirectory),
      assertActive,
    );
    platformCrypto = checked.platform;
    cabinetCrypto180 = checked.cabinet;
    if (logical196) logical196.checked = checked;
  } else platformCrypto = await keyCache.forPlatform(assertActive);
  let used = false;
  return ({ contextMatches, runtime, respondSerialized, acceptColdAuthority171 }) => {
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
    if (!metadata.eligible || !cabinetAssets || !roles170.has(current.role)) return null;
    const cold171 = () => {
      // A private handoff to this same live job replaces its duplicated preauth.
      // It conveys no source versions/crypto or authority to a later job.
      if (typeof acceptColdAuthority171 === 'function') acceptColdAuthority171(current);
      return null;
    };
    if (logical196 && !metadata.directory196) return cold171();
    // No C asset was opened for a definite stamp miss. Never read even a newly
    // published body here: ordinary RR must check P+C before clinical access.
    if (!bodyCandidate171 && !snapshotCandidate180) return cold171();
    const observed = runtime();
    if (logical196 && metadata.directory196) {
      const serialized = require('./hot-directory196.cjs').renderLogical196({
        candidate: logical196,
        metadata,
        snapshots180,
        current,
        epoch,
        url,
      });
      if (serialized !== null) {
        assertActive();
        if (!Number.isSafeInteger(current.expiresAt) || current.expiresAt <= Date.now())
          throw fail(401, 'Войдите в картотеку.');
        return respondSerialized(observed, serialized);
      }
      return cold171();
    }
    const key = fullDirectoryKey170({
      epoch,
      storeId: metadata.scope.storeId,
      current,
      url,
    });
    const cached = bodyCandidate171 ? cache.get(key, metadata.versions) : null;
    if (!cached && snapshotCandidate180) {
      const snapshotKey = directorySnapshotKey180({
        epoch,
        storeId: metadata.scope.storeId,
        current,
      });
      const audience =
        current.role === 'cosmetologist'
          ? cabinetCrypto180.hash('staff:' + current.accountId)
          : '*';
      const serialized = snapshots180.render(snapshotKey, metadata.versions, {
        audience,
        current,
        url,
        cursorCrypto: cabinetCrypto180,
      });
      if (serialized !== null) {
        assertActive();
        if (!Number.isSafeInteger(current.expiresAt) || current.expiresAt <= Date.now())
          throw fail(401, 'Войдите в картотеку.');
        return respondSerialized(observed, serialized);
      }
    }
    if (!cached) return cold171();
    assertActive();
    // Only immutable JSON from a prior accepted, acknowledged owning RR can
    // reach this private serializer. Current headers belong to this request.
    return respondSerialized(observed, cached.json);
  };
}
module.exports = { prepareHotDirectory170 };
