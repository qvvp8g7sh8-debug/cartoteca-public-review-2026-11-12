const test = require('node:test'),
  assert = require('node:assert/strict');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const {
  createStaffMaxService,
} = require('../src/server/modules/notifications/staff-max-service.cjs');
const { createMaxEvents } = require('../src/server/modules/notifications/max-events.cjs');

test('staff MAX capability is personal, expiring, bot-scoped and replay-safe', async (t) => {
  const f = await staffMaxFixture(t),
    store = f.platform.staffMaxNotifications;
  const issued = f.connect(f.users[2], 2);
  assert.deepEqual(store.consume(issued.token, '123', '1002', f.clock(), f.clock()), {
    linked: true,
    repeated: true,
  });
  assert.throws(() => store.consume(issued.token, '123', '1003', f.clock(), f.clock()), {
    status: 409,
  });
  assert.throws(() => store.consume(issued.token, '456', '1002', f.clock(), f.clock()), {
    status: 400,
  });
  const status = store.status(f.users[2].token, '123');
  assert.equal(status.enabled, true);
  assert.doesNotMatch(JSON.stringify(status), /1002|chatId|userId/);
  assert.equal(store.status(f.users[2].token, '456').compatible, false);
  assert.throws(
    () =>
      store.update(f.users[3].token, { bindingId: status.bindingId, enabled: false }, false, '123'),
    { status: 409 },
  );
  assert.throws(
    () =>
      store.update(
        f.users[2].token,
        { bindingId: status.bindingId, enabled: false, accountId: f.users[3].accountId },
        false,
        '123',
      ),
    { status: 400 },
  );
  const other = store.issue(f.users[3].token, '123', f.clock());
  assert.throws(() => store.consume(other.token, '123', '1002', f.clock(), f.clock()), {
    status: 409,
  });
  f.advance(15 * 60000);
  assert.throws(() => store.consume(other.token, '123', '1003', f.clock(), f.clock()), {
    status: 400,
  });
});

test('STOP prevents older START replay but cannot revoke a newer staff binding', async (t) => {
  const f = await staffMaxFixture(t),
    store = f.platform.staffMaxNotifications;
  const issued = store.issue(f.users[2].token, '123', f.clock());
  f.advance(10);
  assert.equal(store.stopped('123', '1002', f.clock(), f.clock()), 0);
  assert.throws(() => store.consume(issued.token, '123', '1002', f.clock() - 1, f.clock()), {
    status: 400,
  });
  f.advance(10);
  f.connect(f.users[2], 2);
  assert.equal(store.stopped('123', '1002', f.clock() - 1, f.clock()), 0);
  assert.equal(store.status(f.users[2].token, '123').linked, true);
  f.create();
  assert.equal(store.stopped('123', '1002', f.clock(), f.clock()), 1);
  assert.equal(store.status(f.users[2].token, '123').linked, false);
  assert.equal(f.jobs()[0].status, 'cancelled');
});

test('events commit into separate MAX and Telegram outboxes and only target eligible staff', async (t) => {
  const f = await staffMaxFixture(t),
    store = f.platform.staffMaxNotifications;
  f.users.forEach(f.connect);
  f.users.forEach(f.connectTelegram);
  const record = f.create();
  assert.equal(f.create().id, record.id);
  for (const channel of ['max', 'telegram']) {
    assert.equal(f.jobs(channel).length, 3);
    assert.deepEqual(
      f
        .jobs(channel)
        .map((j) => j.account_id)
        .sort(),
      f.users
        .slice(0, 3)
        .map((u) => u.accountId)
        .sort(),
    );
    for (const job of f.jobs(channel))
      assert.doesNotMatch(
        Buffer.from(job.value).toString(),
        /PRIVATE|79990000000|Synthetic service/,
      );
  }
  assert.throws(() => store.enqueue(f.owner.organizationId, record, 'new-request'), /transaction/);
  assert.throws(
    () =>
      f.platform.withWriteLock(() => {
        store.enqueue(f.owner.organizationId, { ...record, revision: 1 }, 'client-agreed');
        throw Error('Synthetic rollback');
      }),
    /Synthetic rollback/,
  );
  assert.equal(f.jobs().length, 3);
  const bindingId = store.status(f.users[2].token, '123').bindingId;
  store.update(f.users[2].token, { bindingId, enabled: false }, false, '123');
  assert.equal(f.jobs().find((j) => j.account_id === f.users[2].accountId).status, 'cancelled');
  assert.equal(
    f.jobs('telegram').find((j) => j.account_id === f.users[2].accountId).status,
    'pending',
  );
  store.update(f.users[2].token, { bindingId }, true, '123');
  assert.equal(f.platform.staffNotifications.status(f.users[2].token).enabled, true);
});

test('staff service and event dispatch do not expose recipient IDs or bind staff capability to a client', async (t) => {
  const f = await staffMaxFixture(t);
  const service = createStaffMaxService({
    platform: f.platform,
    identity: f.identity,
    enabled: true,
    clock: f.clock,
  });
  const invitation = service.issue(f.users[2].token);
  const payload = new URL(invitation.url).searchParams.get('start');
  let clientStarts = 0,
    clientStops = 0,
    confirms = 0;
  const secret = 'synthetic_staff_max_webhook_secret_only';
  const events = createMaxEvents({
    enabled: true,
    secret,
    botId: '123',
    clock: f.clock,
    staff: service,
    connections: { consumeStarted: () => clientStarts++, stopped: () => ++clientStops },
    coordinator: {
      confirm: () => {
        confirms++;
        return { confirmed: true };
      },
    },
  });
  const event = {
    update_type: 'bot_started',
    timestamp: f.clock(),
    user: { user_id: '1002', is_bot: false },
    payload,
  };
  assert.equal(events.receive(secret, event).linked, true);
  assert.equal(clientStarts, 0);
  assert.doesNotMatch(JSON.stringify(service.status(f.users[2].token)), /1002|chatId|userId/);
  const confirmation = events.receive(secret, {
    update_type: 'message_callback',
    timestamp: f.clock(),
    callback: {
      callback_id: 'synthetic-confirmation',
      payload: 'confirm_' + 'x'.repeat(27),
      user: { user_id: '1002', is_bot: false },
    },
    message: { recipient: { chat_type: 'dialog', user_id: '1002' } },
  });
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirms, 1);
  events.receive(secret, { ...event, update_type: 'bot_stopped' });
  assert.equal(clientStops, 1);
  assert.equal(service.status(f.users[2].token).linked, false);
  const unprepared = createStaffMaxService({
    platform: { ...f.platform, staffMaxNotifications: null },
    enabled: true,
    identity: f.identity,
  });
  assert.equal(unprepared.status(f.users[2].token).prepared, false);
  assert.throws(() => unprepared.issue(f.users[2].token), { status: 503 });
  // Internal actor rejects inaccessible sessions; the HTTP authentication boundary returns 401.
  assert.throws(() => service.status('synthetic-invalid-session'), { status: 403 });
});
