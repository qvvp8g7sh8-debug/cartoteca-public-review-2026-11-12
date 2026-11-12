const { addMoney, rubToMicrorub, rubFromMicrorub, markedUp } = require('./money.cjs');
const { createWalletEvidence } = require('./wallet-evidence.cjs');
const { requireWalletLimits, pricingSnapshot } = require('./wallet-limits.cjs');
function createWalletReservations(ledger, settings) {
  const {
    db,
    seal,
    open,
    transaction,
    ready,
    fail,
    identifier,
    organization,
    wallet,
    saveWallet,
    id,
    entry,
    fingerprint,
  } = ledger;
  const evidence = createWalletEvidence(ledger);
  function reservationView(row) {
    return {
      id: row.id,
      organizationId: row.organization_id,
      accountId: row.account_id,
      service: row.service,
      kind: row.kind,
      provider: row.provider,
      state: row.state,
      markupBps: row.markup_bps,
      packageCovered: Boolean(row.package_covered),
      amountRub: rubFromMicrorub(row.provider_quote_microrub),
      chargeRub: rubFromMicrorub(row.charge_quote_microrub),
      amountMicrorub: row.provider_quote_microrub,
      chargeMicrorub: row.charge_quote_microrub,
      actualMicrorub: row.provider_actual_microrub,
      chargedMicrorub: row.charged_microrub,
      retailMicrorub: row.retail_microrub,
      unpaidChargeMicrorub: row.unpaid_charge_microrub || 0,
      reconciliationRequired: (row.unpaid_charge_microrub || 0) > 0,
      estimated: Boolean(row.estimated),
      uncertain: Boolean(row.uncertain),
      createdAt: row.created_at,
      settledAt: row.settled_at,
    };
  }
  function reserve(input) {
    ready();
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw fail(400, 'Нужны данные денежного резерва.');
    const amount = rubToMicrorub(input.amountRub);
    const pricing = pricingSnapshot(input.pricing, fail);
    const task = evidence.taskEvidence(input.task);
    if (input.beforeReserve !== undefined && typeof input.beforeReserve !== 'function')
      throw fail(400, 'Некорректная проверка денежного доступа.');
    identifier(input.accountId, 'сотрудник');
    identifier(input.service, 'платная услуга');
    identifier(input.kind, 'вид обращения');
    identifier(input.provider, 'провайдер');
    return transaction(() => {
      input.beforeReserve?.();
      organization(input.organizationId);
      requireWalletLimits(ledger, input, amount);
      if (!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(input.accountId))
        throw fail(404, 'Сотрудник не найден.');
      const common = settings.getSettings();
      const packageCovered = input.packageCovered === true;
      const markup = packageCovered
        ? 0
        : settings.organizationSettings(input.organizationId).effectiveMarkupBps;
      // Ignore a browser supplied markup: only the current server tariff creates a quote.
      if (input.markupBps !== undefined && input.markupBps !== markup)
        throw fail(409, 'Наценка изменилась. Получите актуальный тариф.');
      const charge = packageCovered ? 0 : markedUp(amount, markup);
      if (
        !packageCovered &&
        amount > 0 &&
        (!common.configured || common.insufficientFundsPolicy !== 'prepaid')
      )
        throw fail(503, 'Правила списания с баланса ещё не настроены.');
      const customer = wallet(input.organizationId, true);
      if (charge > addMoney(customer.balance_microrub, -customer.reserved_microrub))
        throw fail(402, 'Недостаточно средств на общем балансе кабинета.');
      const master = wallet(null, true);
      customer.reserved_microrub = addMoney(customer.reserved_microrub, charge);
      master.reserved_microrub = addMoney(master.reserved_microrub, amount);
      saveWallet(customer);
      saveWallet(master);
      const reservationId = id();
      db.prepare(
        `INSERT INTO billing_reservations(id,organization_id,account_id,service,kind,provider,
        state,provider_quote_microrub,charge_quote_microrub,markup_bps,created_at,value,package_covered)
        VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?)`,
      ).run(
        reservationId,
        input.organizationId,
        input.accountId,
        input.service,
        input.kind,
        input.provider,
        amount,
        charge,
        markup,
        Date.now(),
        seal({
          ...pricing,
          ...task,
          policyRevision: common.revision,
          organizationRevision: settings.organizationSettings(input.organizationId)
            .organizationRevision,
          quote: { providerMicrorub: amount, chargeMicrorub: charge, markupBps: markup },
          packageCovered,
        }),
        Number(packageCovered),
      );
      return reservationView(
        db.prepare('SELECT * FROM billing_reservations WHERE id=?').get(reservationId),
      );
    });
  }
  function settle(reservationId, input = {}) {
    ready();
    identifier(reservationId, 'денежный резерв');
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (input.estimated !== undefined && typeof input.estimated !== 'boolean') ||
      (input.uncertain !== undefined && typeof input.uncertain !== 'boolean')
    )
      throw fail(400, 'Неверные данные завершения резерва.');
    const known = input.actualRub !== undefined && input.actualRub !== null;
    const actual = known ? rubToMicrorub(input.actualRub) : null;
    return transaction(() => {
      const row = db.prepare('SELECT * FROM billing_reservations WHERE id=?').get(reservationId);
      if (!row) throw fail(404, 'Денежный резерв не найден.');
      if (row.state !== 'pending') return { ...reservationView(row), replayed: true };
      if (!known && input.uncertain !== true)
        throw fail(400, 'Для неизвестного расхода нужно явно указать неопределённый результат.');
      const cost = actual ?? row.provider_quote_microrub;
      const retail = row.package_covered ? 0 : markedUp(cost, row.markup_bps);
      // Record every provider expense. Excess retail cost remains visible for reconciliation;
      // it never silently creates an unapproved customer overdraft or disappears as a waiver.
      const charged = Math.min(retail, row.charge_quote_microrub);
      const unpaid = retail - charged;
      const customer = wallet(row.organization_id, true),
        master = wallet(null, true);
      customer.reserved_microrub = addMoney(customer.reserved_microrub, -row.charge_quote_microrub);
      master.reserved_microrub = addMoney(master.reserved_microrub, -row.provider_quote_microrub);
      customer.balance_microrub = addMoney(customer.balance_microrub, -charged);
      master.balance_microrub = addMoney(master.balance_microrub, -cost, true);
      for (const target of [customer, master]) {
        target.provider_cost_microrub = addMoney(target.provider_cost_microrub, cost);
        target.charged_microrub = addMoney(target.charged_microrub, charged);
        target.unpaid_charge_microrub = addMoney(target.unpaid_charge_microrub, unpaid);
        saveWallet(target);
      }
      const detail = {
        ...open(row.value),
        providerCostMicrorub: cost,
        retailMicrorub: retail,
        chargedMicrorub: charged,
        unpaidChargeMicrorub: unpaid,
        estimated: input.estimated !== false || !known,
        uncertain: input.uncertain === true,
      };
      const entries = [[master, 'expense', -cost]];
      if (!row.package_covered) entries.push([customer, 'charge', -charged]);
      for (const [target, kind, amount] of entries)
        entry({
          row: target,
          organizationId: row.organization_id,
          reservationId,
          service: row.service,
          kind,
          amount,
          key: 'reservation:' + reservationId,
          fingerprint: fingerprint(detail),
          detail,
        });
      db.prepare(
        `UPDATE billing_reservations SET state=?,provider_actual_microrub=?,charged_microrub=?,
        retail_microrub=?,unpaid_charge_microrub=?,estimated=?,uncertain=?,settled_at=?,value=? WHERE id=? AND state='pending'`,
      ).run(
        cost === 0 ? 'released' : 'settled',
        cost,
        charged,
        retail,
        unpaid,
        Number(detail.estimated),
        Number(detail.uncertain),
        Date.now(),
        seal(detail),
        reservationId,
      );
      return reservationView(
        db.prepare('SELECT * FROM billing_reservations WHERE id=?').get(reservationId),
      );
    });
  }
  return {
    reserve,
    settle,
    markOutbound: evidence.markOutbound,
    reservationReview: evidence.reservationReview,
  };
}
module.exports = { createWalletReservations };
