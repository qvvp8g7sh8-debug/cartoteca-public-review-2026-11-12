const { directoryPage, parameters } = require('../../modules/cabinet/directory.cjs');
const { directoryStorage } = require('./read-clinical-views152.cjs');
const { compact, READY_KEY } = require('../cabinet-directory-projection164.cjs');
const { directorySources164, directoryCohortSources189 } = require('./directory-queries164.cjs');
const { snapshotRequest180 } = require('./directory-snapshot-key180.cjs');
const bad = () =>
  Object.assign(Error('Prepared directory projection is invalid.'), {
    status: 503,
    code: 'CABINET_DIRECTORY_INDEX',
  });
async function readDirectory164({
  context,
  operation,
  prepared,
  current,
  url,
  views,
  cacheKey,
  readCacheBudget,
  snapshots180 = null,
}) {
  if (!operation.directory164) return null;
  const audience =
    current.role === 'cosmetologist' ? prepared.hash('staff:' + current.accountId) : '*';
  const logical196 = await require('./read-directory196.cjs').readDirectory196({
    operation,
    prepared,
    current,
    url,
    context,
    cache: snapshots180,
    audience,
  });
  if (logical196 !== null) return logical196;
  // Only the optional complete snapshot path may register the broader full
  // sources. Unsupported/large/unprepared cohorts keep the original164 probe.
  const cohortBound189 =
    snapshots180 &&
    snapshotRequest180(url) &&
    typeof operation.previewDirectoryCohort189 === 'function'
      ? await operation.previewDirectoryCohort189(audience)
      : null;
  const initial = [
    ...(cohortBound189
      ? directoryCohortSources189(operation, audience)
      : directorySources164(operation, audience)),
    {
      scope: operation.scope,
      catalog: operation.cabinetCatalog,
      table: 'meta',
      where: "s.key IN('directory164-ready','revision','initialized')",
      values: [],
    },
    {
      scope: operation.platform,
      catalog: operation.platformCatalog,
      table: 'organizations',
      where: 's.id=$2',
      values: [current.organizationId],
    },
  ];
  const bound = await operation.probe(initial, {
    witness: true,
    captureScopes163: true,
  });
  await prepared.platform.prefetchProjectionAsync(current.organizationId, url.pathname);
  const timeZone = prepared.platform.organizationTimeZone(current.organizationId);
  if (url.searchParams.get('picker') !== '1') parameters(url, timeZone);
  const witness = bound.clinicalWitness;
  const key = 'directory164:' + cacheKey;
  // Full raw fallbacks stay private to this physical RR; the reusable base
  // index contains only compact rows and source proofs.
  const rawFull = new Map();
  let value = views.get(key, witness);
  let created = false;
  let attempted185 = false;
  let cohort189 = null,
    fullRows189 = null;
  if (!value) {
    if (cohortBound189) {
      await operation.requireDirectorySnapshotMemory180();
      cohort189 = await operation.selectDirectoryCohort189(audience);
      fullRows189 = new Map(
        operation.directoryCohortFull189(cohort189).map((row) => [row.id, row]),
      );
    }
    const rows = cohort189
      ? cohort189.rows
      : await operation.selectDirectory164('index', { audience });
    const read = (key, fallback) => {
      const row = rows.find((row) => row.kind === 'meta' && row.id === key);
      return row ? prepared.decode(row.value) : fallback;
    };
    if (!rows.some((row) => row.kind === 'meta' && row.id === READY_KEY)) return null;
    const marker = read(READY_KEY, null);
    if (
      !marker ||
      typeof marker !== 'object' ||
      marker.version !== 1 ||
      Object.keys(marker).length !== 1
    )
      throw bad();
    const revision = read('revision', 0),
      initialized = read('initialized', false);
    if (snapshots180) {
      attempted185 = true;
      const serialized =
        await require('./directory-snapshot-build180.cjs').prepareDirectorySnapshot185({
          operation,
          prepared,
          current,
          url,
          context,
          rows,
          revision,
          audience,
          timeZone,
          cache: snapshots180,
          cohort189,
        });
      if (serialized !== null) {
        operation.assertActive();
        return context.json(context.res, 200, JSON.parse(serialized));
      }
    }
    const directory = [],
      proofs = [];
    for (const row of rows) {
      if (row.kind === 'meta') continue;
      const decoded = prepared.decode(row.value);
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw bad();
      if (row.kind === 'raw') {
        if (decoded.id !== row.id) throw bad();
        const sourceHash = prepared.hash(row.value);
        directory.push(compact(decoded));
        proofs.push([row.id, sourceHash]);
        rawFull.set(row.id, {
          summary: decoded,
          sourceHash,
          bytes: row.value.byteLength,
        });
      } else {
        if (
          decoded.version !== 1 ||
          decoded.id !== row.id ||
          decoded.audience !== audience ||
          decoded.row?.id !== row.id ||
          !/^[a-f0-9]{64}$/.test(decoded.sourceHash) ||
          !Array.isArray(decoded.row.appointments)
        )
          throw bad();
        directory.push(decoded.row);
        proofs.push([row.id, decoded.sourceHash]);
      }
    }
    value = {
      directory,
      proofs,
      revision,
      initialized,
    };
    created = true;
  }
  if (snapshots180 && !attempted185) {
    const serialized =
      await require('./directory-snapshot-build180.cjs').prepareDirectorySnapshot183({
        operation,
        prepared,
        current,
        url,
        context,
        value,
        audience,
        timeZone,
        cache: snapshots180,
      });
    if (serialized !== null) {
      operation.assertActive();
      return context.json(context.res, 200, JSON.parse(serialized));
    }
  }
  // Unsupported/oversize private snapshots retain the existing public path.
  // Successful complete snapshots never retain the duplicate legacy base.
  if (created) views.put(key, witness, value);
  const storage = directoryStorage(
    prepared,
    value,
    operation,
    readCacheBudget,
    '164:' + (witness || operation.snapshot),
  );
  const page = directoryPage(storage, current, url, value, timeZone);
  if (page.directory?.length) {
    const ids = page.directory.map((row) => row.id);
    if (!fullRows189)
      await operation.probe([
        {
          scope: operation.scope,
          catalog: operation.cabinetCatalog,
          table: 'cabinet_summaries',
          where: 's.audience=$2 AND s.patient_id=ANY($3::text[])',
          values: [audience, ids],
        },
      ]);
    const full = new Map(),
      proofs = new Map(value.proofs),
      missing = [];
    const fullKey = (id) =>
      'directory-full165:' +
      JSON.stringify([operation.epoch, operation.scope.storeId, audience, id]);
    const retain = (id, summary, sourceHash, cipherBytes) => {
      const rowKey = fullKey(id);
      // Existing views cap each entry at1MiB. Avoid serializing a known-large
      // full summary just to discover that it cannot be retained.
      if (2 * cipherBytes + 2 * rowKey.length + 512 > 1024 * 1024) return;
      operation.afterCommit165(() => views.put(rowKey, sourceHash, summary));
    };
    for (const id of ids) {
      const proof = proofs.get(id);
      if (!/^[a-f0-9]{64}$/.test(proof || '')) throw bad();
      // A selected fallback still verifies the CURRENT full cipher before a
      // retained decoded row can be reused. Never refetch or decode the rest.
      if (
        fullRows189 &&
        (!fullRows189.has(id) || prepared.hash(fullRows189.get(id).value) !== proof)
      )
        throw bad();
      const raw = rawFull.get(id);
      if (raw) {
        if (raw.sourceHash !== proof || raw.summary.id !== id) throw bad();
        full.set(id, raw.summary);
        retain(id, raw.summary, proof, raw.bytes);
        continue;
      }
      // The selected-source byte probe above is mandatory even for this cache
      // hit: no decoded JSON copy precedes admission for its current full row.
      const cached = views.get(fullKey(id), proof);
      if (cached) {
        if (cached.id !== id) throw bad();
        full.set(id, cached);
      } else missing.push(id);
    }
    if (missing.length) {
      const rows = fullRows189
        ? missing.map((id) => fullRows189.get(id))
        : await operation.selectDirectory164('full', {
            audience,
            ids: missing,
          });
      for (const row of rows) {
        const proof = proofs.get(row.id);
        if (!missing.includes(row.id) || prepared.hash(row.value) !== proof) throw bad();
        const summary = prepared.decode(row.value);
        if (!summary || typeof summary !== 'object' || summary.id !== row.id) throw bad();
        full.set(row.id, summary);
        retain(row.id, summary, proof, row.value.byteLength);
      }
    }
    page.directory = ids.map((id) => {
      if (!full.has(id)) throw bad();
      return full.get(id);
    });
  }
  operation.assertActive();
  return context.json(context.res, 200, page);
}
module.exports = { readDirectory164 };
