const { fail } = require('../../../shared/errors.cjs');
const { createYooKassaReceipt } = require('./yookassa-receipt.cjs');
const { createYooKassaReporting } = require('./yookassa-reporting.cjs');
// API contracts: yookassa.ru/developers/using-api/{interaction-format,webhooks}.
// Fiscal modes: /developers/payment-acceptance/receipts/54fz/{yoomoney,other-services}/parameters-values.
const BASE = 'https://api.yookassa.ru/v3/payments';
const TIMEOUT_MS = 12000;
const MAX_BODY = 64 * 1024;
const PAYMENT_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,120}$/;
const STATES = new Set(['pending', 'waiting_for_capture', 'succeeded', 'canceled']);
const RECEIPT_STATES = new Set(['pending', 'succeeded', 'canceled']);

function invalid() {
  return Object.assign(fail(400, 'Проверьте данные подключения, платежа и чека.'), {
    code: 'PAYMENT_INPUT_INVALID',
    outcomeUnknown: false,
  });
}
function unavailable(unknown = false) {
  return Object.assign(fail(502, 'Не удалось подтвердить результат операции в ЮKassa.'), {
    code: unknown ? 'PAYMENT_OUTCOME_UNKNOWN' : 'PAYMENT_PROVIDER_UNAVAILABLE',
    outcomeUnknown: unknown,
  });
}
function matches(value, pattern) {
  return (
    typeof value === 'string' &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value) &&
    pattern.test(value)
  );
}
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function trustedUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f]/u.test(value))
    throw invalid();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (origin && url.origin !== origin)
  )
    throw invalid();
  return url;
}
function moneyString(kopecks) {
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) throw invalid();
  const value = BigInt(kopecks);
  return String(value / 100n) + '.' + String(value % 100n).padStart(2, '0');
}
function amountKopecks(value) {
  if (typeof value !== 'string' || !matches(value, /^(?:0|[1-9]\d{0,13})\.\d{2}$/)) throw invalid();
  const [rubles, fraction] = value.split('.');
  const amount = BigInt(rubles) * 100n + BigInt(fraction);
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(amount);
}
function confirmationUrl(value) {
  const url = trustedUrl(value);
  // Redirect destinations are returned only, never fetched. This hosted checkout
  // origin/path is documented by YooKassa; no arbitrary provider URL is accepted.
  if (
    url.hostname !== 'yoomoney.ru' ||
    url.port ||
    url.hash ||
    (!url.pathname.startsWith('/checkout/payments/') &&
      url.pathname !== '/api-pages/v2/payment-confirm/epl')
  )
    throw invalid();
  return url.href;
}
function paymentDto(payment, shopId, expectedId) {
  if (
    !object(payment) ||
    !matches(payment.id, PAYMENT_ID) ||
    (expectedId && payment.id !== expectedId) ||
    !STATES.has(payment.status) ||
    typeof payment.paid !== 'boolean' ||
    typeof payment.test !== 'boolean' ||
    payment.amount?.currency !== 'RUB' ||
    String(payment.recipient?.account_id) !== shopId ||
    !object(payment.metadata) ||
    typeof payment.metadata.checkoutId !== 'string' ||
    !matches(payment.metadata.checkoutId, LOCAL_ID) ||
    typeof payment.metadata.organizationId !== 'string' ||
    !matches(payment.metadata.organizationId, LOCAL_ID) ||
    (payment.status === 'succeeded' && payment.paid !== true) ||
    (payment.receipt_registration != null && !RECEIPT_STATES.has(payment.receipt_registration))
  )
    throw invalid();
  let redirect = null;
  if (payment.confirmation != null) {
    if (payment.confirmation.type !== 'redirect') throw invalid();
    if (payment.confirmation.confirmation_url != null)
      redirect = confirmationUrl(payment.confirmation.confirmation_url);
    else if (payment.status === 'pending') throw invalid();
  }
  return {
    provider: 'yookassa',
    paymentId: payment.id,
    status: payment.status,
    succeeded: payment.status === 'succeeded' && payment.paid === true,
    amountKopecks: amountKopecks(payment.amount.value),
    currency: 'RUB',
    metadata: {
      checkoutId: payment.metadata.checkoutId,
      organizationId: payment.metadata.organizationId,
    },
    receiptRegistration: payment.receipt_registration ?? null,
    confirmationUrl: redirect,
    test: payment.test,
  };
}
async function readBounded(response, wait) {
  if (!response.body?.getReader) throw unavailable();
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await wait(reader.read());
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) throw unavailable();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  }
}
function createYooKassaProvider({
  shopId,
  secretKey,
  fetchImpl = globalThis.fetch,
  returnOrigin,
  receiptConfig,
}) {
  if (
    typeof shopId !== 'string' ||
    !matches(shopId, /^\d{1,32}$/) ||
    typeof secretKey !== 'string' ||
    !matches(secretKey, /^[!-~]{12,512}$/) ||
    typeof fetchImpl !== 'function'
  )
    throw invalid();
  const origin = trustedUrl(returnOrigin);
  if (origin.pathname !== '/' || origin.search || origin.hash) throw invalid();
  const receipt = createYooKassaReceipt(receiptConfig);
  const authorization = 'Basic ' + Buffer.from(shopId + ':' + secretKey).toString('base64');
  async function request(method, paymentId, payload, idempotencyKey, resource = 'payments') {
    if (!['payments', 'refunds', 'receipts'].includes(resource)) throw invalid();
    const controller = new AbortController();
    let timer,
      response,
      rejected = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(unavailable(method === 'POST'));
      }, TIMEOUT_MS);
    });
    const wait = (promise) => Promise.race([promise, timeout]);
    try {
      response = await wait(
        fetchImpl(BASE.replace(/payments$/, resource) + (paymentId ? '/' + paymentId : ''), {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Idempotence-Key': idempotencyKey }
              : {}),
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        }),
      );
      if (!response.ok) {
        rejected =
          response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
        throw unavailable(method === 'POST' && !rejected);
      }
      return await readBounded(response, wait);
    } catch {
      // Do not retain raw provider errors, payloads, headers or fetch error causes.
      // A failed POST can have created a payment. The durable caller must reconcile
      // it or retry the same request/key within YooKassa's 24-hour idempotency window.
      throw unavailable(method === 'POST' && !rejected);
    } finally {
      clearTimeout(timer);
      try {
        Promise.resolve(response?.body?.cancel?.()).catch(() => {});
      } catch {}
    }
  }
  async function readPayment(paymentId) {
    if (typeof paymentId !== 'string' || !matches(paymentId, PAYMENT_ID)) throw invalid();
    const payment = await request('GET', paymentId);
    try {
      return paymentDto(payment, shopId, paymentId);
    } catch {
      throw unavailable();
    }
  }
  async function createCheckout(input) {
    if (
      !object(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'organizationId',
            'amountKopecks',
            'idempotencyKey',
            'returnUrl',
            'receiptEmail',
            'checkoutId',
          ].includes(key),
      ) ||
      typeof input.organizationId !== 'string' ||
      !matches(input.organizationId, LOCAL_ID) ||
      typeof input.checkoutId !== 'string' ||
      !matches(input.checkoutId, LOCAL_ID) ||
      typeof input.idempotencyKey !== 'string' ||
      !matches(input.idempotencyKey, /^[A-Za-z0-9_.:-]{1,64}$/)
    )
      throw invalid();
    const amount = { value: moneyString(input.amountKopecks), currency: 'RUB' };
    const payload = {
      amount,
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: trustedUrl(input.returnUrl, origin.origin).href,
      },
      description: receipt.description,
      metadata: { checkoutId: input.checkoutId, organizationId: input.organizationId },
      receipt: receipt.makePayload(input.receiptEmail, amount),
    };
    const payment = await request('POST', null, payload, input.idempotencyKey);
    try {
      const dto = paymentDto(payment, shopId);
      if (
        dto.amountKopecks !== input.amountKopecks ||
        dto.metadata.checkoutId !== input.checkoutId ||
        dto.metadata.organizationId !== input.organizationId ||
        (dto.status === 'pending' && !dto.confirmationUrl)
      )
        throw invalid();
      return dto;
    } catch {
      throw unavailable(true);
    }
  }
  async function verifyWebhook(body, headers) {
    // Headers are not treated as a signature. Authenticate the current payment
    // through the fixed merchant API; never fund from notification amounts/status.
    void headers;
    let event;
    try {
      const raw =
        typeof body === 'string'
          ? body
          : Buffer.isBuffer(body)
            ? body.toString('utf8')
            : JSON.stringify(body);
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BODY) throw invalid();
      event = JSON.parse(raw);
    } catch {
      throw invalid();
    }
    if (
      !object(event) ||
      event.type !== 'notification' ||
      !['payment.succeeded', 'payment.waiting_for_capture', 'payment.canceled'].includes(
        event.event,
      ) ||
      !object(event.object) ||
      typeof event.object.id !== 'string' ||
      !matches(event.object.id, PAYMENT_ID)
    )
      throw invalid();
    // The ledger caller MUST match paymentId, checkoutId, organizationId, amount,
    // currency and test/live mode to its already persisted local checkout before crediting.
    return readPayment(event.object.id);
  }
  const reporting = createYooKassaReporting({
    request,
    matches,
    object,
    amountKopecks,
    invalid,
    unavailable,
    PAYMENT_ID,
    RECEIPT_STATES,
  });
  const actions = require('./yookassa-actions.cjs').createYooKassaActions({
    request,
    receipt,
    receiptConfig,
    matches,
    amountKopecks,
    invalid,
    unavailable,
    PAYMENT_ID,
  });
  return Object.freeze({ createCheckout, readPayment, verifyWebhook, ...reporting, ...actions });
}
module.exports = { createYooKassaProvider };
