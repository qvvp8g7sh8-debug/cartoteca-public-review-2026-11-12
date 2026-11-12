'use strict';
const { lex } = require('./dialect-lexer.cjs');
const gates = Object.freeze({
  telegram: Object.freeze(['telegram']),
  'staff-telegram': Object.freeze(['staff-telegram']),
  'staff-max': Object.freeze(['staff-max']),
  push: Object.freeze(['push']),
  client: Object.freeze(['client']),
  schedule: Object.freeze(['client', 'push', 'telegram']),
});
const uuid = (v) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const bot = (v) => typeof v === 'string' && /^max-inbox-bot:[a-f0-9]{64}$/.test(v);
const denied = (code = 'POSTGRES_SCOPED_QUEUE_FORBIDDEN') =>
  Object.assign(Error('PostgreSQL scoped queue capability does not permit this operation.'), {
    code,
    status: 503,
  });
function organizationQueueScope(input, platform) {
  if (
    !input ||
    Object.keys(input).some((k) => !['queueDomain', 'organizationId'].includes(k)) ||
    !Object.hasOwn(gates, input.queueDomain) ||
    !uuid(input.organizationId) ||
    platform?.kind !== 'platform' ||
    !uuid(platform.storeId)
  )
    throw denied('POSTGRES_SCOPED_QUEUE_INVALID');
  return Object.freeze({
    type: 'organization',
    queueDomain: input.queueDomain,
    organizationId: input.organizationId,
    platformStoreId: platform.storeId,
  });
}
function entityQueueScope(input, platform) {
  const marker = input?.kind === 'marker';
  const validMarker =
    marker &&
    ['staff-telegram', 'staff-max'].includes(input.domain) &&
    typeof input.key === 'string' &&
    new RegExp(
      '^staff-selftest-v1:' +
        (input.domain === 'staff-max' ? 'max' : 'telegram') +
        ':[A-Za-z0-9_-]{1,128}$',
    ).test(input.key);
  if (
    !input ||
    (marker
      ? !validMarker
      : input.domain !== 'max-inbox' || !['bot', 'event', 'admission'].includes(input.kind)) ||
    Object.keys(input).some(
      (k) => !['domain', 'kind', 'key', ...(input.kind === 'event' ? ['botHash'] : [])].includes(k),
    ) ||
    (!marker &&
      (input.kind === 'event' ? !uuid(input.key) || !bot(input.botHash) : !bot(input.key))) ||
    platform?.kind !== 'platform' ||
    !uuid(platform.storeId)
  )
    throw denied('POSTGRES_SCOPED_QUEUE_INVALID');
  return Object.freeze({
    type: 'entity',
    domain: input.domain,
    kind: input.kind,
    key: input.key,
    ...(input.kind === 'event' ? { botHash: input.botHash } : {}),
    platformStoreId: platform.storeId,
  });
}

function scopedQueueOf(frames) {
  return frames.find((f) => ['QUEUEORG', 'QUEUEENTITY'].includes(f.mode))?.scopedQueue || null;
}
function assertScopedQueueScope(scope, capability, writing = false) {
  if (!capability) return;
  if (scope?.kind === 'platform' && scope.storeId === capability.platformStoreId) return;
  if (
    !writing &&
    capability.type === 'organization' &&
    scope?.kind === 'cabinet' &&
    scope.organizationId === capability.organizationId
  )
    return;
  throw denied('POSTGRES_SCOPED_QUEUE_SCOPE_INVALID');
}
const cache = new WeakMap();
const shape = (sql) =>
  JSON.stringify(
    lex(sql)
      .filter((t) => !(t.type === 'symbol' && t.value === ';'))
      .map((t) => [t.type, t.type === 'word' ? t.value.toLowerCase() : t.value]),
  );
function templates(catalog, scope, capability, arity) {
  if (!catalog || typeof catalog !== 'object') throw denied();
  let byType = cache.get(catalog);
  if (!byType) {
    byType = new Map();
    cache.set(catalog, byType);
  }
  const discriminator =
    capability.type === 'organization'
      ? capability.queueDomain
      : capability.domain + ':' + capability.kind;
  const cacheKey = capability.type + ':' + scope.storeId + ':' + discriminator + ':' + arity;
  if (byType.has(cacheKey)) return byType.get(cacheKey);
  let entries;
  if (capability.type === 'organization') {
    const root = require('./queue-org-maintenance-sql134.cjs');
    const org = require('./queue-org-sql134.cjs');
    entries = [
      ...org,
      ...(typeof org.candidates === 'function' ? org.candidates(arity) : []),
      ...(Array.isArray(root) ? root : []),
      ...(typeof root.candidates === 'function' ? root.candidates(arity) : []),
    ];
  } else
    entries =
      capability.kind === 'marker'
        ? require('./queue-marker-sql134.cjs')
        : require('./queue-entity-sql134.cjs');
  const result = [],
    { compile } = require('./dialect.cjs');
  for (const entry of entries) {
    if (
      capability.type === 'organization'
        ? !entry.domains.includes(capability.queueDomain)
        : !entry.kinds.includes(capability.kind) ||
          (entry.domains && !entry.domains.includes(capability.domain))
    )
      continue;
    const count = lex(entry.sql).filter((t) => t.type === 'parameter').length;
    if (count !== arity) continue;
    if (
      capability.type === 'entity' &&
      ((entry.kinds.some((kind) => kind !== 'admission') && !entry.key?.length) ||
        (entry.kinds.includes('event') && !entry.bot?.length))
    )
      throw denied();
    const args = Array.from({ length: count }, (_, i) => '__scoped_queue_arg_' + i + '__');
    let plan;
    try {
      plan = compile(entry.sql, scope, args, 'run', catalog);
    } catch (error) {
      if (error.code === 'POSTGRES_SQL_UNSUPPORTED') continue;
      throw error;
    }
    const steps = plan.steps || [plan];
    if (!steps.length || steps.length > 128 || steps.some((s) => s.effect !== 'write'))
      throw denied();
    for (const step of steps)
      result.push({ ...entry, shape: shape(step.text), expected: step.values, args });
  }
  byType.set(cacheKey, result);
  return result;
}

function assertScopedQueueWrite(step, scope, capability, catalog) {
  assertScopedQueueScope(scope, capability, true);
  const wanted = shape(step.text);
  for (const entry of templates(catalog, scope, capability, step.values.length)) {
    if (
      entry.shape !== wanted ||
      step.values.length !== entry.expected.length ||
      (capability.type === 'organization'
        ? !entry.domains.includes(capability.queueDomain)
        : !entry.kinds.includes(capability.kind))
    )
      continue;
    const valid = entry.expected.every((value, i) => {
      const n = entry.args.indexOf(value) + 1;
      if (!n) return step.values[i] === value;
      if (capability.type === 'organization')
        return !entry.org.includes(n) || step.values[i] === capability.organizationId;
      return (
        (!(entry.key || []).includes(n) || step.values[i] === capability.key) &&
        (!(entry.bot || []).includes(n) || step.values[i] === capability.botHash)
      );
    });
    if (valid) return;
  }
  throw denied();
}
module.exports = {
  gates,
  organizationQueueScope,
  entityQueueScope,
  scopedQueueOf,
  assertScopedQueueScope,
  assertScopedQueueWrite,
};
