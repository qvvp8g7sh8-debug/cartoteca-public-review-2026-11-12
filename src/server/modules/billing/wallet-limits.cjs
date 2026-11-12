const { safeInteger, rubToMicrorub } = require('./money.cjs');
function requireWalletLimits(ledger, input, amount, now = Date.now()) {
  if (input.limits === undefined) return;
  const { db, fail } = ledger;
  const limits = input.limits;
  if (
    !limits ||
    !Number.isSafeInteger(limits.dailyRequests) ||
    limits.dailyRequests < 1 ||
    !Number.isFinite(limits.monthlyBudgetRub) ||
    limits.monthlyBudgetRub < 0
  )
    throw fail(400, 'Некорректные расчётные ограничения помощника.');
  const today = new Date(now).toISOString().slice(0, 10);
  const dayStart = Date.parse(today + 'T00:00:00.000Z');
  const attempts = db
    .prepare(
      `SELECT count(*) n FROM billing_reservations
    WHERE organization_id=? AND account_id=? AND service=? AND created_at>=?`,
    )
    .get(input.organizationId, input.accountId, input.service, dayStart).n;
  const legacyAttempts = safeInteger(input.legacyDailyRequests ?? 0);
  if (attempts + legacyAttempts >= limits.dailyRequests)
    throw fail(429, 'Дневной лимит обращений к помощнику исчерпан.');
  if (amount === 0) return;
  const monthStart = Date.parse(today.slice(0, 7) + '-01T00:00:00.000Z');
  const rows = db
    .prepare(
      `SELECT state,provider_quote_microrub,provider_actual_microrub
    FROM billing_reservations WHERE service=? AND created_at>=?`,
    )
    .all(input.service, monthStart);
  const spent = rows.reduce(
    (sum, row) =>
      sum +
      BigInt(
        safeInteger(
          row.state === 'pending' ? row.provider_quote_microrub : row.provider_actual_microrub,
        ),
      ),
    0n,
  );
  const legacy = rubToMicrorub(input.legacyMonthlyRub ?? 0);
  if (spent + BigInt(legacy) + BigInt(amount) > BigInt(rubToMicrorub(limits.monthlyBudgetRub)))
    throw fail(429, 'Недостаточно расчётного бюджета для следующего обращения.');
}
function pricingSnapshot(input, fail) {
  if (input === undefined) return {};
  if (
    !input ||
    typeof input !== 'object' ||
    !Number.isSafeInteger(input.assistantRevision) ||
    input.assistantRevision < 0 ||
    typeof input.model !== 'string' ||
    input.model.length > 160 ||
    !Number.isFinite(input.inputRubPerMillion) ||
    input.inputRubPerMillion <= 0 ||
    !Number.isFinite(input.outputRubPerMillion) ||
    input.outputRubPerMillion <= 0
  )
    throw fail(400, 'Некорректный снимок расчётного тарифа.');
  return {
    pricing: {
      assistantRevision: input.assistantRevision,
      model: input.model,
      inputRubPerMillion: input.inputRubPerMillion,
      outputRubPerMillion: input.outputRubPerMillion,
    },
  };
}
function monthlyProviderUsage(
  ledger,
  service = 'voice-assistant',
  month = new Date().toISOString().slice(0, 7),
) {
  ledger.ready();
  ledger.identifier(service, 'платная услуга');
  if (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month))
    throw ledger.fail(400, 'Некорректный месяц расходов.');
  const start = Date.parse(month + '-01T00:00:00.000Z');
  const end = Date.parse(
    Number(month.slice(0, 4)) +
      (month.endsWith('-12') ? 1 : 0) +
      '-' +
      String((Number(month.slice(5)) % 12) + 1).padStart(2, '0') +
      '-01T00:00:00.000Z',
  );
  const rows = ledger.db
    .prepare(
      'SELECT state,provider_quote_microrub,provider_actual_microrub FROM billing_reservations WHERE service=? AND created_at>=? AND created_at<?',
    )
    .all(service, start, end);
  let spent = 0n,
    reserved = 0n;
  for (const row of rows) {
    if (row.state === 'pending') reserved += BigInt(safeInteger(row.provider_quote_microrub));
    else spent += BigInt(safeInteger(row.provider_actual_microrub));
  }
  return { month, spentMicrorub: safeInteger(spent), reservedMicrorub: safeInteger(reserved) };
}
module.exports = { requireWalletLimits, pricingSnapshot, monthlyProviderUsage };
