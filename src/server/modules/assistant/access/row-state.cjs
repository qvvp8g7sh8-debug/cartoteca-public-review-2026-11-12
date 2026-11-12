const { initialState, validateState } = require('./defaults.cjs');
const { decode } = require('./row-codec.cjs');
const { rubFromMicrorub, rubToMicrorub, safeInteger } = require('../../billing/money.cjs');
function settingsValue(state) {
  return {
    schema: 1,
    revision: state.revision,
    policy: state.policy,
    providers: state.providers,
    rates: state.rates,
    credentials: state.credentials,
    behavior: { version: state.behavior.version, current: state.behavior.current },
  };
}
function historyValue(state) {
  return { history: state.history, audit: state.audit, behaviorHistory: state.behavior.history };
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validDate(value, month = false) {
  if (typeof value !== 'string' || !(month ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(value))
    throw Error('Invalid assistant row calendar key');
  const day = month ? value + '-01' : value;
  if (
    !Number.isFinite(Date.parse(day + 'T00:00:00Z')) ||
    new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day
  )
    throw Error('Invalid assistant row calendar key');
  return value;
}
function createRowReader(context, registration) {
  const { db } = context;
  const statement = new Map();
  const sql = (query) => {
    if (!statement.has(query)) statement.set(query, db.prepare(query));
    return statement.get(query);
  };
  const open = (table, key, row) => decode(context, registration, table, key, row.value);
  let cache;
  function decodeGrant(row) {
    const value = open('assistant_grants', [row.organization_id, row.account_id], row),
      grant = value.grant;
    if (
      !grant ||
      grant.organizationId !== row.organization_id ||
      grant.accountId !== row.account_id ||
      grant.membershipId !== row.membership_id ||
      value.enabled !== Boolean(row.enabled) ||
      value.version !== row.grant_version
    )
      throw Error('Assistant grant scalar binding mismatch');
    return grant;
  }
  function reservation(row) {
    const value = open('assistant_reservations', [row.id], row),
      pending = value.reservation;
    if (
      !pending ||
      pending.month !== row.month ||
      pending.kind !== row.kind ||
      pending.createdAt !== row.created_at ||
      rubToMicrorub(pending.amount) !== row.amount_microrub
    )
      throw Error('Assistant reservation scalar binding mismatch');
    if (row.scope_kind === 'actor') {
      const scope = value.scope;
      if (
        !scope ||
        scope.organizationId !== row.organization_id ||
        scope.accountId !== row.account_id ||
        scope.membershipId !== row.membership_id ||
        scope.policyRevision !== row.policy_revision ||
        scope.grantVersion !== row.grant_version ||
        scope.provider !== row.provider
      )
        throw Error('Assistant reservation scope binding mismatch');
    } else if (value.scope !== undefined || value.imported !== true)
      throw Error('Assistant imported reservation scope mismatch');
    return value;
  }
  function decodePolicy(row) {
    if (!row) throw Error('Assistant current policy is missing');
    if (
      cache &&
      cache.revision === row.revision &&
      cache.mode === row.mode &&
      Buffer.from(row.value).equals(cache.bytes)
    )
      return cache.state;
    const value = open('assistant_settings', [1], row);
    if (value.revision !== row.revision || value.policy?.mode !== row.mode)
      throw Error('Assistant policy scalar binding mismatch');
    const state = validateState({
      ...initialState(),
      ...value,
      behavior: { ...value.behavior, history: [] },
    });
    const current = freeze(settingsValue(state));
    cache = {
      revision: row.revision,
      mode: row.mode,
      bytes: Buffer.from(row.value),
      state: current,
    };
    return current;
  }
  function readPolicy() {
    return decodePolicy(sql('SELECT revision,mode,value FROM assistant_settings WHERE id=1').get());
  }
  function readScope(current) {
    if (
      typeof current?.organizationId !== 'string' ||
      !current.organizationId ||
      typeof current.accountId !== 'string' ||
      !current.accountId ||
      current.globalAdmin
    )
      return { state: readPolicy(), grant: null, memberRow: null };
    // One fresh snapshot query; no authority is cached across guard boundaries.
    // The selected-mode predicates avoid membership/grant lookups when disabled.
    const row = sql(`SELECT s.revision,s.mode,s.value,
      g.organization_id,g.account_id,g.membership_id,g.enabled,g.grant_version,
      g.value AS grant_value,m.role,m.status,m.created_at,
      a.status AS account_status,a.global_admin,o.status AS organization_status
      FROM assistant_settings s
      LEFT JOIN assistant_grants g ON s.mode='selected' AND g.organization_id=? AND g.account_id=?
      LEFT JOIN memberships m ON s.mode='selected' AND m.organization_id=? AND m.account_id=?
      LEFT JOIN accounts a ON a.id=m.account_id
      LEFT JOIN organizations o ON o.id=m.organization_id
      WHERE s.id=1`).get(
      current.organizationId,
      current.accountId,
      current.organizationId,
      current.accountId,
    );
    const state = decodePolicy(row);
    const grant =
      row.enabled === 1
        ? { ...decodeGrant({ ...row, value: row.grant_value }), grantVersion: row.grant_version }
        : null;
    return {
      state,
      grant,
      memberRow:
        row.role == null || row.account_status == null || row.organization_status == null
          ? null
          : row,
    };
  }
  function grant(organizationId, accountId) {
    const row = sql('SELECT * FROM assistant_grants WHERE organization_id=? AND account_id=?').get(
      organizationId,
      accountId,
    );
    if (!row || row.enabled !== 1) return null;
    const value = decodeGrant(row);
    return { ...value, grantVersion: row.grant_version };
  }
  function month(value) {
    validDate(value, true);
    const row = sql(
      'SELECT spent_microrub,reserved_microrub,calls,uncertain_calls FROM assistant_usage_months WHERE month=?',
    ).get(value);
    return {
      month: value,
      spentRub: rubFromMicrorub(row?.spent_microrub || 0),
      reservedRub: rubFromMicrorub(row?.reserved_microrub || 0),
      spentMicrorub: row?.spent_microrub || 0,
      reservedMicrorub: row?.reserved_microrub || 0,
      calls: row?.calls || 0,
      uncertainCalls: row?.uncertain_calls || 0,
    };
  }
  function day(date, member) {
    validDate(date);
    return (
      sql('SELECT requests FROM assistant_usage_days WHERE day=? AND membership_id=?').get(
        date,
        member,
      )?.requests || 0
    );
  }
  function adminSnapshot({ fullUsage = false } = {}) {
    const policy = readPolicy(),
      historyRow = sql('SELECT value FROM assistant_admin_history WHERE id=1').get();
    if (!historyRow) throw Error('Assistant administrative history is missing');
    const history = open('assistant_admin_history', [1], historyRow);
    const state = {
      ...initialState(),
      ...structuredClone(policy),
      history: history.history,
      audit: history.audit,
      behavior: { ...structuredClone(policy.behavior), history: history.behaviorHistory },
    };
    for (const row of sql(
      'SELECT * FROM assistant_grants WHERE enabled=1 ORDER BY position,organization_id,account_id',
    ).iterate()) {
      state.grants.push(decodeGrant(row));
    }
    // Administration exposes only current usage and a bounded recent view. SQL retains
    // every pending/settled month; strict offline export must include the full ledger.
    const currentMonth = new Date().toISOString().slice(0, 7);
    const months = fullUsage
      ? sql('SELECT * FROM assistant_usage_months ORDER BY month').iterate()
      : sql(
          'SELECT * FROM assistant_usage_months WHERE month=? OR month IN (SELECT month FROM assistant_usage_months WHERE month<>? ORDER BY month DESC LIMIT 23) ORDER BY month',
        ).iterate(currentMonth, currentMonth);
    for (const row of months) {
      const evidence = open('assistant_usage_months', [row.month], row);
      if (!row.spent_microrub && !row.calls && !row.uncertain_calls && evidence.original === null)
        continue;
      state.usage[row.month] = {
        ...evidence.original,
        spentRub: rubFromMicrorub(row.spent_microrub),
        calls: row.calls,
        uncertainCalls: row.uncertain_calls,
      };
    }
    for (const row of sql(
      'SELECT * FROM assistant_usage_days ORDER BY day,membership_id',
    ).iterate())
      state.daily[row.day + ':' + row.membership_id] = safeInteger(row.requests);
    for (const row of sql(
      'SELECT * FROM assistant_reservations ORDER BY created_at,id',
    ).iterate()) {
      const value = reservation(row);
      state.reservations[row.id] = {
        ...value.reservation,
        month: row.month,
        amount: rubFromMicrorub(row.amount_microrub),
        kind: row.kind,
        createdAt: row.created_at,
      };
    }
    for (const row of sql(
      'SELECT * FROM assistant_admin_operations ORDER BY position,actor_id,request_id',
    ).iterate()) {
      const value = open('assistant_admin_operations', [row.actor_id, row.request_id], row);
      if (
        value.actorId !== row.actor_id ||
        value.requestId !== row.request_id ||
        value.fingerprint !== row.fingerprint ||
        value.kind !== row.kind ||
        value.revision !== row.revision
      )
        throw Error('Assistant operation scalar binding mismatch');
      state.operations.push(value);
    }
    return validateState(state);
  }
  return {
    sql,
    open,
    readPolicy,
    readScope,
    grant,
    decodeGrant,
    reservation,
    month,
    day,
    adminSnapshot,
  };
}
module.exports = { createRowReader, settingsValue, historyValue, validDate };
