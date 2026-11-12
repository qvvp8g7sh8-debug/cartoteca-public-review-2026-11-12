const nodeCrypto = require('node:crypto');
const { fail: defaultFail } = require('../../../shared/errors.cjs');
const { walletTables } = require('./wallet-schema.cjs');
const { safeInteger, addMoney, rubFromMicrorub } = require('./money.cjs');
function createWalletLedger(context) {
  const { db, seal, open, transaction: ordinaryTransaction, audit = () => {} } = context;
  // Only the closed native accounting capability may reuse its caller TX.
  const transaction = (callback) => {
    if (db.transactionIntent !== 'ACCOUNTING' || !db.accountingCapability)
      return ordinaryTransaction(callback);
    const result = callback();
    if (result && typeof result.then === 'function') throw Error('Async wallet callback denied');
    return result;
  };
  const fail = context.fail || defaultFail;
  const crypto = context.crypto || nodeCrypto;
  const id = context.id || crypto.randomUUID;
  let prepared;
  function available() {
    if (prepared === undefined) {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'billing_%'")
        .all();
      prepared = walletTables.every((name) => rows.some((row) => row.name === name));
    }
    return prepared;
  }
  function ready() {
    if (!available()) throw fail(503, 'Денежный учёт ещё не подготовлен.');
  }
  function identifier(value, label = 'идентификатор') {
    if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u001f]/.test(value))
      throw fail(400, 'Некорректный ' + label + '.');
    return value;
  }
  function organization(organizationId) {
    identifier(organizationId, 'кабинет');
    if (!db.prepare('SELECT 1 FROM organizations WHERE id=?').get(organizationId))
      throw fail(404, 'Кабинет не найден.');
  }
  function assertAdmin(actorId) {
    identifier(actorId, 'администратор');
    if (
      !db
        .prepare("SELECT 1 FROM accounts WHERE id=? AND global_admin=1 AND status='active'")
        .get(actorId)
    )
      throw fail(403, 'Денежные настройки доступны только главному администратору.');
  }
  function reasonText(value) {
    if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 500)
      throw fail(400, 'Укажите причину действия (от 3 до 500 символов).');
    return value.trim();
  }
  const walletId = (organizationId) =>
    organizationId === null ? 'platform' : 'org:' + organizationId;
  function wallet(organizationId, ensure = false) {
    if (organizationId !== null) organization(organizationId);
    const key = walletId(organizationId);
    if (ensure)
      db.prepare(
        'INSERT INTO billing_wallets(id,organization_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING',
      ).run(key, organizationId);
    return (
      db.prepare('SELECT * FROM billing_wallets WHERE id=?').get(key) || {
        id: key,
        organization_id: organizationId,
        balance_microrub: 0,
        reserved_microrub: 0,
        provider_cost_microrub: 0,
        charged_microrub: 0,
        unpaid_charge_microrub: 0,
        revision: 0,
        changed_at: 0,
      }
    );
  }
  function values(row) {
    const balance = safeInteger(row.balance_microrub, { signed: true });
    const reserved = safeInteger(row.reserved_microrub);
    return {
      balanceMicrorub: balance,
      reservedMicrorub: reserved,
      availableMicrorub: addMoney(balance, -reserved, true),
      providerCostMicrorub: safeInteger(row.provider_cost_microrub),
      chargedMicrorub: safeInteger(row.charged_microrub),
      unpaidChargeMicrorub: safeInteger(row.unpaid_charge_microrub),
      balanceRub: rubFromMicrorub(balance),
      reservedRub: rubFromMicrorub(reserved),
      providerCostRub: rubFromMicrorub(row.provider_cost_microrub),
      chargedRub: rubFromMicrorub(row.charged_microrub),
      unpaidChargeRub: rubFromMicrorub(row.unpaid_charge_microrub),
      reconciliationRequired: row.unpaid_charge_microrub > 0,
    };
  }
  function saveWallet(row) {
    // Enforce bounded integer projections before SQLite can coerce an overflowing sum to REAL.
    const view = values(row);
    if (row.organization_id !== null && (view.balanceMicrorub < 0 || view.availableMicrorub < 0))
      throw fail(409, 'Нарушен резерв денежного баланса.');
    db.prepare(
      `UPDATE billing_wallets SET balance_microrub=?,reserved_microrub=?,
      provider_cost_microrub=?,charged_microrub=?,unpaid_charge_microrub=?,revision=revision+1,changed_at=? WHERE id=?`,
    ).run(
      view.balanceMicrorub,
      view.reservedMicrorub,
      view.providerCostMicrorub,
      view.chargedMicrorub,
      view.unpaidChargeMicrorub,
      Date.now(),
      row.id,
    );
  }
  const fingerprint = (value) =>
    crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function entry({
    row,
    organizationId,
    reservationId = null,
    kind,
    service = null,
    amount,
    actorId = null,
    key,
    fingerprint: hash,
    detail,
  }) {
    const entryId = id();
    db.prepare(
      `INSERT INTO billing_entries(id,wallet_id,organization_id,reservation_id,kind,service,
      amount_microrub,balance_after_microrub,actor_id,idempotency_key,fingerprint,created_at,value)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entryId,
      row.id,
      organizationId,
      reservationId,
      kind,
      service,
      safeInteger(amount, { signed: true }),
      safeInteger(row.balance_microrub, { signed: true }),
      actorId,
      key,
      hash,
      Date.now(),
      seal(detail),
    );
    return entryId;
  }
  function recordOperation(actorId, input, body, action) {
    identifier(input.requestId, 'номер операции');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw fail(400, 'Нужна актуальная версия денежных настроек.');
    const reason = reasonText(input.reason);
    const hash = fingerprint(body);
    return transaction(() => {
      assertAdmin(actorId);
      const previous = db
        .prepare(
          'SELECT fingerprint,value FROM billing_operations WHERE actor_id=? AND request_id=?',
        )
        .get(actorId, input.requestId);
      if (previous) {
        if (previous.fingerprint !== hash)
          throw fail(409, 'Номер операции уже использован для другого изменения.');
        return { ...open(previous.value), replayed: true };
      }
      const result = action(reason);
      db.prepare('INSERT INTO billing_operations VALUES(?,?,?,?,?)').run(
        actorId,
        input.requestId,
        hash,
        seal(result),
        Date.now(),
      );
      return result;
    });
  }
  return {
    db,
    seal,
    open,
    transaction,
    audit,
    fail,
    id,
    available,
    ready,
    identifier,
    organization,
    assertAdmin,
    reasonText,
    wallet,
    walletId,
    values,
    saveWallet,
    fingerprint,
    entry,
    recordOperation,
  };
}
module.exports = { createWalletLedger };
