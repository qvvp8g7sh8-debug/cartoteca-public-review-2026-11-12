const test = require('node:test');
const assert = require('node:assert/strict');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');
const {
  migrateMaxInbox,
  rollbackEmptyMaxInbox,
} = require('../src/server/migrations/015-max-inbox.cjs');
const { createMaxInbox } = require('../src/server/modules/notifications/max-inbox.cjs');
const { createMaxEvents } = require('../src/server/modules/notifications/max-events.cjs');
const { createMaxRuntime } = require('../src/server/modules/notifications/max-runtime.cjs');

function fixture(t) {
  const f = maxFixture(t);
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  const migration = migrateMaxInbox(f.database, f.directory);
  return { ...f, migration, inbox: createMaxInbox(f.database) };
}
const event = (now) => ({
  update_type: 'bot_started',
  timestamp: now,
  user: { user_id: '456', is_bot: false },
  payload: 'a'.repeat(43),
});
const secret = 'synthetic_max_webhook_secret_not_a_real_credential';

test('authenticated minimal events commit encrypted; duplicates survive reconstruction and changed callbacks conflict', (t) => {
  const f = fixture(t),
    incoming = event(f.now);
  const calls = [];
  const events = createMaxEvents({
    enabled: true,
    secret,
    botId: '123',
    clock: () => f.now,
    connections: {
      consumeStarted: (...args) => {
        calls.push(args);
        return {};
      },
    },
  });
  const normalized = events.normalize({
    ...incoming,
    user: { ...incoming.user, name: 'PRIVATE NAME' },
    text: 'PRIVATE TEXT',
  });
  assert.equal(JSON.stringify(normalized).includes('PRIVATE'), false);
  const runtime = createMaxRuntime({
    inbox: f.inbox,
    events,
    bot: {},
    identity: { botId: '123' },
    clock: () => f.now,
  });
  assert.throws(() => runtime.accept('wrong', incoming), { status: 403 });
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM max_event_inbox').get().n, 0);
  assert.equal(runtime.accept(secret, incoming).repeated, false);
  const second = createMaxInbox(f.database);
  assert.equal(second.accept('123', normalized, f.now).repeated, true);
  assert.equal(calls.length, 0);
  const row = f.database.db.prepare('SELECT value,event_hash,bot_hash FROM max_event_inbox').get();
  assert.equal(Buffer.from(row.value).includes(Buffer.from(incoming.payload)), false);
  // A keyed hash may coincidentally contain any short fragment of the original ID.
  assert.equal(
    row.event_hash,
    f.database.limitKey(
      'max-inbox-event',
      JSON.stringify(['123', incoming.update_type, incoming.timestamp, '456', incoming.payload]),
    ),
  );
  assert.notEqual(row.event_hash, incoming.user.user_id);
  assert.equal(row.bot_hash, f.database.limitKey('max-inbox-bot', '123'));
  const callback = {
    update_type: 'message_callback',
    timestamp: f.now,
    callback: {
      callback_id: 'callback',
      payload: 'confirm_' + 'x'.repeat(27),
      user: incoming.user,
    },
    message: { recipient: { chat_type: 'dialog', user_id: '456' } },
  };
  second.accept('123', events.normalize(callback), f.now);
  assert.throws(
    () => second.accept('123', events.normalize({ ...callback, timestamp: f.now + 1 }), f.now),
    { status: 409 },
  );
});

test('lease reclamation cannot let an old worker finish a newer attempt; leaders exclude other processes', (t) => {
  const f = fixture(t);
  f.inbox.accept('123', event(f.now), f.now);
  assert.equal(f.inbox.acquire('123', 'one', f.now), true);
  assert.equal(f.inbox.acquire('123', 'two', f.now), false);
  assert.equal(f.inbox.acquire('123', 'two', f.now + 30001), true);
  f.inbox.release('123', 'one');
  assert.equal(f.inbox.acquire('123', 'one', f.now + 30002), false);
  const old = f.inbox.claim('123', f.now),
    fresh = f.inbox.claim('123', f.now + 120001);
  assert.equal(f.inbox.finish(old, 'done'), false);
  assert.equal(f.inbox.saveResult(old, {}), false);
  assert.equal(f.inbox.finish(fresh, 'done'), true);
});

test('saved callback outcome survives failure/restart without repeating confirmation writes', async (t) => {
  const f = fixture(t);
  let now = f.now,
    confirmations = 0,
    answers = 0;
  const incoming = {
    update_type: 'message_callback',
    timestamp: now,
    callback: {
      callback_id: 'callback',
      payload: 'confirm_' + 'x'.repeat(27),
      user: { user_id: '456', is_bot: false },
    },
    message: { recipient: { chat_type: 'dialog', user_id: '456' } },
  };
  const events = createMaxEvents({
    enabled: true,
    secret,
    botId: '123',
    clock: () => now,
    connections: {},
    coordinator: {
      confirm: () => {
        confirmations++;
        return { first: true };
      },
    },
  });
  const bot = {
    answer: async () => {
      answers++;
      if (answers === 1) throw Error('Synthetic network failure');
    },
  };
  const options = {
    inbox: f.inbox,
    events,
    bot,
    identity: { botId: '123' },
    clock: () => now,
    pacing: { acquire: async () => true, pause: () => {} },
  };
  const first = createMaxRuntime(options);
  first.accept(secret, incoming);
  await first.tick();
  assert.equal(confirmations, 1);
  assert.equal(f.database.db.prepare('SELECT status FROM max_event_inbox').get().status, 'pending');
  first.stop();
  now += 31000;
  const restarted = createMaxRuntime({ ...options, inbox: createMaxInbox(f.database) });
  await restarted.tick();
  restarted.stop();
  assert.equal(answers, 2);
  assert.equal(confirmations, 1);
  assert.equal(f.database.db.prepare('SELECT status FROM max_event_inbox').get().status, 'done');
});

test('candidate 015 snapshot and empty rollback preserve earlier history, nonempty rollback refuses deletion', (t) => {
  const f = fixture(t);
  assert.ok(f.migration.snapshotDirectory);
  rollbackEmptyMaxInbox(f.database);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 14);
  migrateMaxInbox(f.database, f.directory);
  f.inbox.accept('123', event(f.now), f.now);
  assert.throws(() => rollbackEmptyMaxInbox(f.database), /full verified backup/);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 15);
});
