const crypto = require('node:crypto');
const { createBillingBrowserFixture } = require('./billing-browser-fixture.cjs');
async function createBillingCompletionFixture() {
  const f = await createBillingBrowserFixture();
  try {
    const { db, open, seal } = f.database;
    const packageId = 'synthetic-completion';
    f.platform.billing.admin.package(
      f.admin.accountId,
      f.command({
        id: packageId,
        title: 'Синтетический пакет для проверки',
        priceRub: '9.90',
        taskLimit: 3,
        enabled: true,
        expectedRevision: 0,
      }),
    );
    const organization = open(
      db.prepare('SELECT value FROM organizations WHERE id=?').get(f.owner.organizationId).value,
    );
    const limits = db
      .prepare('SELECT limits FROM subscriptions WHERE organization_id=?')
      .get(f.owner.organizationId).limits;
    const clock = Date.now();
    // Synthetic directory rows deliberately exceed one financial page.
    for (let index = 0; index < 24; index++) {
      const id = crypto.randomUUID();
      db.prepare(
        'INSERT INTO organizations(id,value,slug,status,created_at) VALUES(?,?,?,?,?)',
      ).run(
        id,
        seal({ ...organization, name: 'Синтетический кабинет ' + (index + 1) }),
        'synthetic-completion-' + index,
        'active',
        clock + index + 1,
      );
      db.prepare(
        'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at) VALUES(?,?,?,?,?)',
      ).run(id, 'free', 'active', limits, clock);
    }
    for (const [org, cost] of [
      [null, 12000000],
      [f.owner.organizationId, 3750000],
      [f.other.organizationId, 8250000],
    ])
      db.prepare(
        'INSERT INTO billing_wallets(id,organization_id,provider_cost_microrub) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET provider_cost_microrub=excluded.provider_cost_microrub',
      ).run(org === null ? 'platform' : 'org:' + org, org, cost);
    const history = [];
    function order(index, state, owner) {
      const id = crypto.randomUUID(),
        providerId = state === 'canceled' ? crypto.randomUUID() : null;
      const at = clock - 1000000 - index * 1000;
      const snapshot = {
        id,
        organizationId: owner.organizationId,
        accountId: owner.accountId,
        packageId,
        packageVersion: 1,
        title: 'Синтетический пакет для проверки',
        priceKopecks: 990,
        taskLimit: 3,
        createdAt: at,
      };
      db.prepare(
        `INSERT INTO billing_payment_orders(id,organization_id,account_id,request_id,package_id,price_kopecks,state,
        provider_payment_id,provider_status,config_revision,shop_id,test_mode,created_at,changed_at,value)
        VALUES(?,?,?,?,?,?,?,?,?,1,'synthetic',1,?,?,?)`,
      ).run(
        id,
        owner.organizationId,
        owner.accountId,
        crypto.randomUUID(),
        packageId,
        990,
        state,
        providerId,
        providerId ? 'canceled' : null,
        at,
        at,
        seal({
          order: snapshot,
          seller: { revision: 1, shopId: 'synthetic', testMode: true },
          receiptEmail: null,
          confirmationUrl: null,
          revision: 1,
        }),
      );
      return { id, providerId };
    }
    // More than a bounded attention scan: zero matches must still offer continuation.
    for (let index = 0; index < 205; index++) history.push(order(index, 'canceled', f.owner));
    const attention = order(205, 'review', f.other);
    return { ...f, packageId, history, attention };
  } catch (error) {
    await f.close();
    throw error;
  }
}
module.exports = { createBillingCompletionFixture };
