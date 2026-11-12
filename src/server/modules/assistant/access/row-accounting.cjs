const { randomUUID } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { encode } = require('./row-codec.cjs');
const {
  rubToMicrorub,
  rubFromMicrorub,
  safeInteger,
  addMoney,
} = require('../../billing/money.cjs');
function createRowAccounting(context, registration, reader) {
  const { db } = context;
  const write = (callback, scope) =>
    scope && context.db?.dialect === 'postgres' && context.asyncAccountingTransaction
      ? context.asyncAccountingTransaction(callback, scope)
      : context.asyncTransaction(callback);
  function reservationScope(reservation, operation) {
    const row = reader.sql('SELECT * FROM assistant_reservations WHERE id=?').get(reservation.id);
    if (!row) return undefined;
    reader.reservation(row);
    if (row.scope_kind !== 'actor') return null; // Imported legacy unknown costs retain the stricter writer.
    return {
      operation,
      ledger: 'pilot',
      organizationId: row.organization_id,
      accountId: row.account_id,
      membershipId: row.membership_id,
      month: row.month,
      day: new Date(row.created_at).toISOString().slice(0, 10),
      reservationId: row.id,
    };
  }
  function ensureMonth(month) {
    if (reader.sql('SELECT 1 FROM assistant_usage_months WHERE month=?').get(month)) return;
    reader
      .sql('INSERT INTO assistant_usage_months VALUES(?,0,0,0,0,?) ON CONFLICT(month) DO NOTHING')
      .run(
        month,
        encode(context, registration, 'assistant_usage_months', [month], { original: null }),
      );
  }
  function settleNow(reservation, actual = null) {
    const row = reader.sql('SELECT * FROM assistant_reservations WHERE id=?').get(reservation.id);
    if (!row) return;
    reader.reservation(row);
    const month = reader.month(row.month),
      known = Number.isFinite(actual) && actual >= 0;
    const charged = known ? rubToMicrorub(actual) : row.amount_microrub;
    if (month.reservedMicrorub < row.amount_microrub)
      throw Error('Assistant reserved aggregate underflow');
    reader
      .sql(
        `UPDATE assistant_usage_months SET spent_microrub=?,reserved_microrub=?,calls=?,uncertain_calls=? WHERE month=?`,
      )
      .run(
        addMoney(month.spentMicrorub, charged),
        month.reservedMicrorub - row.amount_microrub,
        safeInteger(BigInt(month.calls) + 1n),
        safeInteger(BigInt(month.uncertainCalls) + (known ? 0n : 1n)),
        row.month,
      );
    if (reader.sql('DELETE FROM assistant_reservations WHERE id=?').run(row.id).changes !== 1)
      throw Error('Assistant reservation settlement race');
    return { chargedMicrorub: charged, uncertain: !known };
  }
  function expire(now = Date.now(), limit = 32) {
    for (const row of reader
      .sql(
        'SELECT id FROM assistant_reservations WHERE expires_at<? ORDER BY expires_at,id LIMIT ?',
      )
      .all(now, limit))
      settleNow(row, null);
  }
  function reservePilot({
    current,
    revision,
    kind,
    amount,
    provider,
    pricing,
    assertScope,
    membershipId,
  }) {
    const date = new Date().toISOString().slice(0, 10);
    const scope = {
      operation: 'reserve',
      ledger: 'pilot',
      organizationId: current.organizationId,
      accountId: current.accountId,
      membershipId: membershipId || assertScope().member.membershipId,
      day: date,
      month: date.slice(0, 7),
      reservationId: null,
    };
    return write(() => {
      const fresh = assertScope();
      if (fresh.member.membershipId !== scope.membershipId)
        throw fail(409, 'Доступ к помощнику изменился. Повторите запрос.');
      if (fresh.scope.billing?.paid)
        throw fail(409, 'Способ оплаты помощника изменился. Повторите запрос.');
      const grant = reader.grant(current.organizationId, current.accountId);
      if (!grant || grant.membershipId !== fresh.member.membershipId)
        throw fail(403, 'Доступ к помощнику изменился.');
      const now = Date.now(),
        date = new Date(now).toISOString().slice(0, 10),
        month = date.slice(0, 7);
      if (date !== scope.day) throw fail(409, 'День учёта изменился. Повторите запрос.');
      expire(now);
      reader.sql('DELETE FROM assistant_usage_days WHERE day<?').run(date);
      reader.sql('DELETE FROM assistant_usage_days WHERE day>?').run(date);
      const requests = reader.day(date, fresh.member.membershipId),
        usage = reader.month(month);
      if (requests >= fresh.scope.limits.dailyRequests)
        throw fail(429, 'Дневной лимит обращений к помощнику исчерпан.');
      if (!Number.isFinite(amount) || amount < 0)
        throw fail(429, 'Недостаточно расчётного бюджета для следующего обращения.');
      const quote = rubToMicrorub(amount);
      const paid = context.billing?.wallet?.available()
        ? context.billing.wallet.monthlyProviderUsage('voice-assistant', month)
        : null;
      const total = addMoney(
        addMoney(usage.spentMicrorub, usage.reservedMicrorub),
        paid ? addMoney(paid.spentMicrorub, paid.reservedMicrorub) : 0,
      );
      if (
        quote > 0 &&
        addMoney(total, quote) > rubToMicrorub(fresh.state.policy.limits.monthlyBudgetRub)
      )
        throw fail(429, 'Недостаточно расчётного бюджета для следующего обращения.');
      if (reader.sql('SELECT count(*) amount FROM assistant_reservations').get().amount >= 500)
        throw fail(507, 'Журнал помощника достиг ограничения.');
      if (
        !requests &&
        reader.sql('SELECT count(*) amount FROM assistant_usage_days WHERE day=?').get(date)
          .amount >= 1000
      )
        throw fail(507, 'Журнал помощника достиг ограничения.');
      ensureMonth(month);
      reader
        .sql('UPDATE assistant_usage_months SET reserved_microrub=? WHERE month=?')
        .run(addMoney(usage.reservedMicrorub, quote), month);
      reader
        .sql(
          `INSERT INTO assistant_usage_days VALUES(?,?,?) ON CONFLICT(day,membership_id) DO UPDATE SET requests=excluded.requests`,
        )
        .run(date, fresh.member.membershipId, safeInteger(BigInt(requests) + 1n));
      const id = randomUUID(),
        reservation = { month, amount: rubFromMicrorub(quote), kind, createdAt: now };
      reader
        .sql(
          `INSERT INTO assistant_reservations VALUES(?,'actor',?,?,?,?,?,?,?, ?,?,'reserved',?,?,?)`,
        )
        .run(
          id,
          current.organizationId,
          current.accountId,
          fresh.member.membershipId,
          revision,
          grant.grantVersion,
          kind,
          provider,
          month,
          quote,
          now,
          now + 120000,
          encode(context, registration, 'assistant_reservations', [id], {
            reservation,
            pricing,
            scope: {
              organizationId: current.organizationId,
              accountId: current.accountId,
              membershipId: fresh.member.membershipId,
              policyRevision: revision,
              grantVersion: grant.grantVersion,
              provider,
            },
          }),
        );
      return { id, amount: reservation.amount };
    }, scope);
  }
  function markOutbound(reservation, assertScope) {
    const scope = reservationScope(reservation, 'outbound');
    if (scope === undefined) return Promise.reject(fail(409, 'Резерв помощника уже закрыт.'));
    return write(() => {
      const fresh = assertScope(),
        row = reader.sql('SELECT * FROM assistant_reservations WHERE id=?').get(reservation.id);
      if (!row) throw fail(409, 'Резерв помощника уже закрыт. Повторите запрос.');
      reader.reservation(row);
      const grant = reader.grant(fresh.member.organizationId, fresh.member.accountId);
      if (
        row.scope_kind !== 'actor' ||
        row.organization_id !== fresh.member.organizationId ||
        row.account_id !== fresh.member.accountId ||
        row.membership_id !== fresh.member.membershipId ||
        row.policy_revision !== fresh.state.revision ||
        row.grant_version !== grant?.grantVersion
      )
        throw fail(409, 'Доступ к помощнику изменился. Повторите запрос.');
      if (row.state === 'reserved')
        reader
          .sql("UPDATE assistant_reservations SET state='outbound' WHERE id=? AND state='reserved'")
          .run(row.id);
    }, scope);
  }
  return {
    reservePilot,
    markOutbound,
    settlePilot: (reservation, actual) => {
      const scope = reservationScope(reservation, 'settle');
      return scope === undefined
        ? Promise.resolve()
        : write(() => settleNow(reservation, actual), scope);
    },
    settleNow,
    expire,
  };
}
module.exports = { createRowAccounting };
