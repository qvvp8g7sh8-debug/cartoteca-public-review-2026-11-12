const test = require('node:test'),
  assert = require('node:assert/strict');
const { createMaxEvents } = require('../src/server/modules/notifications/max-events.cjs');
const syntheticSecret = 'synthetic_webhook_secret_not_a_real_credential';
const timestamp = Date.now();
const event = {
  update_type: 'bot_started',
  timestamp,
  chat_id: -12345,
  user: { user_id: 456, is_bot: false },
  payload: 'synthetic_payload',
};

test('MAX events are disabled by default and require the configured secret before processing', () => {
  let calls = 0;
  const connections = {
    consumeStarted() {
      calls++;
    },
  };
  assert.throws(() => createMaxEvents({ connections }).receive(syntheticSecret, event), {
    status: 503,
  });
  assert.throws(() => createMaxEvents({ connections, enabled: true, secret: '' }), { status: 400 });
  const receiver = createMaxEvents({ connections, enabled: true, secret: syntheticSecret });
  for (const header of ['', 'incorrect', undefined, [syntheticSecret], 'x'.repeat(257)])
    assert.throws(() => receiver.receive(header, event), { status: 403 });
  assert.equal(calls, 0);
});

test('personal bot-start and stop use the authenticated user and provider timestamp, not chat ID', () => {
  const calls = [],
    connections = {
      consumeStarted: (...args) => {
        calls.push(args);
        return { repeated: false };
      },
      stopped: (...args) => {
        calls.push(args);
        return 1;
      },
    };
  const receiver = createMaxEvents({ connections, enabled: true, secret: syntheticSecret });
  assert.deepEqual(receiver.receive(syntheticSecret, event), { repeated: false });
  assert.deepEqual(calls[0], ['synthetic_payload', '456', timestamp]);
  assert.deepEqual(receiver.receive(syntheticSecret, { ...event, update_type: 'bot_stopped' }), {
    stopped: 1,
  });
  assert.deepEqual(calls[1], ['456', timestamp]);
  assert.deepEqual(receiver.receive(syntheticSecret, { ...event, payload: null }), {
    ignored: true,
  });
  assert.deepEqual(receiver.receive(syntheticSecret, { update_type: 'bot_added' }), {
    ignored: true,
  });
  assert.equal(calls.length, 2);
});

test('bots, channels, unsafe identifiers and impossible timestamps cannot create a binding', () => {
  let calls = 0;
  const receiver = createMaxEvents({
    connections: { consumeStarted: () => calls++ },
    enabled: true,
    secret: syntheticSecret,
    clock: () => timestamp,
  });
  for (const invalid of [
    { ...event, user: { user_id: 456, is_bot: true } },
    { ...event, is_channel: true },
    { ...event, user: { user_id: Number.MAX_SAFE_INTEGER + 1, is_bot: false } },
    { ...event, timestamp: 0 },
    { ...event, timestamp: timestamp + 300001 },
  ])
    assert.throws(() => receiver.receive(syntheticSecret, invalid), { status: 400 });
  assert.equal(calls, 0);
});
