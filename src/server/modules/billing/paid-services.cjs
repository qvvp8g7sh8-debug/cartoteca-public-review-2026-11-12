const { createWalletStore } = require('./wallet-store.cjs');
const { createPackageStore } = require('./package-store.cjs');
const { createPaymentStore } = require('./payment-store.cjs');
const { createBillingEntitlements } = require('./entitlements.cjs');
const { createBillingAdministration } = require('./administration.cjs');
const { createBillingAudit } = require('./audit.cjs');
function createPaidServices(context) {
  context = { ...context, audit: createBillingAudit(context) };
  const wallet = createWalletStore(context),
    packages = createPackageStore(context);
  const payments = createPaymentStore(context, packages);
  const entitlements = createBillingEntitlements(context, wallet, packages, payments);
  return {
    ...entitlements,
    wallet,
    packages,
    payments,
    admin: createBillingAdministration(context, wallet, entitlements, packages, payments),
  };
}
module.exports = { createPaidServices };
