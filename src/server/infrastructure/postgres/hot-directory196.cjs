const path = require('node:path');
const { operationScope } = require('./read-operation-context145.cjs');
const { directorySnapshotKey180 } = require('./directory-snapshot-key180.cjs');
const bad = () =>
  Object.assign(Error('Prepared directory selected source is invalid.'), {
    status: 503,
    code: 'CABINET_DIRECTORY_INDEX',
  });
function samePlatform196(before, after) {
  try {
    const select = (value) => {
      const rows = JSON.parse(value);
      if (!Array.isArray(rows) || rows.length !== 4 || typeof rows[0] !== 'string') return null;
      const platform = rows.slice(1).filter((row) => Array.isArray(row) && row[0] === 'platform');
      return platform.length === 2 ? JSON.stringify([rows[0], ...platform]) : null;
    };
    const a = select(before),
      b = select(after);
    return a !== null && a === b;
  } catch {
    return false;
  }
}
async function prepareLogicalHint196({
  engine,
  snapshots180,
  snapshotClaim180,
  headers,
  keyCache,
  config,
  assertActive,
  url,
}) {
  if (
    !engine.directory196 ||
    !snapshotClaim180 ||
    !snapshots180?.peekForClaim196 ||
    !snapshots180.hasClaim180(snapshotClaim180)
  )
    return null;
  if (!url.searchParams.has('cursor')) {
    const hint = snapshots180.peekForClaim196(snapshotClaim180, { url });
    return hint ? { hint } : null;
  }
  const selected = operationScope(engine.marker, headers['x-cartoteca-organization-id']);
  if (selected.unsupported) return null;
  const checked = await keyCache.forOperation(
    path.resolve(config.dataDir, selected.relativeDirectory),
    assertActive,
  );
  const hint = snapshots180.peekForClaim196(snapshotClaim180, {
    url,
    cursorCrypto: checked.cabinet,
    keyGeneration: checked.cabinet.keyGeneration196,
  });
  return hint ? { hint } : null;
}
function renderLogical196({ candidate, metadata, snapshots180, current, epoch, url }) {
  if (!candidate || !metadata.directory196) return null;
  const { hint, checked } = candidate,
    { head, selected, revisionCipher } = metadata.directory196;
  const key = directorySnapshotKey180({
    epoch,
    storeId: metadata.scope.storeId,
    current,
  });
  if (
    key !== hint.key ||
    !samePlatform196(hint.stamp, metadata.versions) ||
    head.epoch !== hint.head.epoch ||
    head.seq !== hint.head.seq ||
    !['accountId', 'organizationId', 'sessionId', 'role'].every(
      (k) => hint.current[k] === current[k],
    )
  )
    return null;
  const audience =
    current.role === 'cosmetologist' ? checked.cabinet.hash('staff:' + current.accountId) : '*';
  if (hint.audience !== audience) return null;
  const proofs = new Map(hint.proofs.map((row) => [row.id, row.fullHash]));
  if (proofs.size !== selected.length) throw bad();
  for (const row of selected) {
    if (proofs.get(row.id) !== checked.cabinet.hash(row.value)) throw bad();
    proofs.delete(row.id);
  }
  if (proofs.size) throw bad();
  let revision;
  try {
    revision = checked.cabinet.decode(revisionCipher);
  } catch {
    throw bad();
  }
  if (!Number.isSafeInteger(revision) || revision < 0) throw bad();
  return snapshots180.render196(
    key,
    {
      token: hint.token,
      head,
      keyGeneration: checked.cabinet.keyGeneration196,
    },
    {
      audience,
      current,
      url,
      cursorCrypto: checked.cabinet,
      revision,
      expectedSelected196: hint.proofs,
    },
  );
}
module.exports = { samePlatform196, prepareLogicalHint196, renderLogical196 };
