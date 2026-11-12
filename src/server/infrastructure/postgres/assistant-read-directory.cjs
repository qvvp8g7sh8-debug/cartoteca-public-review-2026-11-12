const { setImmediate: yieldLoop } = require('node:timers/promises');
const { fail } = require('../../../shared/errors.cjs');
const {
  patientSearchText,
  normalizePatientSearchQuery,
} = require('../../../shared/patient-names.cjs');
const { directorySources164 } = require('./directory-queries164.cjs');
const { compact, READY_KEY } = require('../cabinet-directory-projection164.cjs');
const bad = () => fail(503, 'Подготовленный поиск клиентов недоступен.');
function audienceOf(prepared, current) {
  return current.role === 'cosmetologist' ? prepared.hash('staff:' + current.accountId) : '*';
}
function validateIds(ids, maximum = 100) {
  if (
    !Array.isArray(ids) ||
    ids.length > maximum ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !id || id.length > 120)
  )
    throw fail(400, 'Укажите корректные карточки клиентов.');
}
async function assistantSummaries(env, ids, expected = null) {
  const { operation, prepared, current, summaryCache } = env;
  validateIds(ids);
  if (!ids.length) return [];
  const audience = audienceOf(prepared, current);
  const missing = ids.filter((id) => !summaryCache?.has(id));
  const values = new Map(
    ids.filter((id) => summaryCache?.has(id)).map((id) => [id, summaryCache.get(id)]),
  );
  if (missing.length) {
    await operation.probe([
      {
        scope: operation.scope,
        catalog: operation.cabinetCatalog,
        table: 'cabinet_summaries',
        where: 's.audience=$2 AND s.patient_id=ANY($3::text[])',
        values: [audience, missing],
      },
    ]);
    const rows = await operation.selectDirectory164('full', { audience, ids: missing });
    for (const row of rows) {
      const value = prepared.decode(row.value);
      if (value?.id !== row.id || !missing.includes(row.id) || values.has(row.id)) throw bad();
      const result = {
        value,
        sourceHash: prepared.hash(row.value),
        text: patientSearchText(compact(value)),
      };
      values.set(row.id, result);
      const bytes = 384 + row.value.byteLength * 4;
      if (
        summaryCache &&
        summaryCache.size < 400 &&
        env.summaryCacheBytes + bytes <= 2 * 1024 * 1024
      ) {
        summaryCache.set(row.id, result);
        env.summaryCacheBytes += bytes;
      }
    }
  }
  operation.assertActive();
  for (const [id, result] of values) {
    const proof = expected?.get(id);
    if (
      expected &&
      (!proof || proof.sourceHash !== result.sourceHash || proof.text !== result.text)
    )
      throw bad();
  }
  return ids.flatMap((id) => (values.has(id) ? [structuredClone(values.get(id).value)] : []));
}
async function assistantDirectory(env, { query, limit, families, predicate }) {
  const { operation, prepared, current, cache } = env;
  if (
    typeof query !== 'string' ||
    query.length > 160 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw fail(400, 'Неверные параметры поиска клиентов.');
  if (
    families &&
    (!Array.isArray(families) ||
      families.length > 3 ||
      families.some(
        (family) =>
          !Array.isArray(family) ||
          !family.length ||
          family.length > 24 ||
          family.some((part) => typeof part !== 'string' || !part || part.length > 160),
      ))
  )
    throw fail(400, 'Неверные варианты поиска клиентов.');
  const audience = audienceOf(prepared, current);
  const sources = [
    ...directorySources164(operation, audience),
    {
      scope: operation.scope,
      catalog: operation.cabinetCatalog,
      table: 'meta',
      where: "s.key IN('directory164-ready','revision','initialized')",
      values: [],
    },
  ];
  const key = JSON.stringify([
    operation.epoch,
    operation.scope.storeId,
    audience,
    prepared.keyGeneration196,
  ]);
  let entry = env.directoryEntry;
  if (!entry) {
    const bound = await operation.probe(sources, { witness: true });
    if (bound.rows > 50003) throw fail(503, 'Слишком большой поисковый индекс.');
    entry = cache.get(key);
    if (!entry || !bound.clinicalWitness || entry.witness !== bound.clinicalWitness) {
      const records = await operation.selectDirectory164('index', { audience });
      const rows = [];
      let ready = false,
        bytes = 0;
      for (let index = 0; index < records.length; index++) {
        if (index % 128 === 0) {
          await yieldLoop();
          operation.assertActive();
        }
        const record = records[index];
        const value = prepared.decode(record.value);
        if (record.kind === 'meta') {
          if (record.id === READY_KEY)
            ready = value?.version === 1 && Object.keys(value).length === 1;
          continue;
        }
        const row = record.kind === 'raw' ? compact(value) : value?.row;
        if (
          row?.id !== record.id ||
          (record.kind !== 'raw' &&
            (value.version !== 1 ||
              value.audience !== audience ||
              !/^[a-f0-9]{64}$/.test(value.sourceHash)))
        )
          throw bad();
        const text = patientSearchText(row);
        rows.push({
          id: row.id,
          text,
          sourceHash: record.kind === 'raw' ? prepared.hash(record.value) : value.sourceHash,
        });
        bytes += 384 + 2 * (row.id.length + text.length);
      }
      if (!ready) throw bad();
      entry = { witness: bound.clinicalWitness, rows, bytes };
      // Keep compact lexical strings, never whole-directory JSON or clinical profiles.
      // One owner has a hard total cache ceiling; cold decoding yields every 128 rows.
      cache.delete(key);
      if (bytes <= 2 * 1024 * 1024) {
        let used = [...cache.values()].reduce((sum, value) => sum + value.bytes, 0);
        while (used + bytes > 2 * 1024 * 1024 && cache.size) {
          const oldest = cache.keys().next().value;
          used -= cache.get(oldest).bytes;
          cache.delete(oldest);
        }
        cache.set(key, entry);
      }
    }
    env.directoryEntry = entry;
  }
  const terms = normalizePatientSearchQuery(query).split(/\s+/u).filter(Boolean);
  const ids = [];
  const selectedProofs = new Map();
  let matched = 0;
  for (let index = 0; index < entry.rows.length; index++) {
    if (index % 512 === 0) {
      await yieldLoop();
      operation.assertActive();
    }
    const row = entry.rows[index];
    if (
      !(families
        ? families.every((family) => family.some((part) => row.text.includes(part)))
        : terms.every((part) => row.text.includes(part)))
    )
      continue;
    matched++;
    if (ids.length < (predicate ? 100 : limit)) {
      ids.push(row.id);
      selectedProofs.set(row.id, row);
    }
  }
  if (predicate && matched > 100) return { directory: [], matched };
  let directory = await assistantSummaries(env, ids, selectedProofs);
  if (predicate) {
    directory = directory.filter(predicate);
    matched = directory.length;
  }
  operation.assertActive();
  return { directory: directory.slice(0, limit), matched };
}
module.exports = { assistantDirectory, assistantSummaries, validateIds };
