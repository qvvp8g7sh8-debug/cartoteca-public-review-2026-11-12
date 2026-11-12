const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminEmailRuntime } = require('../src/server/modules/admin/email-queue.cjs');
const { createSupportRuntime } = require('../src/server/modules/support/delivery.cjs');
const { createMaxRuntime } = require('../src/server/modules/notifications/max-runtime.cjs');

test('admin email finishes a known in-flight result but claims no new work after ownership expiry', async () => {
  let active = true,
    claims = 0;
  const results = [];
  const runtime = createAdminEmailRuntime({
    queue: {
      claim: () => (++claims, { payload: { email: 'synthetic@example.test' }, kind: 'test' }),
      allowed: () => true,
      finish: (_, status) => results.push(status),
    },
    canRun: () => active,
    sendMail: async () => {
      active = false;
    },
  });
  await runtime.tick();
  await runtime.tick();
  assert.equal(claims, 1);
  assert.deepEqual(results, ['sent']);
});

test('support does not claim messages when ownership expires during provider initialization', async () => {
  let active = true;
  const runtime = createSupportRuntime({
    store: { claim: () => assert.fail('No claims after expiry') },
    canRun: () => active,
    telegram: {
      initialize: async () => {
        active = false;
      },
      send: () => assert.fail('No send after expiry'),
    },
    email: () => assert.fail('No secondary send after expiry'),
  });
  await runtime.tick();
  await runtime.tick();
});

test('MAX still accepts public webhooks in a web worker without acquiring background work', async () => {
  let accepted = 0;
  const runtime = createMaxRuntime({
    inbox: {
      accept: () => (++accepted, { repeated: false }),
      acquire: () => assert.fail('No claim without process ownership'),
    },
    events: { authenticate() {}, normalize: () => ({ event: 'synthetic' }) },
    bot: {},
    identity: { botId: '123' },
    canRun: () => false,
  });
  assert.deepEqual(runtime.accept('synthetic', {}), { accepted: true, repeated: false });
  await runtime.tick();
  assert.equal(accepted, 1);
});

test('MAX rechecks ownership after pacing and does not start a provider request after expiry', async () => {
  let active = true,
    claims = 0;
  const runtime = createMaxRuntime({
    inbox: {
      acquire: () => true,
      renew: () => true,
      isCurrent: () => true,
      claim: () => (
        ++claims,
        {
          decoded: {
            event: { callback: { user: { user_id: '5' } } },
            result: { callbackId: 'callback', notification: 'synthetic' },
          },
        }
      ),
    },
    events: {},
    bot: { answer: () => assert.fail('No provider request after expiry') },
    identity: { botId: '123' },
    pacing: {
      acquire: async () => {
        active = false;
        return true;
      },
    },
    canRun: () => active,
    staffDelivery: { tick: () => assert.fail('No staff claims after expiry') },
  });
  await runtime.tick();
  assert.equal(claims, 1);
});
