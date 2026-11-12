const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const boolean = (value) => typeof value === 'boolean';
const text = (max) => (value) =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const choices =
  (...items) =>
  (value) =>
    items.includes(value);
const nullable = (check) => (value) => value === null || check(value);
const service = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const packageFields = {
  receiptPolicy: text(1024),
  serviceCode: service,
  serviceTitle: text(120),
  periodMonths: integer,
  quotaUnit: choices('tasks', 'units', 'access'),
  title: text(120),
  priceKopecks: integer,
  taskLimit: integer,
  enabled: boolean,
  version: integer,
};
const grantFields = {
  serviceCode: service,
  periodMonths: integer,
  quotaUnit: choices('tasks', 'units', 'access'),
  grantId: (value) => typeof value === 'string' && uuid.test(value),
  packageId: (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value),
  packageVersion: integer,
  title: text(120),
  source: choices('paid', 'trial'),
  sourceOrderId: nullable((value) => typeof value === 'string' && uuid.test(value)),
  priceKopecks: integer,
  taskLimit: integer,
  startsAt: integer,
  endsAt: integer,
  testMode: boolean,
};
const connectionFields = {
  service,
  enabled: boolean,
  revision: integer,
};
const settingsFields = {
  configured: boolean,
  testMode: boolean,
  revision: integer,
  fiscalProvider: choices('', 'external', 'yookassa'),
  purchaseModel: choices('package'),
  paymentMode: choices('', 'full_payment', 'full_prepayment'),
  vatCode: nullable((value) => integer(value) && value >= 1 && value <= 12),
  taxSystemCode: nullable((value) => integer(value) && value >= 1 && value <= 6),
  paymentSubject: choices('', 'payment', 'service', 'property_right', 'intellectual_activity'),
  description: text(128),
};
const reviewFields = {
  action: choices(
    'reconcile',
    'retry_create',
    'request_refund_review',
    'request_receipt_review',
    'check_refund',
    'check_receipt',
  ),
  resultCode: choices(
    'safe_retry_disabled',
    'merchant_unavailable',
    'payment_id_required',
    'payment_id_mismatch',
    'restored_requires_reconcile',
    'provider_unavailable',
    'payment_mismatch',
    'reference_mismatch',
    'payment_not_confirmed',
    'order_changed',
    'refund_review_required',
    'receipt_review_required',
    'paid_access_blocked',
    'provider_verified',
    'reporting_unavailable',
  ),
  revision: integer,
  paymentState: choices(
    'creating',
    'pending',
    'uncertain',
    'paid',
    'canceled',
    'rejected',
    'review',
  ),
  paidConfirmed: boolean,
  packageIssued: boolean,
  reconciliationStatus: choices('required', 'not_required', 'blocked', 'checked'),
  refundStatus: choices('review_required', 'pending', 'observed_succeeded', 'not_requested'),
  closingReceiptStatus: choices(
    'pending',
    'succeeded',
    'canceled',
    'review_required',
    'not_checked',
  ),
  knownRefundedKopecks: integer,
};
const billingAuditSchemas = Object.freeze({
  billing_financial_action: {
    targetType: 'billing_payment',
    fields: {
      kind: choices('refund', 'receipt'),
      status: choices(
        'creating',
        'pending',
        'uncertain',
        'succeeded',
        'canceled',
        'rejected',
        'review',
      ),
      amountKopecks: integer,
      serviceCode: service,
    },
  },
  billing_package_saved: { targetType: 'billing_package', fields: packageFields },
  billing_package_trial_granted: { targetType: 'billing_package', fields: grantFields },
  billing_package_paid_granted: { targetType: 'billing_package', fields: grantFields },
  billing_service_connected: { targetType: 'billing_connection', fields: connectionFields },
  billing_service_disconnected: { targetType: 'billing_connection', fields: connectionFields },
  billing_payment_settings_changed: { targetType: 'billing_settings', fields: settingsFields },
  billing_payment_review: { targetType: 'billing_payment', fields: reviewFields },
});
function billingAuditTarget(event, value) {
  if (typeof value !== 'string') return null;
  if (event === 'billing_payment_settings_changed')
    return value === 'payment-settings' ? value : null;
  if (event === 'billing_package_saved')
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null;
  if (event === 'billing_service_connected' || event === 'billing_service_disconnected')
    return uuid.test(value.split(':')[0]) &&
      service(value.split(':')[1]) &&
      value.split(':').length === 2
      ? value
      : null;
  return uuid.test(value) ? value : null;
}
function billingAuditDetail(event, input = {}) {
  const schema = billingAuditSchemas[event];
  if (!schema) return null;
  const snapshot = (value) =>
    Object.fromEntries(
      Object.entries(schema.fields)
        .filter(([key, check]) => value && Object.hasOwn(value, key) && check(value[key]))
        .map(([key]) => [key, value[key]]),
    );
  return {
    reason: typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '',
    before: snapshot(input.before),
    after: snapshot(input.after),
    ...(typeof input.operationId === 'string' && uuid.test(input.operationId)
      ? { operationId: input.operationId }
      : {}),
  };
}
function createBillingAudit({ db, seal, audit = () => {} }) {
  return function record(event, actorId, organizationId, input = {}) {
    const schema = billingAuditSchemas[event];
    if (!schema) return audit(event, actorId, organizationId, input);
    const detail = billingAuditDetail(event, input),
      targetId = billingAuditTarget(event, input.targetId);
    const id = audit(event, actorId, organizationId, {
      version: 1,
      targetType: schema.targetType,
      targetId,
      fields: Object.keys(detail.after),
    });
    if (
      Number.isSafeInteger(id) &&
      id > 0 &&
      typeof seal === 'function' &&
      db
        ?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_audit_details'")
        .get()
    )
      db.prepare('INSERT INTO admin_audit_details(audit_id,value) VALUES(?,?)').run(
        id,
        seal(detail),
      );
    return id;
  };
}
module.exports = {
  billingAuditSchemas,
  billingAuditDetail,
  billingAuditTarget,
  createBillingAudit,
};
