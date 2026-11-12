const { initialState, validateState } = require('../../modules/assistant/access/defaults.cjs');
const { createRowReader, validDate } = require('../../modules/assistant/access/row-state.cjs');
const { normalizedLimits } = require('../../modules/assistant/access/member-limits.cjs');
const { readSentinel } = require('../../modules/assistant/access/row-sentinel.cjs');
const { safeInteger, addMoney } = require('../../modules/billing/money.cjs');
function numbers(row, table) {
  return Object.fromEntries(
    table.columns.map((column) => [
      column.name,
      column.type.toUpperCase() === 'INTEGER' && row[column.name] !== null
        ? safeInteger(row[column.name])
        : row[column.name],
    ]),
  );
}
function registrationRow(row, table) {
  row = numbers(row, table);
  if (
    row.id !== 1 ||
    row.version !== 1 ||
    row.backend !== 'rows-v1' ||
    row.registry_mode !== 'memory' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row.store_id) ||
    !/^[a-f0-9]{64}$/.test(row.import_sha256)
  )
    throw Error('Invalid assistant backup registration.');
  return row;
}
// Uses the same envelope/scalar readers as the runtime. No SQLite database,
// network model or alternate SQL backend is involved in archive verification.
function createAssistantBackupValidator(context, registration) {
  const reader = createRowReader(
    {
      ...context,
      db: {
        prepare() {
          throw Error('Unexpected assistant archive SQL.');
        },
      },
    },
    registration,
  );
  const reserved = new Map(),
    months = new Map(),
    counts = { settings: 0, history: 0, enabled: 0, reservations: 0, days: 0, operations: 0 };
  let settings, history;
  function row(name, input, table) {
    const row = numbers(input, table);
    if (name === 'assistant_settings') {
      counts.settings++;
      settings = reader.open(name, [1], row);
      if (row.id !== 1 || settings.revision !== row.revision || settings.policy?.mode !== row.mode)
        throw Error('Assistant backup policy binding mismatch.');
    } else if (name === 'assistant_admin_history') {
      counts.history++;
      if (row.id !== 1) throw Error('Assistant history singleton differs.');
      history = reader.open(name, [1], row);
    } else if (name === 'assistant_grants') {
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
        throw Error('Invalid assistant backup grant identity.');
      if (grant.limits !== undefined) normalizedLimits(grant.limits, true);
      if (row.enabled) counts.enabled++;
    } else if (name === 'assistant_reservations') {
      reader.reservation(row);
      validDate(row.month, true);
      reserved.set(row.month, addMoney(reserved.get(row.month) || 0, row.amount_microrub));
      counts.reservations++;
    } else if (name === 'assistant_usage_months') {
      validDate(row.month, true);
      const evidence = reader.open(name, [row.month], row);
      if (!evidence || !Object.hasOwn(evidence, 'original'))
        throw Error('Assistant backup usage evidence is missing.');
      if (evidence.original !== null) {
        const original = evidence.original;
        if (
          !original ||
          typeof original !== 'object' ||
          Array.isArray(original) ||
          !Number.isFinite(original.spentRub) ||
          original.spentRub < 0
        )
          throw Error('Invalid assistant backup usage evidence.');
        safeInteger(original.calls);
        safeInteger(original.uncertainCalls);
      }
      months.set(row.month, row.reserved_microrub);
    } else if (name === 'assistant_usage_days') {
      validDate(row.day);
      if (!/^[A-Za-z0-9_-]{43}$/.test(row.membership_id))
        throw Error('Invalid assistant backup daily identity.');
      counts.days++;
    } else if (name === 'assistant_admin_operations') {
      const value = reader.open(name, [row.actor_id, row.request_id], row);
      if (
        value.actorId !== row.actor_id ||
        value.requestId !== row.request_id ||
        value.kind !== row.kind ||
        value.fingerprint !== row.fingerprint ||
        value.revision !== row.revision ||
        !/^[a-f0-9]{64}$/i.test(value.fingerprint)
      )
        throw Error('Assistant backup operation binding mismatch.');
      counts.operations++;
    }
    if (
      counts.enabled > 500 ||
      counts.reservations > 500 ||
      counts.days > 1000 ||
      counts.operations > 100
    )
      throw Error('Assistant backup row bounds exceeded.');
  }
  function finish() {
    if (counts.settings !== 1 || counts.history !== 1)
      throw Error('Assistant backup singleton is missing.');
    validateState({
      ...initialState(),
      ...settings,
      history: history.history,
      audit: history.audit,
      behavior: { ...settings.behavior, history: history.behaviorHistory },
    });
    for (const [month, amount] of months) {
      if (amount !== (reserved.get(month) || 0))
        throw Error('Assistant backup reserved aggregate mismatch.');
      reserved.delete(month);
    }
    if (reserved.size) throw Error('Assistant backup reservation aggregate is missing.');
    readSentinel(context, registration);
    return counts;
  }
  return { row, finish };
}
module.exports = { createAssistantBackupValidator, registrationRow };
