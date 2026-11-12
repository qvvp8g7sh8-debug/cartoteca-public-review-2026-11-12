'use strict';
const { lex } = require('./dialect-lexer.cjs');
const operations = Object.freeze({
  cabinet: Object.freeze(['push', 'telegram']),
  intent: Object.freeze([]),
  booking: Object.freeze(['client', 'push', 'staff-max', 'staff-telegram', 'telegram']),
  journal: Object.freeze(['client', 'push', 'staff-max', 'staff-telegram', 'telegram']),
  confirmation: Object.freeze(['client', 'push', 'staff-max', 'staff-telegram', 'telegram']),
});
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const denied = (code = 'POSTGRES_COMPOUND_FORBIDDEN') =>
  Object.assign(Error('PostgreSQL compound scope does not permit this operation.'), { code });
function compoundScope(input, platform) {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some(
      (key) => !['operation', 'organizationId', 'cabinetStoreId'].includes(key),
    ) ||
    !Object.hasOwn(operations, input.operation) ||
    !uuid(input.organizationId) ||
    platform?.kind !== 'platform' ||
    !uuid(platform.storeId) ||
    (input.operation === 'intent' ? input.cabinetStoreId !== null : !uuid(input.cabinetStoreId))
  )
    throw denied('POSTGRES_COMPOUND_SCOPE_INVALID');
  return Object.freeze({
    operation: input.operation,
    organizationId: input.organizationId,
    cabinetStoreId: input.cabinetStoreId,
    platformStoreId: platform.storeId,
  });
}
function compoundOf(frames) {
  return frames.find((frame) => frame.mode === 'COMPOUND')?.compound || null;
}
function assertCompoundScope(scope, compound) {
  if (!compound) return;
  if (scope?.kind === 'platform' && scope.storeId === compound.platformStoreId) return;
  if (
    scope?.kind === 'cabinet' &&
    compound.operation !== 'intent' &&
    scope.storeId === compound.cabinetStoreId &&
    (!scope.organizationId || scope.organizationId === compound.organizationId)
  )
    return;
  throw denied('POSTGRES_COMPOUND_SCOPE_INVALID');
}
const shapes = new WeakMap();
function shape(sql) {
  return JSON.stringify(
    lex(sql)
      .filter((t) => !(t.type === 'symbol' && t.value === ';'))
      .map((t) => [t.type, t.type === 'word' ? t.value.toLowerCase() : t.value]),
  );
}
function templates(catalog, scope) {
  if (!catalog || typeof catalog !== 'object') throw denied();
  let cache = shapes.get(catalog);
  if (!cache) {
    cache = new Map();
    shapes.set(catalog, cache);
  }
  const cacheKey = scope.storeId;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const result = [];
  const { compile } = require('./dialect.cjs');
  for (const entry of require('./compound-sql133.cjs')) {
    const count = lex(entry.sql).filter((t) => t.type === 'parameter').length;
    const args = Array.from({ length: count }, (_, i) => '__compound_arg_' + i + '__');
    let plan;
    try {
      plan = compile(entry.sql, scope, args, 'run', catalog);
    } catch (error) {
      if (error.code === 'POSTGRES_SQL_UNSUPPORTED') continue;
      throw error;
    }
    const steps = plan.steps || [plan];
    if (!steps.length || steps.length > 128 || steps.some((step) => step.effect !== 'write'))
      throw denied();
    for (const step of steps)
      result.push({
        shape: shape(step.text),
        expected: step.values,
        args,
        org: entry.org,
        operations: entry.operations,
      });
  }
  cache.set(cacheKey, result);
  return result;
}
function assertCompoundWrite(step, scope, compound, catalog) {
  assertCompoundScope(scope, compound);
  if (scope.kind === 'cabinet') return;
  if (scope.kind !== 'platform' || step.effect !== 'write') throw denied();
  const wanted = shape(step.text);
  for (const entry of templates(catalog, scope)) {
    if (
      entry.shape !== wanted ||
      !entry.operations.includes(compound.operation) ||
      step.values.length !== entry.expected.length
    )
      continue;
    const valid = entry.expected.every((value, i) => {
      const argument = entry.args.indexOf(value);
      return argument < 0
        ? step.values[i] === value
        : !entry.org.includes(argument + 1) || step.values[i] === compound.organizationId;
    });
    if (valid) return;
  }
  throw denied();
}
module.exports = {
  operations,
  compoundScope,
  compoundOf,
  assertCompoundScope,
  assertCompoundWrite,
};
