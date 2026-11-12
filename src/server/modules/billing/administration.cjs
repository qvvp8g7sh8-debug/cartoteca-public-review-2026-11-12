const { fail } = require('../../../shared/errors.cjs');
function createBillingAdministration(context, wallet, entitlements, packages, payments) {
  const read = require('./administration-read.cjs').createBillingReadModel(
    context,
    wallet,
    entitlements,
    packages,
    payments,
  );
  const { assertAdmin, view } = read;
  function moneyToKopecks(value) {
    const text = String(value).replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw fail(400, 'Укажите цену в рублях и копейках.');
    const [whole, part = ''] = text.split('.');
    const amount = BigInt(whole) * 100n + BigInt(part.padEnd(2, '0'));
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(400, 'Цена слишком велика.');
    return Number(amount);
  }
  function savePackage(actorId, input) {
    assertAdmin(actorId);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) =>
          ![
            'id',
            'title',
            'priceRub',
            'taskLimit',
            'serviceCode',
            'serviceTitle',
            'periodMonths',
            'quotaUnit',
            'receipt',
            'enabled',
            'expectedRevision',
            'reason',
            'requestId',
          ].includes(k),
      )
    )
      throw fail(400, 'Неверные поля пакета.');
    const { priceRub, ...fields } = input;
    packages.savePackage(actorId, { ...fields, priceKopecks: moneyToKopecks(priceRub) });
    return view(actorId);
  }
  function trial(actorId, input) {
    assertAdmin(actorId);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !['organizationId', 'packageId', 'reason', 'requestId'].includes(k),
      )
    )
      throw fail(400, 'Неверные поля пробного доступа.');
    const { organizationId, ...fields } = input;
    packages.grantTrial(actorId, { ...fields, orgId: organizationId });
    return view(actorId, { organizationId });
  }
  function paymentSettings(actorId, input) {
    assertAdmin(actorId);
    payments.adminSettings(actorId, input);
    return view(actorId);
  }
  return {
    view,
    summary: read.summary,
    organizations: read.organizations,
    orders: read.orders,
    package: savePackage,
    trial,
    'payment-settings': paymentSettings,
  };
}
module.exports = { createBillingAdministration };
