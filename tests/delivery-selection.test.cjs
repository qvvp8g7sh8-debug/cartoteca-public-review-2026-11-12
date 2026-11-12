const test = require('node:test');
const assert = require('node:assert/strict');
const {
  selectDelivery,
  deliveryPreference,
} = require('../src/server/modules/notifications/delivery-selection.cjs');

const ready = () => ({ configured: true, connected: true, enabled: true, linked: true });

test('one available channel is selected without a fabricated second connection', () => {
  assert.equal(selectDelivery({ providers: { max: ready() } }).channel, 'max');
  assert.equal(selectDelivery({ providers: { telegram: ready() } }).channel, 'telegram');
});

test('both linked channels require a preference instead of double delivery', () => {
  const result = selectDelivery({ providers: { max: ready(), telegram: ready() } });
  assert.equal(result.mode, 'choice_required');
  assert.equal(result.channel, null);
  assert.deepEqual(result.options, ['telegram', 'max']);
});

test('explicit client preference and per-record override select just one channel', () => {
  const providers = { max: ready(), telegram: ready() };
  assert.equal(selectDelivery({ preference: 'max', providers }).channel, 'max');
  assert.equal(
    selectDelivery({ preference: 'max', override: 'telegram', providers }).channel,
    'telegram',
  );
  assert.equal(
    selectDelivery({ preference: 'telegram', override: 'auto', providers }).channel,
    'telegram',
  );
});

test('manual contact is not an automatic delivery or an appointment confirmation', () => {
  const providers = { max: ready(), telegram: ready() };
  const result = selectDelivery({ preference: 'max', override: 'manual', providers });
  assert.equal(result.mode, 'manual');
  assert.equal(result.channel, null);
  assert.equal(selectDelivery({ preference: 'manual' }).mode, 'manual');
});

test('a selected unavailable channel never silently falls back to the other bot', () => {
  for (const missing of ['configured', 'connected', 'enabled', 'linked']) {
    const providers = { telegram: ready(), max: { ...ready(), [missing]: false } };
    const result = selectDelivery({ preference: 'max', providers });
    assert.equal(result.mode, 'blocked');
    assert.equal(result.channel, 'max');
    assert.deepEqual(result.options, ['telegram']);
  }
});

test('missing channels and invalid preference fail closed', () => {
  assert.equal(selectDelivery().mode, 'blocked');
  for (const value of ['whatsapp', '', null, {}, 'MAX'])
    assert.throws(() => deliveryPreference(value), { status: 400 });
  for (const providers of [null, [], 'max'])
    assert.throws(() => selectDelivery({ providers }), { status: 400 });
});

test('selection does not mutate provider state and returns an immutable snapshot', () => {
  const providers = { max: Object.freeze(ready()) };
  const result = selectDelivery({ providers });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.options), true);
  assert.deepEqual(providers.max, ready());
});
