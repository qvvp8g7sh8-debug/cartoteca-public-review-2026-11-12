const { fail } = require('../../../../shared/errors.cjs');
const { addMoney, rubFromMicrorub } = require('../../billing/money.cjs');
function createAssistantRowBudget(context, store, policy) {
  function paidWrite(
    current,
    membershipId,
    operation,
    reservationId,
    callback,
    createdAt = Date.now(),
  ) {
    const day = new Date(createdAt).toISOString().slice(0, 10);
    const scope = {
      operation,
      ledger: 'wallet',
      organizationId: current.organizationId,
      accountId: current.accountId,
      membershipId,
      day,
      month: day.slice(0, 7),
      reservationId,
    };
    // SQLite and older profiles keep their established synchronous wallet contract.
    return context.db?.dialect === 'postgres' && context.asyncAccountingTransaction
      ? context.asyncAccountingTransaction(callback, scope)
      : callback();
  }
  function reserve(current, revision, kind, amount, task) {
    const fresh = policy.requireScope(current, revision);
    if (!fresh.scope.billing?.paid) {
      return store
        .reservePilot({
          current,
          revision,
          membershipId: fresh.member.membershipId,
          kind,
          amount,
          provider: fresh.state.providers[kind].provider,
          pricing: {
            model: fresh.state.providers[kind].model,
            inputRubPerMillion: fresh.state.rates[kind + 'Input'],
            outputRubPerMillion: fresh.state.rates[kind + 'Output'],
          },
          assertScope: () => policy.requireScope(current, revision),
        })
        .then((reservation) => ({ ...reservation, current, policyRevision: revision }));
    }
    const provider = fresh.state.providers[kind],
      month = new Date().toISOString().slice(0, 7);
    const view = store.month(month);
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
      legacyMonthlyRub: rubFromMicrorub(addMoney(view.spentMicrorub, view.reservedMicrorub)),
      pricing: {
        assistantRevision: revision,
        model: provider.model,
        inputRubPerMillion: fresh.state.rates[kind + 'Input'],
        outputRubPerMillion: fresh.state.rates[kind + 'Output'],
      },
      beforeReserve() {
        const active = policy.requireScope(current, revision);
        if (!active.scope.billing?.paid)
          throw fail(403, 'Платный голосовой помощник отключён для кабинета.');
        const date = new Date().toISOString().slice(0, 10),
          usage = store.month(date.slice(0, 7));
        request.legacyMonthlyRub = rubFromMicrorub(
          addMoney(usage.spentMicrorub, usage.reservedMicrorub),
        );
        request.legacyDailyRequests = store.day(date, active.member.membershipId);
      },
    };
    return paidWrite(current, fresh.member.membershipId, 'reserve', null, () => {
      const reserved = context.billing.wallet.reserve(request);
      return {
        id: reserved.id,
        amount: reserved.amountRub,
        paid: true,
        packageCovered: true,
        current,
        policyRevision: revision,
        membershipId: fresh.member.membershipId,
        createdAt: reserved.createdAt,
      };
    });
  }
  function settle(reservation, actual = null) {
    if (reservation.paid) {
      const known = Number.isFinite(actual) && actual >= 0;
      return paidWrite(
        reservation.current,
        reservation.membershipId,
        'settle',
        reservation.id,
        () =>
          context.billing.wallet.settle(reservation.id, {
            actualRub: known ? actual : null,
            estimated: true,
            uncertain: !known,
          }),
        reservation.createdAt,
      );
    }
    return store.settlePilot(reservation, actual);
  }
  function markOutbound(reservation) {
    if (reservation.paid)
      return paidWrite(
        reservation.current,
        reservation.membershipId,
        'outbound',
        reservation.id,
        () => {
          policy.requireScope(reservation.current, reservation.policyRevision);
          return context.billing.wallet.markOutbound(reservation.id);
        },
        reservation.createdAt,
      );
    return store.markOutbound(reservation, () =>
      policy.requireScope(reservation.current, reservation.policyRevision),
    );
  }
  return { reserve, settle, markOutbound };
}
module.exports = { createAssistantRowBudget };
