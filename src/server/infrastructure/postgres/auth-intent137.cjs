// Closed capability for successful ordinary PG3 login.
'use strict';
const { lex } = require('./dialect-lexer.cjs');
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hex = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const denied = (code = 'POSTGRES_AUTH_FORBIDDEN') =>
  Object.assign(Error('PostgreSQL ordinary login capability refused.'), { code });
function authScope(input, platform) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !['accountId', 'organizationId', 'emailHash', 'clientKey'].includes(k),
    ) ||
    !uuid(input.accountId) ||
    !uuid(input.organizationId) ||
    !hex(input.emailHash) ||
    typeof input.clientKey !== 'string' ||
    !/^client:[a-f0-9]{64}$/.test(input.clientKey) ||
    platform?.kind !== 'platform' ||
    !uuid(platform.storeId)
  )
    throw denied('POSTGRES_AUTH_SCOPE_INVALID');
  return Object.freeze({
    operation: 'ordinary-login',
    platformStoreId: platform.storeId,
    accountId: input.accountId,
    organizationId: input.organizationId,
    emailHash: input.emailHash,
    emailKey: 'email:' + input.emailHash,
    clientKey: input.clientKey,
  });
}
const authOf = (frames) => frames.find((f) => f.mode === 'AUTH')?.auth || null;
function assertAuthScope(scope, capability) {
  if (capability && (scope?.kind !== 'platform' || scope.storeId !== capability.platformStoreId))
    throw denied('POSTGRES_AUTH_SCOPE_INVALID');
}
const shape = (sql) =>
  JSON.stringify(
    lex(sql)
      .filter((t) => !(t.type === 'symbol' && t.value === ';'))
      .map((t) => [t.type, t.type === 'word' ? t.value.toLowerCase() : t.value]),
  );
const rules = Object.freeze([
  Object.freeze({
    sql: 'SELECT failures,window_started,blocked_until FROM login_limits WHERE key=?',
    method: 'get',
    effect: 'read',
    check: (a, c) => a[0] === c.emailKey || a[0] === c.clientKey,
  }),
  Object.freeze({
    sql: "SELECT * FROM accounts WHERE id=? AND status='active'",
    method: 'get',
    effect: 'read',
    check: (a, c) => a[0] === c.accountId,
  }),
  Object.freeze({
    sql: `SELECT m.organization_id,m.role,m.status,o.slug,o.value
      FROM memberships m JOIN organizations o ON o.id=m.organization_id
      WHERE m.account_id=? AND m.status='active' AND o.status='active'
      ORDER BY m.created_at`,
    method: 'all',
    effect: 'read',
    check: (a, c) => a[0] === c.accountId,
  }),
  Object.freeze({
    sql: 'DELETE FROM login_limits WHERE key=?',
    method: 'run',
    effect: 'write',
    check: (a, c) => a[0] === c.emailKey || a[0] === c.clientKey,
  }),
  Object.freeze({
    sql: 'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)',
    method: 'run',
    effect: 'write',
    check: (a, c) =>
      hex(a[0]) &&
      uuid(a[1]) &&
      a[2] === c.accountId &&
      a[3] === c.organizationId &&
      Buffer.isBuffer(a[4]) &&
      a[4].length <= 4096 &&
      Number.isSafeInteger(a[5]) &&
      a[5] > 0,
  }),
  Object.freeze({
    sql: 'INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,?,?)',
    method: 'run',
    effect: 'write',
    check: (a, c) =>
      Number.isSafeInteger(a[0]) &&
      a[0] > 0 &&
      a[1] === c.accountId &&
      a[2] === c.organizationId &&
      a[3] === 'login_succeeded' &&
      a[4] === '{}',
  }),
]);
const caches = new WeakMap();
function templates(catalog, scope) {
  let scopes = caches.get(catalog);
  if (!scopes) {
    scopes = new Map();
    caches.set(catalog, scopes);
  }
  if (scopes.has(scope.storeId)) return scopes.get(scope.storeId);
  const { compile } = require('./dialect.cjs'),
    result = [];
  for (const rule of rules) {
    const count = lex(rule.sql).filter((t) => t.type === 'parameter').length;
    const args = Array.from({ length: count }, (_, i) => '__auth137_arg_' + i + '__');
    const plan = compile(rule.sql, scope, args, rule.method, catalog),
      steps = plan.steps || [plan];
    if (steps.length !== 1 || steps[0].effect !== rule.effect) throw denied();
    result.push({ rule, args, expected: steps[0].values, shape: shape(steps[0].text) });
  }
  scopes.set(scope.storeId, result);
  return result;
}
function assertAuthStep(step, scope, capability, catalog) {
  assertAuthScope(scope, capability);
  if (!capability || !['read', 'write'].includes(step.effect)) throw denied();
  const wanted = shape(step.text);
  for (const item of templates(catalog, scope)) {
    if (
      item.rule.effect !== step.effect ||
      item.shape !== wanted ||
      item.expected.length !== step.values.length
    )
      continue;
    const args = new Array(item.args.length),
      seen = new Set();
    let valid = true;
    for (let i = 0; i < item.expected.length; i++) {
      const n = item.args.indexOf(item.expected[i]),
        value = step.values[i];
      if (n < 0) {
        if (value !== item.expected[i]) {
          valid = false;
          break;
        }
      } else if (seen.has(n)) {
        if (value !== args[n]) {
          valid = false;
          break;
        }
      } else {
        args[n] = value;
        seen.add(n);
      }
    }
    if (valid && seen.size === args.length && item.rule.check(args, capability)) return;
  }
  throw denied();
}
function admissionPlans(capability, scope, catalog) {
  const { compile } = require('./dialect.cjs');
  return [
    compile(
      "SELECT a.id FROM accounts a JOIN admin_directory_records d ON d.kind='account' AND d.resource_id=a.id AND d.source_value=a.value WHERE a.id=? AND a.email_hash=? AND a.global_admin=0 AND a.status='active'",
      scope,
      [capability.accountId, capability.emailHash],
      'all',
      catalog,
    ),
    compile(
      "SELECT m.organization_id,CASE WHEN d.source_value=o.value THEN 1 ELSE 0 END AS projection_ready FROM memberships m JOIN organizations o ON o.id=m.organization_id LEFT JOIN admin_directory_records d ON d.kind='organization' AND d.resource_id=o.id WHERE m.account_id=? AND m.status='active' AND o.status='active'",
      scope,
      [capability.accountId],
      'all',
      catalog,
    ),
  ].map((p) => {
    if (p.steps || p.effect !== 'read') throw denied();
    return p;
  });
}
module.exports = { authScope, authOf, assertAuthScope, assertAuthStep, admissionPlans };
