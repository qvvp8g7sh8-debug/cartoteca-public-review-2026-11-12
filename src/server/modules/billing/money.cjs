const { fail } = require('../../../shared/errors.cjs');
const MICRORUB_PER_RUB = 1000000;
const MAX_MARKUP_BPS = 1000000;
const MAX_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
function safeInteger(value, { signed = false } = {}) {
  const number =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  if (number === null || number > MAX_INTEGER || number < (signed ? -MAX_INTEGER : 0n))
    throw fail(400, 'Недопустимая денежная сумма.');
  return Number(number);
}
function rubToMicrorub(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
    throw fail(400, 'Укажите корректную сумму в рублях.');
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || text.length > 100) throw fail(400, 'Укажите неотрицательную сумму в рублях.');
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100)
    throw fail(400, 'Денежная сумма вне допустимого диапазона.');
  const digits = BigInt(match[1] + (match[2] || ''));
  const scale = 6 + exponent - (match[2] || '').length;
  const divisor = scale < 0 ? 10n ** BigInt(-scale) : 1n;
  // Upward rounding is conservative at the accounting unit, never at a whole kopeck.
  const result = scale < 0 ? (digits + divisor - 1n) / divisor : digits * 10n ** BigInt(scale);
  return safeInteger(result);
}
function markupBps(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MARKUP_BPS)
    throw fail(400, 'Укажите допустимый процент наценки.');
  return value;
}
function markedUp(cost, basisPoints) {
  return safeInteger(
    (BigInt(safeInteger(cost)) * BigInt(10000 + markupBps(basisPoints)) + 9999n) / 10000n,
  );
}
function addMoney(left, right, signed = false) {
  return safeInteger(
    BigInt(safeInteger(left, { signed: true })) + BigInt(safeInteger(right, { signed: true })),
    { signed },
  );
}
function rubFromMicrorub(value) {
  return safeInteger(value, { signed: true }) / MICRORUB_PER_RUB;
}
module.exports = {
  MICRORUB_PER_RUB,
  MAX_MARKUP_BPS,
  safeInteger,
  rubToMicrorub,
  rubFromMicrorub,
  markupBps,
  markedUp,
  addMoney,
};
