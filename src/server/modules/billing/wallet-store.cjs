const { createWalletLedger } = require('./wallet-ledger.cjs');
const { createWalletSettings } = require('./wallet-settings.cjs');
const { createWalletReservations } = require('./wallet-reservations.cjs');
const { safeInteger, addMoney } = require('./money.cjs');
const { monthlyProviderUsage } = require('./wallet-limits.cjs');
function createWalletStore(context) {
  const ledger = createWalletLedger(context);
  const settings = createWalletSettings(ledger);
  const reservations = createWalletReservations(ledger, settings);
  const {
    db,
    open,
    transaction,
    ready,
    available,
    fail,
    wallet,
    values,
    identifier,
    organization,
    assertAdmin,
    reasonText,
    fingerprint,
    entry,
    saveWallet,
  } = ledger;
  function getWallet(organizationId = null) {
    const common = settings.getSettings();
    if (!available())
      return {
        available: false,
        organizationId,
        configured: false,
        revision: 0,
        organizationRevision: 0,
        organization_revision: 0,
        markupBps: null,
        effectiveMarkupBps: common.defaultMarkupBps,
        ...values({
          balance_microrub: 0,
          reserved_microrub: 0,
          provider_cost_microrub: 0,
          charged_microrub: 0,
          unpaid_charge_microrub: 0,
        }),
      };
    const row = wallet(organizationId);
    return {
      available: true,
      organizationId,
      walletId: row.id,
      revision: row.revision,
      configured: common.configured,
      insufficientFundsPolicy: common.insufficientFundsPolicy,
      ...(organizationId === null ? {} : settings.organizationSettings(organizationId)),
      ...values(row),
      changedAt: row.changed_at || null,
    };
  }
  function listHistory(organizationId = null, { offset = 0, limit = 30 } = {}) {
    ready();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw fail(400, 'Некорректная страница денежной истории.');
    if (organizationId !== null) organization(organizationId);
    const key = ledger.walletId(organizationId);
    const rows = db
      .prepare(
        `SELECT * FROM billing_entries WHERE wallet_id=?
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(key, limit, offset);
    return {
      items: rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        walletId: row.wallet_id,
        reservationId: row.reservation_id,
        kind: row.kind,
        service: row.service,
        amountMicrorub: row.amount_microrub,
        balanceAfterMicrorub: row.balance_after_microrub,
        actorId: row.actor_id,
        createdAt: row.created_at,
        detail: open(row.value),
      })),
      total: db.prepare('SELECT count(*) n FROM billing_entries WHERE wallet_id=?').get(key).n,
      offset,
      limit,
    };
  }
  function adjustCredit(organizationId, input) {
    ready();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'idempotencyKey',
            'amountMicrorub',
            'actorId',
            'reason',
            'paymentReference',
            'document',
          ].includes(key),
      )
    )
      throw fail(400, 'Неверные поля пополнения баланса.');
    const key = identifier(input.idempotencyKey, 'номер операции');
    const amount = safeInteger(input.amountMicrorub);
    if (amount === 0) throw fail(400, 'Пополнение должно быть больше нуля.');
    const reason = reasonText(input.reason);
    const proof = {};
    for (const field of ['paymentReference', 'document']) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== 'string' || input[field].trim().length > 500)
        throw fail(400, 'Неверная ссылка на подтверждение платежа.');
      proof[field] = input[field].trim();
    }
    const hash = fingerprint({
      organizationId,
      actorId: input.actorId,
      amountMicrorub: amount,
      reason,
      ...proof,
    });
    return transaction(() => {
      assertAdmin(input.actorId);
      const row = wallet(organizationId, true);
      const previous = db
        .prepare(
          'SELECT id,fingerprint FROM billing_entries WHERE wallet_id=? AND idempotency_key=?',
        )
        .get(row.id, key);
      if (previous) {
        if (previous.fingerprint !== hash)
          throw fail(409, 'Номер операции уже использован для другого пополнения.');
        return { entryId: previous.id, replayed: true, wallet: getWallet(organizationId) };
      }
      row.balance_microrub = addMoney(row.balance_microrub, amount, organizationId === null);
      saveWallet(row);
      const entryId = entry({
        row,
        organizationId,
        kind: 'credit',
        amount,
        actorId: input.actorId,
        key,
        fingerprint: hash,
        detail: {
          reason,
          amountMicrorub: amount,
          source: 'manual-adjustment',
          ...proof,
          paymentVerified: false,
          receiptIssued: false,
        },
      });
      ledger.audit('billing_balance_adjusted', input.actorId, organizationId, {
        entryId,
        amountMicrorub: amount,
      });
      return { entryId, wallet: getWallet(organizationId) };
    });
  }
  function totals(organizationId = null) {
    ready();
    const base = getWallet(organizationId);
    const filter = organizationId === null ? '' : 'WHERE organization_id=?';
    const counts = db
      .prepare(
        `SELECT count(*) calls,
      COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) pending,
      COALESCE(SUM(CASE WHEN uncertain=1 THEN 1 ELSE 0 END),0) uncertain
      FROM billing_reservations ${filter}`,
      )
      .get(...(organizationId === null ? [] : [organizationId]));
    const result = {
      ...base,
      calls: counts.calls,
      pendingReservations: counts.pending,
      uncertainCalls: counts.uncertain,
    };
    if (organizationId === null) {
      const rows = db
        .prepare(
          'SELECT balance_microrub,reserved_microrub FROM billing_wallets WHERE organization_id IS NOT NULL',
        )
        .all();
      result.customerBalanceMicrorub = safeInteger(
        rows.reduce((sum, row) => sum + BigInt(row.balance_microrub), 0n),
      );
      result.customerReservedMicrorub = safeInteger(
        rows.reduce((sum, row) => sum + BigInt(row.reserved_microrub), 0n),
      );
    }
    return result;
  }
  return {
    available,
    getSettings: settings.getSettings,
    changeSettings: settings.changeSettings,
    organizationSettings: settings.organizationSettings,
    setOrganizationSettings: settings.setOrganizationSettings,
    changeOrganizationSettings: settings.setOrganizationSettings,
    getWallet,
    listHistory,
    adjustCredit,
    reserve: reservations.reserve,
    settle: reservations.settle,
    markOutbound: reservations.markOutbound,
    reservationReview: reservations.reservationReview,
    totals,
    monthlyProviderUsage: (service, month) => monthlyProviderUsage(ledger, service, month),
    statement: totals,
  };
}
module.exports = { createWalletStore };
