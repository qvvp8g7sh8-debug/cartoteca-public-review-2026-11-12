// Closed PG3 accounting capability. No settings, grants, clinical or credit writes.
'use strict';
const { lex } = require('./dialect-lexer.cjs');
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const key = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f]/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const blob = (v) => v instanceof Uint8Array && v.byteLength >= 29 && v.byteLength <= 4 * 1024 ** 2;
const denied = (code = 'POSTGRES_ACCOUNTING_FORBIDDEN') =>
  Object.assign(Error('PostgreSQL assistant accounting capability refused.'), { code });
function accountingScope(input, platform) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          'operation',
          'ledger',
          'organizationId',
          'accountId',
          'membershipId',
          'month',
          'day',
          'reservationId',
        ].includes(k),
    ) ||
    !['reserve', 'outbound', 'settle'].includes(input.operation) ||
    !['pilot', 'wallet'].includes(input.ledger) ||
    !uuid(input.organizationId) ||
    !uuid(input.accountId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.membershipId || '') ||
    !/^\d{4}-\d{2}$/.test(input.month || '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.day || '') ||
    !input.day.startsWith(input.month + '-') ||
    (input.operation === 'reserve' ? input.reservationId !== null : !key(input.reservationId)) ||
    platform?.kind !== 'platform' ||
    !uuid(platform.storeId)
  )
    throw denied('POSTGRES_ACCOUNTING_SCOPE_INVALID');
  return Object.freeze({ ...input, platformStoreId: platform.storeId });
}
const accountingOf = (frames) => frames.find((f) => f.mode === 'ACCOUNTING')?.accounting || null;
function assertAccountingScope(scope, capability) {
  if (capability && (scope?.kind !== 'platform' || scope.storeId !== capability.platformStoreId))
    throw denied('POSTGRES_ACCOUNTING_SCOPE_INVALID');
}
const shape = (sql) =>
  JSON.stringify(
    lex(sql)
      .filter((t) => !(t.type === 'symbol' && t.value === ';'))
      .map((t) => [t.type, t.type === 'word' ? t.value.toLowerCase() : t.value]),
  );
const month = (v) => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
const reserve = (c) => c.operation === 'reserve';
const idAllowed = (v, c) => (reserve(c) ? key(v) : v === c.reservationId);
const walletAllowed = (v, c) => v === 'platform' || v === 'org:' + c.organizationId;
const rules = [
  [
    'INSERT INTO assistant_usage_months VALUES(?,0,0,0,0,?) ON CONFLICT(month) DO NOTHING',
    (a, c) => reserve(c) && a[0] === c.month && blob(a[1]),
  ],
  [
    'UPDATE assistant_usage_months SET spent_microrub=?,reserved_microrub=?,calls=?,uncertain_calls=? WHERE month=?',
    (a, c) =>
      c.operation !== 'outbound' &&
      a.slice(0, 4).every(integer) &&
      month(a[4]) &&
      (reserve(c) || a[4] === c.month),
  ],
  [
    'DELETE FROM assistant_reservations WHERE id=?',
    (a, c) => c.operation !== 'outbound' && idAllowed(a[0], c),
  ],
  ['DELETE FROM assistant_usage_days WHERE day<?', (a, c) => reserve(c) && a[0] === c.day],
  ['DELETE FROM assistant_usage_days WHERE day>?', (a, c) => reserve(c) && a[0] === c.day],
  [
    'UPDATE assistant_usage_months SET reserved_microrub=? WHERE month=?',
    (a, c) => reserve(c) && integer(a[0]) && a[1] === c.month,
  ],
  [
    'INSERT INTO assistant_usage_days VALUES(?,?,?) ON CONFLICT(day,membership_id) DO UPDATE SET requests=excluded.requests',
    (a, c) => reserve(c) && a[0] === c.day && a[1] === c.membershipId && integer(a[2]),
  ],
  [
    "INSERT INTO assistant_reservations VALUES(?,'actor',?,?,?,?,?,?,?, ?,?,'reserved',?,?,?)",
    (a, c) =>
      reserve(c) &&
      uuid(a[0]) &&
      a[1] === c.organizationId &&
      a[2] === c.accountId &&
      a[3] === c.membershipId &&
      integer(a[4]) &&
      integer(a[5]) &&
      ['stt', 'llm', 'tts'].includes(a[6]) &&
      key(a[7]) &&
      a[8] === c.month &&
      a.slice(9, 12).every(integer) &&
      blob(a[12]),
  ],
  [
    "UPDATE assistant_reservations SET state='outbound' WHERE id=? AND state='reserved'",
    (a, c) => c.operation === 'outbound' && a[0] === c.reservationId,
  ],
  [
    'INSERT INTO billing_wallets(id,organization_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING',
    (a, c) =>
      c.operation !== 'outbound' &&
      ((a[0] === 'platform' && a[1] === null) ||
        (a[0] === 'org:' + c.organizationId && a[1] === c.organizationId)),
  ],
  [
    'UPDATE billing_wallets SET balance_microrub=?,reserved_microrub=?,provider_cost_microrub=?,charged_microrub=?,unpaid_charge_microrub=?,revision=revision+1,changed_at=? WHERE id=?',
    (a, c) =>
      c.operation !== 'outbound' &&
      Number.isSafeInteger(a[0]) &&
      a.slice(1, 6).every(integer) &&
      walletAllowed(a[6], c),
  ],
  [
    "INSERT INTO billing_reservations(id,organization_id,account_id,service,kind,provider,state,provider_quote_microrub,charge_quote_microrub,markup_bps,created_at,value,package_covered) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?)",
    (a, c) =>
      reserve(c) &&
      uuid(a[0]) &&
      a[1] === c.organizationId &&
      a[2] === c.accountId &&
      a[3] === 'voice-assistant' &&
      ['stt', 'llm', 'tts'].includes(a[4]) &&
      key(a[5]) &&
      a.slice(6, 10).every(integer) &&
      blob(a[10]) &&
      a[11] === 1,
  ],
  [
    "UPDATE billing_reservations SET state=?,provider_actual_microrub=?,charged_microrub=?,retail_microrub=?,unpaid_charge_microrub=?,estimated=?,uncertain=?,settled_at=?,value=? WHERE id=? AND state='pending'",
    (a, c) =>
      c.operation === 'settle' &&
      ['released', 'settled'].includes(a[0]) &&
      a.slice(1, 8).every(integer) &&
      blob(a[8]) &&
      a[9] === c.reservationId,
  ],
  [
    "UPDATE billing_reservations SET value=? WHERE id=? AND state='pending'",
    (a, c) => c.operation === 'outbound' && blob(a[0]) && a[1] === c.reservationId,
  ],
  [
    'INSERT INTO billing_entries(id,wallet_id,organization_id,reservation_id,kind,service,amount_microrub,balance_after_microrub,actor_id,idempotency_key,fingerprint,created_at,value) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    (a, c) =>
      c.operation === 'settle' &&
      uuid(a[0]) &&
      walletAllowed(a[1], c) &&
      a[2] === c.organizationId &&
      a[3] === c.reservationId &&
      a[4] === 'expense' &&
      a[5] === 'voice-assistant' &&
      Number.isSafeInteger(a[6]) &&
      Number.isSafeInteger(a[7]) &&
      a[8] === null &&
      a[9] === 'reservation:' + c.reservationId &&
      /^[a-f0-9]{64}$/.test(a[10]) &&
      integer(a[11]) &&
      blob(a[12]),
  ],
];
const caches = new WeakMap();
function templates(catalog, scope) {
  let scopes = caches.get(catalog);
  if (!scopes) {
    scopes = new Map();
    caches.set(catalog, scopes);
  }
  let result = scopes.get(scope.storeId);
  if (result) return result;
  const { compile } = require('./dialect.cjs');
  result = rules.map(([sql, check]) => {
    const args = Array.from(
      { length: lex(sql).filter((t) => t.type === 'parameter').length },
      (_, i) => '__accounting145_' + i + '__',
    );
    const p = compile(sql, scope, args, 'run', catalog);
    if (p.steps || p.effect !== 'write') throw denied();
    return {
      check,
      args,
      expected: p.values,
      shape: shape(p.text),
      ledger: sql.includes('billing_') ? 'wallet' : 'pilot',
    };
  });
  if (scopes.size >= 32) scopes.delete(scopes.keys().next().value);
  scopes.set(scope.storeId, result);
  return result;
}
function assertAccountingStep(step, scope, capability, catalog) {
  assertAccountingScope(scope, capability);
  if (!capability || step.effect !== 'write') throw denied();
  const wanted = shape(step.text);
  for (const item of templates(catalog, scope)) {
    if (
      capability.ledger !== item.ledger ||
      wanted !== item.shape ||
      step.values.length !== item.expected.length
    )
      continue;
    const args = new Array(item.args.length),
      seen = new Set();
    let valid = true;
    for (let i = 0; i < item.expected.length; i++) {
      const n = item.args.indexOf(item.expected[i]),
        value = step.values[i];
      if (n < 0 ? value !== item.expected[i] : seen.has(n) && value !== args[n]) {
        valid = false;
        break;
      }
      if (n >= 0) {
        args[n] = value;
        seen.add(n);
      }
    }
    if (valid && seen.size === args.length && item.check(args, capability)) return;
  }
  throw denied();
}
async function assertAccountingReservation(query, scope, capability) {
  assertAccountingScope(scope, capability);
  if (capability.operation === 'reserve') return;
  const table = capability.ledger === 'pilot' ? 'assistant_reservations' : 'billing_reservations';
  const columns =
    capability.ledger === 'pilot'
      ? 'organization_id,account_id,membership_id,month'
      : 'organization_id,account_id,service';
  const found = await query(
    'SELECT ' + columns + ' FROM cartoteca_platform.' + table + ' WHERE _store_id=$1 AND id=$2',
    [scope.storeId, capability.reservationId],
  );
  if (found.rows.length === 0 && capability.operation === 'settle') return; // Exact duplicate settlement is inert.
  const row = found.rows[0];
  if (
    found.rows.length !== 1 ||
    row.organization_id !== capability.organizationId ||
    row.account_id !== capability.accountId ||
    (capability.ledger === 'pilot'
      ? row.membership_id !== capability.membershipId || row.month !== capability.month
      : row.service !== 'voice-assistant')
  )
    throw denied('POSTGRES_ACCOUNTING_RESERVATION_MISMATCH');
}
module.exports = {
  accountingScope,
  accountingOf,
  assertAccountingScope,
  assertAccountingStep,
  assertAccountingReservation,
};
