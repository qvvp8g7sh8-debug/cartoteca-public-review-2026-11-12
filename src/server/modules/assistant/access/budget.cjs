const { randomUUID } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { usageView } = require('./administration.cjs');
function createAssistantBudget(context, store, policy) {
  if (store.backend === 'rows-v1')
    return require('./row-budget.cjs').createAssistantRowBudget(context, store, policy);
  // PostgreSQL admission may wait only before BEGIN; callback/file commits are
  // synchronous and never replayed. SQLite keeps its established sync contract.
  const write = (callback) =>
    context.db?.dialect === 'postgres'
      ? context.asyncTransaction(callback)
      : context.transaction(callback);
  function charge(state, reservation, amount, uncertain) {
    const usage = (state.usage[reservation.month] ||= { spentRub: 0, calls: 0, uncertainCalls: 0 });
    usage.spentRub += amount;
    usage.calls++;
    if (uncertain) usage.uncertainCalls++;
  }
  function reserve(current, revision, kind, amount, task) {
    const fresh = policy.requireScope(current, revision, store.read());
    if (fresh.scope.billing?.paid) {
      const provider = fresh.state.providers[kind],
        view = usageView(fresh.state);
      const request = {
        organizationId: current.organizationId,
        accountId: current.accountId,
        service: 'voice-assistant',
        kind,
        provider: provider.provider,
        amountRub: amount,
        packageCovered: true,
        ...(task ? { task } : {}),
        limits: {
          dailyRequests: fresh.scope.limits.dailyRequests,
          monthlyBudgetRub: fresh.state.policy.limits.monthlyBudgetRub,
        },
        legacyMonthlyRub: view.spentRub + view.reservedRub,
        pricing: {
          assistantRevision: revision,
          model: provider.model,
          inputRubPerMillion: fresh.state.rates[kind + 'Input'],
          outputRubPerMillion: fresh.state.rates[kind + 'Output'],
        },
        beforeReserve() {
          const active = policy.requireScope(current, revision, store.read());
          if (!active.scope.billing?.paid)
            throw fail(403, 'Платный голосовой помощник отключён для кабинета.');
          const usage = usageView(active.state);
          request.legacyMonthlyRub = usage.spentRub + usage.reservedRub;
          request.legacyDailyRequests =
            active.state.daily[
              new Date().toISOString().slice(0, 10) + ':' + active.member.membershipId
            ] || 0;
        },
      };
      const reserved = context.billing.wallet.reserve(request);
      return { id: reserved.id, amount: reserved.amountRub, paid: true, packageCovered: true };
    }
    return write(() =>
      store.update((state) => {
        const { member, scope } = policy.requireScope(current, revision, state),
          now = Date.now();
        if (scope.billing?.paid)
          throw fail(409, 'Способ оплаты помощника изменился. Повторите запрос.');
        for (const [id, pending] of Object.entries(state.reservations))
          if (now - pending.createdAt > 120000) {
            charge(state, pending, pending.amount, true);
            delete state.reservations[id];
          }
        const view = usageView(state),
          date = new Date().toISOString().slice(0, 10);
        const paidUsage = context.billing?.wallet?.available()
          ? context.billing.wallet.monthlyProviderUsage('voice-assistant', view.month)
          : null;
        const paidMonthlyRub = paidUsage
          ? (paidUsage.spentMicrorub + paidUsage.reservedMicrorub) / 1000000
          : 0;
        for (const day of Object.keys(state.daily))
          if (!day.startsWith(date + ':')) delete state.daily[day];
        const dayKey = date + ':' + member.membershipId;
        if ((state.daily[dayKey] || 0) >= scope.limits.dailyRequests)
          throw fail(429, 'Дневной лимит обращений к помощнику исчерпан.');
        if (
          !Number.isFinite(amount) ||
          amount < 0 ||
          (amount > 0 &&
            view.spentRub + view.reservedRub + paidMonthlyRub + amount >
              state.policy.limits.monthlyBudgetRub)
        )
          throw fail(429, 'Недостаточно расчётного бюджета для следующего обращения.');
        state.daily[dayKey] = (state.daily[dayKey] || 0) + 1;
        const id = randomUUID();
        state.reservations[id] = { month: view.month, amount, kind, createdAt: now };
        // Only recent monthly totals are useful; no transcripts or clinical data are retained.
        const months = Object.keys(state.usage).sort().reverse();
        for (const month of months.slice(12)) delete state.usage[month];
        return { id, amount };
      }),
    );
  }
  function settle(reservation, actual = null) {
    if (reservation.paid) {
      const known = Number.isFinite(actual) && actual >= 0;
      return context.billing.wallet.settle(reservation.id, {
        actualRub: known ? actual : null,
        estimated: true,
        uncertain: !known,
      });
    }
    return write(() =>
      store.update((state) => {
        const pending = state.reservations[reservation.id];
        if (!pending) return;
        // A provider error or missing usage cannot turn a paid retry into a free request.
        const known = Number.isFinite(actual) && actual >= 0;
        charge(state, pending, known ? actual : pending.amount, !known);
        delete state.reservations[reservation.id];
      }),
    );
  }
  function markOutbound(reservation) {
    if (reservation?.paid) return context.billing.wallet.markOutbound(reservation.id);
  }
  return { reserve, settle, markOutbound };
}
module.exports = { createAssistantBudget };
