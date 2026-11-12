const { randomUUID } = require('node:crypto');
const { assistantBoundariesFixture } = require('./assistant-boundaries-fixture.cjs');
const { dialogueFixture } = require('./assistant-dialogue-fixture.cjs');
const { createAssistant } = require('../../src/server/modules/assistant/service.cjs');
const { createPackageStore } = require('../../src/server/modules/billing/package-store.cjs');
const { createWalletStore } = require('../../src/server/modules/billing/wallet-store.cjs');
const { packageSchema } = require('../../src/server/modules/billing/package-schema.cjs');
const { walletSchema } = require('../../src/server/modules/billing/wallet-schema.cjs');
const {
  serviceConnectionSchema,
} = require('../../src/server/modules/billing/entitlements-schema.cjs');
async function createPaidBookingFixture() {
  const fixture = await assistantBoundariesFixture(null);
  try {
    fixture.settings({
      providers: { tts: { provider: 'timeweb', model: 'openai/gpt-4o-mini-tts', voice: 'alloy' } },
      timewebApiKey: 'synthetic-key-not-provider',
    });
    const table = (name) =>
      fixture.database.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    for (const [name, schema] of [
      ['billing_service_connections', serviceConnectionSchema],
      ['billing_package_definitions', packageSchema],
      ['billing_settings', walletSchema],
    ])
      if (!table(name)) fixture.database.db.exec(schema);
    const packages = createPackageStore(fixture.database),
      wallet = createWalletStore(fixture.database);
    packages.savePackage(fixture.actor, {
      id: 'synthetic-booking-close',
      title: 'Synthetic booking close',
      priceKopecks: 1000,
      taskLimit: 10,
      enabled: true,
      expectedRevision: 0,
      requestId: randomUUID(),
      reason: 'Synthetic isolated control',
    });
    packages.grantTrial(fixture.actor, {
      orgId: fixture.owner.organizationId,
      packageId: 'synthetic-booking-close',
      requestId: randomUUID(),
      reason: 'Synthetic isolated control',
    });
    const synthetic = dialogueFixture(),
      current = fixture.current('owner');
    synthetic.patients.splice(0, synthetic.patients.length, {
      id: randomUUID(),
      firstName: 'Диана',
      lastName: 'Неволина',
      name: 'Диана Неволина',
      createdBy: current.accountId,
      appointments: [],
      phone: '',
    });
    synthetic.members[0].accountId = current.accountId;
    synthetic.services[0].staffId = current.accountId;
    synthetic.changed();
    const clinic = synthetic.c.tenantStore();
    let pcmCalls = 0;
    const context = {
      ...fixture.context('owner'),
      platform: { ...fixture.store, ...synthetic.c.platform },
      tenantStore: () => clinic,
    };
    const api = createAssistant(
      {
        ...fixture.database,
        organizationTimeZone: fixture.store.organizationTimeZone,
        billing: {
          packages,
          wallet,
          hasServiceConnection: () => true,
          isServiceEnabled: () => true,
        },
      },
      {
        directory: fixture.platformDirectory,
        ...fixture.ports,
        fetchImpl: async (_url, options) => {
          pcmCalls++;
          const body = JSON.parse(options.body);
          if (body.response_format !== 'pcm') throw Error('PCM_ONLY');
          return new Response(Buffer.alloc(4800), { headers: { 'content-type': 'audio/pcm' } });
        },
      },
    );
    const scope = api.access(current);
    return {
      api,
      scope,
      context,
      fixture,
      synthetic,
      clinic,
      packages,
      wallet,
      pcmCalls: () => pcmCalls,
      close: () => fixture.close(),
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
module.exports = { createPaidBookingFixture };
