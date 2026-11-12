const { fail } = require('../../../shared/errors.cjs');
// Explicit seller fiscal configuration, independently of HTTP transport.
// yookassa.ru/developers/payment-acceptance/receipts/54fz/{yoomoney,other-services}/parameters-values
function invalid() {
  return Object.assign(fail(400, 'Проверьте данные подключения, платежа и чека.'), {
    code: 'PAYMENT_INPUT_INVALID',
    outcomeUnknown: false,
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
function receiptOptions(config) {
  const fields = [
    'fiscalProvider',
    'purchaseModel',
    'paymentMode',
    'vatCode',
    'taxSystemCode',
    'paymentSubject',
    'description',
  ];
  if (
    !object(config) ||
    Object.keys(config).some((key) => !fields.includes(key)) ||
    !['external', 'yookassa'].includes(config.fiscalProvider) ||
    !Number.isInteger(config.vatCode) ||
    config.vatCode < 1 ||
    config.vatCode > 12 ||
    !Number.isInteger(config.taxSystemCode) ||
    config.taxSystemCode < 1 ||
    config.taxSystemCode > 6 ||
    !['payment', 'service', 'property_right', 'intellectual_activity'].includes(
      config.paymentSubject,
    ) ||
    typeof config.description !== 'string' ||
    !config.description.trim() ||
    config.description.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(config.description)
  )
    throw invalid();
  const advance =
    config.purchaseModel === 'advance' &&
    config.paymentMode === 'advance' &&
    config.fiscalProvider === 'external';
  const knownPackage =
    config.purchaseModel === 'package' &&
    ['full_payment', 'full_prepayment'].includes(config.paymentMode);
  if (!advance && !knownPackage) throw invalid();
  // Fiscal configuration is explicit. Built-in YooKassa receipts reject advance;
  // external KKT and package classification require a separately agreed seller setup.
  return Object.freeze({ ...config });
}
function email(value) {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !matches(value, /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/)
  )
    throw invalid();
  const [local, domain] = value.split('@');
  if (
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    domain.split('.').some((part) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))
  )
    throw invalid();
  return value;
}

function createYooKassaReceipt(config) {
  const options = receiptOptions(config);
  function makePayload(receiptEmail, amount) {
    return {
      customer: { email: email(receiptEmail) },
      tax_system_code: options.taxSystemCode,
      internet: 'true',
      items: [
        {
          description: options.description,
          quantity: '1.000',
          amount,
          vat_code: options.vatCode,
          payment_mode: options.paymentMode,
          payment_subject: options.paymentSubject,
          measure: 'piece',
        },
      ],
    };
  }
  return Object.freeze({ description: options.description, makePayload });
}
module.exports = { createYooKassaReceipt };
