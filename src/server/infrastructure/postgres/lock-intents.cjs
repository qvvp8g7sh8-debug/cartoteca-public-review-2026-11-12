const { createHash } = require('node:crypto');
const { lexReadonly, word, symbol, identifier, split, closing } = require('./dialect-lexer.cjs');
const { assertQueueDomain, queueDomainForTable } = require('./queue-domains.cjs');
const {
  operations,
  compoundOf,
  assertCompoundScope,
  assertCompoundWrite,
} = require('./compound-intent133.cjs');
const {
  gates,
  scopedQueueOf,
  assertScopedQueueScope,
  assertScopedQueueWrite,
} = require('./scoped-queue134.cjs');
const { authOf, assertAuthScope, assertAuthStep } = require('./auth-intent137.cjs');
const {
  accountingOf,
  assertAccountingScope,
  assertAccountingStep,
} = require('./assistant-accounting145.cjs');
const MODES = Object.freeze([
  'DEFERRED',
  'IMMEDIATE',
  'SHARED',
  'QUEUE',
  'READONLY',
  'COMPOUND',
  'QUEUEORG',
  'QUEUEENTITY',
  'AUTH',
  'ACCOUNTING',
]);
const advisoryKey = (value) =>
  createHash('sha256').update(value).digest().readBigInt64BE().toString();
const KEYS = Object.freeze({
  maintenance: advisoryKey('cartoteca:platform-write-fence:v1'),
  policy: advisoryKey('cartoteca:platform-policy-fence:v1'),
  writer: advisoryKey('cartoteca:platform-writer:v1'),
});
const QUEUE_TABLES = new Set([
  'telegram_jobs',
  'staff_notification_jobs',
  'staff_max_jobs',
  'staff_push_jobs',
  'notification_channel_jobs',
  'notification_jobs',
  'notification_schedule',
  'notification_schedule_dirty',
  'notification_schedule_intents',
  'admin_email_jobs',
  'support_deliveries',
  'max_event_inbox',
  'max_runtime_leases',
]);
function denied(code = 'POSTGRES_QUEUE_WRITE_FORBIDDEN') {
  return Object.assign(Error('PostgreSQL transaction intent does not permit this operation.'), {
    code,
  });
}
function intentOf(frames) {
  if (frames.some((frame) => frame.mode === 'READONLY')) return 'READONLY';
  if (frames.some((frame) => frame.mode === 'AUTH')) return 'AUTH';
  if (frames.some((frame) => frame.mode === 'ACCOUNTING')) return 'ACCOUNTING';
  if (frames.some((frame) => frame.mode === 'COMPOUND')) return 'COMPOUND';
  const scoped = frames.find((frame) => ['QUEUEORG', 'QUEUEENTITY'].includes(frame.mode));
  if (scoped) return scoped.mode;
  return frames.some((frame) => frame.mode === 'QUEUE') ? 'QUEUE' : null;
}
function queueDomainOf(frames) {
  return frames.find((frame) => frame.mode === 'QUEUE')?.queueDomain || null;
}
function assertMode(scope, mode, frames = []) {
  if (!MODES.includes(mode)) throw denied('POSTGRES_TRANSACTION_MODE');
  if (
    ['QUEUE', 'COMPOUND', 'QUEUEORG', 'QUEUEENTITY', 'AUTH', 'ACCOUNTING'].includes(mode) &&
    scope.kind !== 'platform'
  )
    throw denied();
  const intent = intentOf(frames);
  if (intent === 'AUTH') throw denied('POSTGRES_AUTH_NESTING');
  if (intent === 'ACCOUNTING') throw denied('POSTGRES_ACCOUNTING_NESTING');
  if (intent === 'READONLY' && !['READONLY', 'DEFERRED'].includes(mode))
    throw denied('POSTGRES_QUERY_ONLY');
  if (intent === 'QUEUE' && mode === 'IMMEDIATE') throw denied();
  if (['QUEUEORG', 'QUEUEENTITY'].includes(intent)) {
    const scoped = scopedQueueOf(frames);
    assertScopedQueueScope(scope, scoped);
    if (scope.kind !== 'cabinet' || !['READONLY', 'DEFERRED'].includes(mode)) throw denied();
  }
  if (intent === 'COMPOUND') {
    assertCompoundScope(scope, compoundOf(frames));
    if (scope.kind === 'platform' || !['IMMEDIATE', 'DEFERRED', 'READONLY'].includes(mode))
      throw denied();
  }
}
function lockPlan(
  scope,
  mode,
  writing = mode === 'IMMEDIATE',
  intent = null,
  queueDomain = null,
  compound = null,
  scopedQueue = null,
  auth = null,
  accounting = null,
) {
  const result = [{ key: KEYS.maintenance, shared: true }];
  if (mode === 'READONLY' || intent === 'READONLY') return result;
  if (auth) {
    assertAuthScope(scope, auth);
    result.push({ key: KEYS.policy, shared: true }, { key: KEYS.writer, shared: true });
    const names = ['account:' + auth.accountId, auth.emailKey, auth.clientKey];
    const keys = [
      ...new Set(
        names.map((name) =>
          advisoryKey('cartoteca:platform-auth:v1:' + auth.platformStoreId + ':' + name),
        ),
      ),
    ].sort();
    for (const key of keys) result.push({ key, shared: false });
    return result;
  }
  if (mode === 'AUTH' || intent === 'AUTH') throw denied('POSTGRES_AUTH_SCOPE_INVALID');
  if (accounting) {
    assertAccountingScope(scope, accounting);
    result.push({ key: KEYS.policy, shared: true }, { key: KEYS.writer, shared: true });
    // Global pilot ceilings and the platform paid wallet share this SMALL domain.
    // It never excludes clinical COMPOUND/queue work or becomes an ACL cache.
    const prefix = 'cartoteca:assistant-accounting:v1:' + accounting.platformStoreId + ':';
    for (const name of [
      'quota',
      'month:' + accounting.month,
      'day:' + accounting.day + ':' + accounting.membershipId,
      ...(accounting.reservationId ? ['reservation:' + accounting.reservationId] : []),
    ])
      result.push({ key: advisoryKey(prefix + name), shared: false });
    return result;
  }
  if (mode === 'ACCOUNTING' || intent === 'ACCOUNTING')
    throw denied('POSTGRES_ACCOUNTING_SCOPE_INVALID');

  if (scopedQueue) {
    assertScopedQueueScope(scope, scopedQueue, writing);
    result.push({ key: KEYS.policy, shared: true }, { key: KEYS.writer, shared: true });
    const domains =
      scopedQueue.type === 'organization' ? gates[scopedQueue.queueDomain] : [scopedQueue.domain];
    for (const domain of domains)
      result.push({
        key: advisoryKey(
          'cartoteca:platform-queue:v1:' + scopedQueue.platformStoreId + ':' + domain,
        ),
        shared: true,
      });
    if (scopedQueue.type === 'organization')
      result.push({
        key: advisoryKey(
          'cartoteca:platform-organization:v1:' +
            scopedQueue.platformStoreId +
            ':' +
            scopedQueue.organizationId,
        ),
        shared: false,
      });
    else {
      const prefix =
        'cartoteca:queue-entity:v1:' + scopedQueue.platformStoreId + ':' + scopedQueue.domain + ':';
      if (scopedQueue.kind === 'event')
        result.push({ key: advisoryKey(prefix + 'bot:' + scopedQueue.botHash), shared: true });
      result.push({
        key: advisoryKey(
          prefix +
            scopedQueue.kind +
            (scopedQueue.kind === 'admission' ? '' : ':' + scopedQueue.key),
        ),
        shared: false,
      });
    }
    if (scope.kind === 'cabinet')
      result.push({ key: advisoryKey('cartoteca:store:cabinet:' + scope.storeId), shared: true });
    return result;
  }
  if (['QUEUEORG', 'QUEUEENTITY'].includes(mode) || ['QUEUEORG', 'QUEUEENTITY'].includes(intent))
    throw denied();
  if (compound) {
    assertCompoundScope(scope, compound);
    result.push({ key: KEYS.policy, shared: true }, { key: KEYS.writer, shared: true });
    for (const domain of operations[compound.operation])
      result.push({
        key: advisoryKey('cartoteca:platform-queue:v1:' + compound.platformStoreId + ':' + domain),
        shared: true,
      });
    result.push({
      key: advisoryKey(
        'cartoteca:platform-organization:v1:' +
          compound.platformStoreId +
          ':' +
          compound.organizationId,
      ),
      shared: false,
    });
    if (compound.cabinetStoreId)
      result.push({
        key: advisoryKey('cartoteca:store:cabinet:' + compound.cabinetStoreId),
        shared: false,
      });
    return result;
  }
  if (mode === 'COMPOUND' || intent === 'COMPOUND') throw denied();
  const platformWrite = scope.kind === 'platform' && writing;
  result.push({
    key: KEYS.policy,
    shared: !platformWrite || mode === 'QUEUE' || intent === 'QUEUE',
  });
  if (queueDomain) {
    assertQueueDomain(queueDomain);
    if (mode !== 'QUEUE' && intent !== 'QUEUE') throw denied();
    if (scope.kind === 'platform') {
      result.push({ key: KEYS.writer, shared: true });
      result.push({
        key: advisoryKey('cartoteca:platform-queue:v1:' + scope.storeId + ':' + queueDomain),
        shared: false,
      });
    } else if (writing) throw denied();
  } else if (platformWrite || mode === 'QUEUE') result.push({ key: KEYS.writer, shared: false });
  if (scope.kind !== 'platform')
    result.push({
      key: advisoryKey('cartoteca:store:' + scope.kind + ':' + scope.storeId),
      shared: !writing,
    });
  return result;
}
function runtimeKeyAllowed(value) {
  return (
    typeof value === 'string' &&
    (value === 'application-process-roles' ||
      /^staff-selftest-v1:(telegram|max):[A-Za-z0-9_-]{1,128}$/.test(value))
  );
}
const name = (token) => {
  const value = identifier(token);
  return token?.type === 'word' ? value.toLowerCase() : value;
};
function peel(tokens) {
  while (symbol(tokens[0], '(') && closing(tokens, 0) === tokens.length - 1)
    tokens = tokens.slice(1, -1);
  return tokens;
}
function scalar(tokens, values) {
  tokens = peel(tokens);
  if (tokens.length !== 1) throw denied();
  if (tokens[0].type === 'bound') return values[tokens[0].value - 1];
  if (tokens[0].type === 'string') return tokens[0].value;
  throw denied();
}
function runtimeWrite(tokens, at, operation, values, queueDomain) {
  const allowed = (key) =>
    runtimeKeyAllowed(key) &&
    (!queueDomain || queueDomainForTable('telegram_runtime', key) === queueDomain);
  const returning = tokens.findIndex((token, i) => i >= at && word(token, 'RETURNING'));
  const body = tokens.slice(at, returning < 0 ? tokens.length : returning);
  if (operation === 'INSERT') {
    if (!symbol(body[0], '(')) throw denied();
    const end = closing(body, 0),
      columns = split(body.slice(1, end), ',');
    if (columns.length !== 2 || columns.some((column) => column.length !== 1)) throw denied();
    const names = columns.map((column) => name(column[0]));
    if (
      new Set(names).size !== 2 ||
      !names.includes('key') ||
      !names.includes('value') ||
      !word(body[end + 1], 'VALUES') ||
      !symbol(body[end + 2], '(')
    )
      throw denied();
    const last = closing(body, end + 2),
      parts = split(body.slice(end + 3, last), ',');
    if (
      last !== body.length - 1 ||
      parts.length !== 2 ||
      !allowed(scalar(parts[names.indexOf('key')], values))
    )
      throw denied();
    return;
  }
  const where = body.findIndex((token) => word(token, 'WHERE'));
  if (where < 0) throw denied();
  if (operation === 'UPDATE') {
    const assignments = body.slice(0, where);
    if (
      !word(assignments[0], 'SET') ||
      name(assignments[1]) !== 'value' ||
      !symbol(assignments[2], '=') ||
      peel(assignments.slice(3)).length !== 1 ||
      peel(assignments.slice(3))[0].type !== 'bound'
    )
      throw denied();
  } else if (where !== 0) throw denied();
  const predicate = peel(body.slice(where + 1));
  if (
    name(predicate[0]) !== 'key' ||
    !symbol(predicate[1], '=') ||
    !allowed(scalar(predicate.slice(2), values))
  )
    throw denied();
}
const syntax = new Set(
  'IN EXISTS VALUES AS NOT CONFLICT SELECT DISTINCT FROM JOIN ON WHERE AND OR WHEN THEN ELSE HAVING BY SET RETURNING UNION ALL FILTER OVER'
    .toLowerCase()
    .split(' '),
);
const builtins = new Set(
  'count sum avg min max coalesce nullif substr substring length trim ltrim rtrim abs round cast least greatest strpos convert_to to_regclass jsonb_to_recordset current_setting'.split(
    ' ',
  ),
);
const compatibility = new Set(
  'ascii_lower ascii_upper json_each json_extract json_valid sqlite_typeof glob_match like_match'.split(
    ' ',
  ),
);
function cteDeclarations(tokens) {
  const declarations = new Set();
  if (!word(tokens[0], 'WITH')) return declarations;
  let at = 1;
  for (;;) {
    if (!identifier(tokens[at])) throw denied();
    const declaration = at++;
    if (symbol(tokens[at], '(')) {
      declarations.add(declaration);
      at = closing(tokens, at) + 1;
    }
    if (!word(tokens[at++], 'AS') || !symbol(tokens[at], '(')) throw denied();
    at = closing(tokens, at) + 1;
    if (!symbol(tokens[at], ',')) return declarations;
    at++;
  }
}
function safeFunctions(tokens, targetEnd = -1) {
  const declarations = cteDeclarations(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const value = name(tokens[i]);
    if (
      !value ||
      !symbol(tokens[i + 1], '(') ||
      i === targetEnd - 1 ||
      declarations.has(i) ||
      word(tokens[i - 1], 'AS')
    )
      continue;
    if (symbol(tokens[i - 1], '.')) {
      const schema = name(tokens[i - 2]);
      if (
        (schema === 'cartoteca_catalog' && compatibility.has(value)) ||
        (schema === 'pg_catalog' && builtins.has(value))
      )
        continue;
      throw denied();
    }
    if (!syntax.has(value) && !builtins.has(value)) throw denied();
  }
}
// Only the text grammar is remembered, weakly tied to the existing bounded
// lexer LRU. Effects, scopes, capabilities and all value-dependent checks stay fresh.
const validatedReadTokens = new WeakSet();
function assertPlanIntent(
  steps,
  scope,
  intent,
  queueDomain = null,
  compound = null,
  catalog = null,
  scopedQueue = null,
  auth = null,
  accounting = null,
) {
  if (!intent) return;
  if (auth) assertAuthScope(scope, auth);
  if (accounting) assertAccountingScope(scope, accounting);
  if (compound) assertCompoundScope(scope, compound);
  if (scopedQueue) assertScopedQueueScope(scope, scopedQueue);
  if (queueDomain) assertQueueDomain(queueDomain);
  for (const step of steps) {
    if (intent === 'AUTH') {
      assertAuthStep(step, scope, auth, catalog);
      continue;
    }
    const source = lexReadonly(step.text);
    if (step.effect === 'read' && validatedReadTokens.has(source)) continue;
    const statements = split(source);
    if (statements.length !== 1) throw denied();
    const tokens = statements[0],
      operation = tokens[0]?.value?.toUpperCase();
    const mutation = tokens.some((token) =>
      [
        'INSERT',
        'UPDATE',
        'DELETE',
        'MERGE',
        'CALL',
        'DO',
        'COPY',
        'CREATE',
        'ALTER',
        'DROP',
        'TRUNCATE',
      ].some((verb) => word(token, verb)),
    );
    if (intent === 'READONLY') {
      if (step.effect !== 'read' || mutation || !['SELECT', 'WITH'].includes(operation))
        throw denied('POSTGRES_QUERY_ONLY');
      safeFunctions(tokens);
      validatedReadTokens.add(source);
      continue;
    }
    if (step.effect === 'read') {
      if (mutation || !['SELECT', 'WITH'].includes(operation)) throw denied();
      safeFunctions(tokens);
      validatedReadTokens.add(source);
      continue;
    }
    if (intent === 'ACCOUNTING') {
      assertAccountingStep(step, scope, accounting, catalog);
      continue;
    }
    if (['QUEUEORG', 'QUEUEENTITY'].includes(intent)) {
      if (scope.kind !== 'platform' || !['INSERT', 'UPDATE', 'DELETE'].includes(operation))
        throw denied();
      const target = operation === 'UPDATE' ? 1 : 2;
      if (
        name(tokens[target]) !== 'cartoteca_platform' ||
        !symbol(tokens[target + 1], '.') ||
        !Object.hasOwn(catalog?.tables || {}, name(tokens[target + 2]))
      )
        throw denied();
      safeFunctions(tokens, target + 3);
      assertScopedQueueWrite(step, scope, scopedQueue, catalog);
      continue;
    }
    if (intent === 'COMPOUND') {
      if (!['INSERT', 'UPDATE', 'DELETE'].includes(operation)) throw denied();
      const target = operation === 'UPDATE' ? 1 : 2;
      if (
        name(tokens[target]) !== 'cartoteca_' + scope.kind ||
        !symbol(tokens[target + 1], '.') ||
        !Object.hasOwn(catalog?.tables || {}, name(tokens[target + 2]))
      )
        throw denied();
      safeFunctions(tokens, target + 3);
      assertCompoundWrite(step, scope, compound, catalog);
      continue;
    }
    if (scope.kind !== 'platform' || !['INSERT', 'UPDATE', 'DELETE'].includes(operation))
      throw denied();
    let at = operation === 'INSERT' ? 2 : operation === 'DELETE' ? 2 : 1;
    if (
      (operation === 'INSERT' && !word(tokens[1], 'INTO')) ||
      (operation === 'DELETE' && !word(tokens[1], 'FROM'))
    )
      throw denied();
    if (name(tokens[at]) !== 'cartoteca_platform' || !symbol(tokens[at + 1], '.')) throw denied();
    const table = name(tokens[at + 2]);
    at += 3;
    if (!QUEUE_TABLES.has(table) && table !== 'telegram_runtime') throw denied();
    if (queueDomain && table !== 'telegram_runtime' && queueDomainForTable(table) !== queueDomain)
      throw denied();
    const tail = tokens.slice(at);
    if (
      tail.some(
        (token, index) =>
          ['INSERT', 'DELETE', 'MERGE', 'CALL', 'COPY', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'].some(
            (verb) => word(token, verb),
          ) ||
          (word(token, 'UPDATE') && !word(tail[index - 1], 'DO')) ||
          (word(token, 'DO') &&
            !word(tail[index + 1], 'UPDATE') &&
            !word(tail[index + 1], 'NOTHING')),
      )
    )
      throw denied();
    safeFunctions(tokens, at);
    if (table === 'telegram_runtime') runtimeWrite(tokens, at, operation, step.values, queueDomain);
  }
}
module.exports = {
  MODES,
  KEYS,
  advisoryKey,
  intentOf,
  queueDomainOf,
  compoundOf,
  scopedQueueOf,
  authOf,
  accountingOf,
  assertMode,
  lockPlan,
  runtimeKeyAllowed,
  assertPlanIntent,
};
