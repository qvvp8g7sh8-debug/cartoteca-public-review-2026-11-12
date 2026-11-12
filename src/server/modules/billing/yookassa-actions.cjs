// Explicit, durable-caller-only POST adapters. No direct fetch, retries or timers here.
function createYooKassaActions({
  request,
  receipt,
  receiptConfig,
  matches,
  amountKopecks,
  invalid,
  unavailable,
  PAYMENT_ID,
}) {
  const receiptId = /^(?:rt[-_])?[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  function input(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            'paymentId',
            'amountKopecks',
            'idempotencyKey',
            'receiptEmail',
            'description',
            'originalAmountKopecks',
          ].includes(key),
      ) ||
      !matches(value.paymentId, PAYMENT_ID) ||
      !matches(value.idempotencyKey, /^[a-f0-9-]{36}$/i) ||
      !Number.isSafeInteger(value.amountKopecks) ||
      value.amountKopecks < 1
    )
      throw invalid();
    return {
      value:
        BigInt(value.amountKopecks) / 100n +
        '.' +
        (BigInt(value.amountKopecks) % 100n).toString().padStart(2, '0'),
      currency: 'RUB',
    };
  }
  async function createRefund(value) {
    if (
      value.originalAmountKopecks !== undefined &&
      (!Number.isSafeInteger(value.originalAmountKopecks) ||
        value.originalAmountKopecks < value.amountKopecks)
    )
      throw invalid();
    const amount = input(value),
      payload = {
        payment_id: value.paymentId,
        amount,
        ...(receiptConfig.fiscalProvider === 'yookassa' &&
        value.originalAmountKopecks === value.amountKopecks
          ? {}
          : { receipt: receipt.makePayload(value.receiptEmail, amount) }),
      };
    const raw = await request('POST', null, payload, value.idempotencyKey, 'refunds');
    try {
      if (
        !matches(raw.id, PAYMENT_ID) ||
        raw.payment_id !== value.paymentId ||
        raw.amount?.currency !== 'RUB' ||
        amountKopecks(raw.amount.value) !== value.amountKopecks ||
        !['pending', 'succeeded', 'canceled'].includes(raw.status)
      )
        throw invalid();
      return {
        id: raw.id,
        paymentId: raw.payment_id,
        amountKopecks: value.amountKopecks,
        currency: 'RUB',
        status: raw.status,
        receiptRegistration: raw.receipt_registration ?? null,
      };
    } catch {
      throw unavailable(true);
    }
  }
  async function createClosingReceipt(value) {
    const amount = input(value);
    if (receiptConfig.paymentMode !== 'full_prepayment') throw invalid();
    const base = receipt.makePayload(value.receiptEmail, amount);
    const payload = {
      ...base,
      payment_id: value.paymentId,
      type: 'payment',
      send: true,
      items: base.items.map((item) => ({ ...item, payment_mode: 'full_payment' })),
      settlements: [{ type: 'prepayment', amount }],
    };
    const raw = await request('POST', null, payload, value.idempotencyKey, 'receipts');
    try {
      if (
        !matches(raw.id, receiptId) ||
        raw.payment_id !== value.paymentId ||
        raw.type !== 'payment' ||
        !['pending', 'succeeded', 'canceled'].includes(raw.status)
      )
        throw invalid();
      return {
        id: raw.id,
        paymentId: raw.payment_id,
        type: 'payment',
        status: raw.status,
        classification: 'prepayment_offset_observed',
        settledKopecks: value.amountKopecks,
      };
    } catch {
      throw unavailable(true);
    }
  }
  return { createRefund, createClosingReceipt };
}
module.exports = { createYooKassaActions };
