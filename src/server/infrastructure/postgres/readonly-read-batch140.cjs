// Opaque prepared reads; SQL compilation and intent guards stay with callers.
const { ArrayBuffer } = globalThis;
const v8 = require('node:v8');
const { createHash } = require('node:crypto');
const { lexReadonly, identifier } = require('./dialect-lexer.cjs');
// A text-only identifier fact, not a cached session or permission decision.
// Its weak keys live no longer than the bounded lexer entries.
const sessionFreeTokens = new WeakSet();
const MAX_READS = 32,
  MAX_ROWS = 20000,
  MAX_BYTES = 8 * 1024 * 1024;
function fault(code = 'POSTGRES_READ_BATCH_INVALID') {
  return Object.assign(Error('Prepared response reads are unavailable.'), { code, status: 503 });
}
const clone = (value) => v8.deserialize(v8.serialize(value));
function context(scope, catalog, frames, profile, lineage) {
  const top = frames.at(-1);
  if (
    profile !== 3 ||
    !lineage ||
    !frames.length ||
    frames.some((f) => f.mode !== 'READONLY') ||
    !['platform', 'cabinet'].includes(scope?.kind) ||
    top?.scope?.kind !== scope.kind ||
    top.scope.storeId !== scope.storeId ||
    (top.scope.organizationId || null) !== (scope.organizationId || null) ||
    !(scope.kind === 'platform' ? [19, 20] : [1, 2]).includes(catalog?.version)
  )
    throw fault('POSTGRES_READ_BATCH_SCOPE');
}
function read(value) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'method,plan' ||
    !['get', 'all'].includes(value.method) ||
    !value.plan ||
    value.plan.effect !== 'read' ||
    typeof value.plan.text !== 'string' ||
    !Array.isArray(value.plan.values) ||
    value.plan.steps ||
    value.plan.control
  )
    throw fault();
  // Fresh session observations are deliberately never enrollable in a prefetch map.
  const tokens = lexReadonly(value.plan.text);
  if (!sessionFreeTokens.has(tokens)) {
    if (tokens.some((t) => identifier(t)?.toLowerCase() === 'platform_sessions'))
      throw fault('POSTGRES_READ_BATCH_AUTHORITY');
    sessionFreeTokens.add(tokens);
  }
  return value;
}
function reads(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_READS) throw fault();
  value.forEach(read);
  if (v8.serialize(value).byteLength > 1024 * 1024) throw fault('POSTGRES_READ_BATCH_CAPACITY');
  return value;
}
function parameter(value, depth = 0) {
  if (depth > 32) throw fault('POSTGRES_READ_BATCH_CAPACITY');
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (ArrayBuffer.isView(value))
    return [
      'bytes',
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    ];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (Array.isArray(value))
    return ['array', Array.from(value, (item) => parameter(item, depth + 1))];
  if (value && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    // Preserve object property order: PostgreSQL can bind its JSON text to TEXT.
    return ['object', Object.keys(value).map((name) => [name, parameter(value[name], depth + 1)])];
  throw fault();
}
function key(scope, value) {
  read(value);
  // V8 serialization is a transport format, not a canonical value encoding:
  // equal packed/deserialized arrays may produce different bytes.
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.kind,
        scope.storeId,
        scope.organizationId || null,
        value.method,
        value.plan.text,
        Array.from(value.plan.values, (item) => parameter(item)),
        value.plan.columns || [],
      ]),
    )
    .digest('hex');
}
function keyOrNull(scope, value) {
  try {
    return key(scope, value);
  } catch {
    return null;
  }
}
function replies(value, expected) {
  if (!Array.isArray(value) || value.length !== expected) throw fault();
  let rows = 0,
    bytes = 0;
  for (const result of value) {
    if (
      !result ||
      Object.keys(result).sort().join(',') !== 'fields,rowCount,rows' ||
      !Array.isArray(result.rows) ||
      !Array.isArray(result.fields) ||
      !Number.isSafeInteger(result.rowCount) ||
      result.rowCount < 0 ||
      result.fields.some(
        (f) =>
          typeof f.name !== 'string' || !Number.isSafeInteger(f.dataTypeID) || f.dataTypeID < 0,
      )
    )
      throw fault();
    rows += result.rows.length;
    bytes += v8.serialize(result).byteLength;
    if (rows > MAX_ROWS || bytes > MAX_BYTES) throw fault('POSTGRES_READ_BATCH_CAPACITY');
  }
  return { rows, bytes };
}
module.exports = {
  MAX_READS,
  MAX_ROWS,
  MAX_BYTES,
  fault,
  clone,
  context,
  read,
  reads,
  key,
  keyOrNull,
  replies,
};
