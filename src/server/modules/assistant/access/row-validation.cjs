const { initialState, validateState } = require('./defaults.cjs');
const { createRowReader, validDate } = require('./row-state.cjs');
const { normalizedLimits } = require('./member-limits.cjs');
const { safeInteger, addMoney } = require('../../billing/money.cjs');
const { validate } = require('./row-schema.cjs');
function validateSnapshot(context, registration = validate(context.db, { required: true })) {
  const { db } = context,
    reader = createRowReader(context, registration),
    current = reader.readPolicy();
  const historyRow = db.prepare('SELECT value FROM assistant_admin_history WHERE id=1').get();
  if (!historyRow) throw Error('Assistant administrative history missing');
  const history = reader.open('assistant_admin_history', [1], historyRow);
  validateState({
    ...initialState(),
    ...structuredClone(current),
    history: history.history,
    audit: history.audit,
    behavior: { ...structuredClone(current.behavior), history: history.behaviorHistory },
  });
  const counts = {
    grants: 0,
    enabledGrants: 0,
    months: 0,
    days: 0,
    reservations: 0,
    operations: 0,
  };
  for (const row of db.prepare('SELECT * FROM assistant_grants').iterate()) {
    const grant = reader.decodeGrant(row);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(grant.membershipId) ||
      typeof grant.organizationId !== 'string' ||
      !grant.organizationId ||
      grant.organizationId.length > 120 ||
      typeof grant.accountId !== 'string' ||
      !grant.accountId ||
      grant.accountId.length > 120
    )
      throw Error('Invalid assistant grant identity');
    if (grant.limits !== undefined) normalizedLimits(grant.limits, true);
    safeInteger(row.grant_version);
    safeInteger(row.position);
    counts.grants++;
    if (row.enabled) counts.enabledGrants++;
  }
  const reserved = new Map();
  for (const row of db.prepare('SELECT * FROM assistant_reservations').iterate()) {
    reader.reservation(row);
    validDate(row.month, true);
    safeInteger(row.amount_microrub);
    safeInteger(row.created_at);
    safeInteger(row.expires_at);
    reserved.set(row.month, addMoney(reserved.get(row.month) || 0, row.amount_microrub));
    counts.reservations++;
  }
  for (const row of db.prepare('SELECT * FROM assistant_usage_months').iterate()) {
    const evidence = reader.open('assistant_usage_months', [row.month], row);
    if (!evidence || !Object.hasOwn(evidence, 'original'))
      throw Error('Assistant usage evidence is missing');
    if (evidence.original !== null) {
      const original = evidence.original;
      if (
        !original ||
        typeof original !== 'object' ||
        Array.isArray(original) ||
        !Number.isFinite(original.spentRub) ||
        original.spentRub < 0
      )
        throw Error('Invalid assistant imported usage evidence');
      safeInteger(original.calls);
      safeInteger(original.uncertainCalls);
    }
    validDate(row.month, true);
    for (const name of ['spent_microrub', 'reserved_microrub', 'calls', 'uncertain_calls'])
      safeInteger(row[name]);
    if (row.reserved_microrub !== (reserved.get(row.month) || 0))
      throw Error('Assistant reserved aggregate mismatch');
    reserved.delete(row.month);
    counts.months++;
  }
  if (reserved.size) throw Error('Assistant reservation aggregate missing');
  for (const row of db.prepare('SELECT * FROM assistant_usage_days').iterate()) {
    validDate(row.day);
    safeInteger(row.requests);
    if (!/^[A-Za-z0-9_-]{43}$/.test(row.membership_id))
      throw Error('Invalid assistant day identity');
    counts.days++;
  }
  for (const row of db.prepare('SELECT * FROM assistant_admin_operations').iterate()) {
    const value = reader.open('assistant_admin_operations', [row.actor_id, row.request_id], row);
    if (
      value.actorId !== row.actor_id ||
      value.requestId !== row.request_id ||
      value.kind !== row.kind ||
      value.fingerprint !== row.fingerprint ||
      value.revision !== row.revision ||
      !/^[a-f0-9]{64}$/i.test(value.fingerprint)
    )
      throw Error('Assistant operation scalar binding mismatch');
    safeInteger(row.revision);
    safeInteger(row.position);
    counts.operations++;
  }
  if (
    counts.enabledGrants > 500 ||
    counts.reservations > 500 ||
    counts.days > 1000 ||
    counts.operations > 100
  )
    throw Error('Assistant row bounds exceeded');
  if (
    db.prepare('SELECT count(*) amount FROM assistant_settings').get().amount !== 1 ||
    db.prepare('SELECT count(*) amount FROM assistant_admin_history').get().amount !== 1
  )
    throw Error('Assistant singleton rows missing');
  return { componentVersion: 1, ...counts };
}
module.exports = { validateSnapshot };
