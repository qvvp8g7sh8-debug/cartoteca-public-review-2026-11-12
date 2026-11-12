const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../shared/errors.cjs');
const READY_KEY = 'directory164-ready';
function projectionKey(id, audience) {
  if (typeof id !== 'string' || typeof audience !== 'string')
    throw fail(503, 'Некорректная проекция поиска клиентов.');
  return 'directory164:' + createHash('sha256').update(id, 'utf8').digest('hex') + ':' + audience;
}
// Search, locale order and date filters need contact text and unique active dates,
// never appointment details, clinical history, photos or the patient profile.
function compact(summary) {
  const row = Object.fromEntries(
    ['id', 'name', 'firstName', 'lastName', 'middleName', 'designation', 'phone', 'visitCount']
      .filter((key) => summary[key] !== undefined)
      .map((key) => [key, summary[key]]),
  );
  row.lastVisit = summary.lastVisit ? { date: summary.lastVisit.date } : null;
  row.appointments = [...new Set((summary.appointments || []).map((value) => value.date))]
    .sort()
    .map((date) => ({ date }));
  return row;
}
function encodeProjection(summary, audience, summaryCipher, { encode, hash }) {
  return encode({
    version: 1,
    id: summary.id,
    audience,
    sourceHash: hash(summaryCipher),
    row: compact(summary),
  });
}
// Readiness belongs to this verified store/connection lifetime. Preparation and
// inverse are offline operations; this factory never prepares an existing store.
function createDirectoryProjectionWriter164({
  prepare,
  encode,
  decode,
  hash,
  logicalState196 = null,
}) {
  let ready = false;
  if ([prepare, encode, decode, hash].every((value) => typeof value === 'function')) {
    const row = prepare('SELECT value FROM meta WHERE key=?').get(READY_KEY);
    if (row) {
      let marker;
      try {
        marker = decode(row.value);
      } catch {
        throw fail(503, 'Подготовленная проекция поиска клиентов повреждена.');
      }
      if (!marker || marker.version !== 1 || Object.keys(marker).length !== 1)
        throw fail(503, 'Подготовленная проекция поиска клиентов недоступна.');
      ready = true;
    }
  }
  function statement(summary, audience, summaryCipher) {
    if (!ready) return null;
    return {
      sql: 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      args: [
        projectionKey(summary.id, audience),
        encodeProjection(summary, audience, summaryCipher, { encode, hash }),
      ],
    };
  }
  const logical196 = Boolean(
    ready &&
    logicalState196?.version === 1 &&
    /^[a-f0-9-]{36}$/.test(logicalState196.epoch || '') &&
    /^[a-f0-9]{64}$/.test(logicalState196.digest || ''),
  );
  function unchanged196(summary, audience, summaryCipher) {
    if (!logical196 || !Buffer.isBuffer(summaryCipher)) return false;
    let prior;
    try {
      prior = decode(summaryCipher);
    } catch {
      throw fail(503, 'Подготовленная сводка клиента повреждена.');
    }
    if (
      !prior ||
      typeof prior !== 'object' ||
      Array.isArray(prior) ||
      prior.id !== summary.id ||
      !Number.isSafeInteger(prior.visitCount) ||
      prior.visitCount < 0 ||
      !Array.isArray(prior.appointments)
    )
      throw fail(503, 'Подготовленная сводка клиента повреждена.');
    if (!isDeepStrictEqual(prior, summary)) return false;
    // A no-op must authenticate the CURRENT pair. Missing/large/stale valid
    // sidecars use the ordinary atomic repair; malformed AES fails closed.
    const row = prepare(
      'SELECT CASE WHEN length(value)<=2097152 THEN value ELSE NULL END AS value FROM meta WHERE key=?',
    ).get(projectionKey(summary.id, audience));
    if (!row?.value) return false;
    let projection;
    try {
      projection = decode(row.value);
    } catch {
      throw fail(503, 'Подготовленная проекция поиска клиентов повреждена.');
    }
    return isDeepStrictEqual(projection, {
      version: 1,
      id: summary.id,
      audience,
      sourceHash: hash(summaryCipher),
      row: compact(prior),
    });
  }
  return {
    ready,
    logical196,
    unchanged196,
    statement,
    write(summary, audience, summaryCipher) {
      const next = statement(summary, audience, summaryCipher);
      if (next) prepare(next.sql).run(...next.args);
    },
  };
}
module.exports = {
  READY_KEY,
  projectionKey,
  compact,
  encodeProjection,
  createDirectoryProjectionWriter164,
};
