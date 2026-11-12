const test = require('node:test'),
  assert = require('node:assert/strict');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const {
  createStaffMaxRuntime,
} = require('../src/server/modules/notifications/staff-max-runtime.cjs');
const { createTelegramPacing } = require('../src/server/modules/notifications/telegram-pacing.cjs');

test('MAX uses shared pacing and safe 429 retry, without private details or confirmation buttons', async (t) => {
  const f = await staffMaxFixture(t);
  f.connect(f.users[2], 2);
  const record = f.create();
  const sent = [];
  let limited = true;
  const pacing = createTelegramPacing({ clock: f.clock, wait: async (ms) => f.advance(ms) });
  const runtime = createStaffMaxRuntime({
    platform: f.platform,
    store: f.platform.staffMaxNotifications,
    identity: f.identity,
    pacing,
    clock: f.clock,
    origin: 'https://synthetic.test',
    bot: {
      send: async (message) => {
        if (limited) {
          limited = false;
          throw Object.assign(Error('Synthetic rate limit'), { status: 429, retryAfter: 30 });
        }
        sent.push(message);
      },
    },
  });
  await runtime.tick(undefined, () => true);
  assert.equal(sent.length, 0);
  assert.equal(f.jobs()[0].attempts, 0);
  assert.ok(pacing.remaining('another-recipient') >= 30000);
  f.advance(30001);
  await runtime.tick(undefined, () => true);
  assert.equal(f.jobs()[0].status, 'sent');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].recipient, { botId: '123', userId: '1002' });
  assert.match(sent[0].text, /Synthetic organization|Synthetic service/);
  assert.equal(sent[0].link.text, 'Открыть заявку');
  const target = new URL(sent[0].link.url);
  assert.equal(target.origin, 'https://synthetic.test');
  assert.equal(target.pathname, '/');
  assert.equal(target.search, '');
  assert.deepEqual(JSON.parse(new URLSearchParams(target.hash.slice(1)).get('staff-push')), {
    organizationId: f.owner.organizationId,
    kind: 'request',
    id: record.id,
  });
  assert.doesNotMatch(sent[0].text, /PRIVATE|79990000000/);
  assert.equal(sent[0].attachments, undefined);
  assert.equal(sent[0].keyboard, undefined);
});

test('ambiguous delivery and an expired sending lease never replay MAX staff messages', async (t) => {
  const f = await staffMaxFixture(t);
  f.connect(f.users[2], 2);
  f.create();
  const store = f.platform.staffMaxNotifications;
  let sends = 0;
  const runtime = createStaffMaxRuntime({
    platform: f.platform,
    store,
    identity: f.identity,
    pacing: { acquire: async () => true },
    clock: f.clock,
    bot: {
      send: async () => {
        sends++;
        throw Object.assign(Error('Synthetic unknown result'), { deliveryUncertain: true });
      },
    },
  });
  await runtime.tick(undefined, () => true);
  assert.equal(f.jobs()[0].status, 'uncertain');
  f.advance(600000);
  await runtime.tick(undefined, () => true);
  assert.equal(sends, 1);
  f.create('synthetic-abandoned-lease');
  const old = store.claim(f.clock());
  f.advance(120001);
  assert.equal(store.claim(f.clock()), null);
  assert.equal(f.jobs().find((j) => j.id === old.id).status, 'uncertain');
  assert.equal(store.finish(old, 'sent'), false);
});

test('membership revoked during pacing cancels MAX before network; disabling runtime sends nothing', async (t) => {
  const f = await staffMaxFixture(t);
  f.connect(f.users[2], 2);
  f.create();
  let sends = 0;
  const runtime = createStaffMaxRuntime({
    platform: f.platform,
    store: f.platform.staffMaxNotifications,
    identity: f.identity,
    clock: f.clock,
    bot: { send: async () => sends++ },
    pacing: {
      acquire: async () => {
        f.database.db
          .prepare("UPDATE memberships SET status='suspended' WHERE account_id=?")
          .run(f.users[2].accountId);
        return true;
      },
    },
  });
  await runtime.tick(undefined, () => true);
  assert.equal(sends, 0);
  assert.equal(f.jobs()[0].status, 'cancelled');
  await runtime.tick(undefined, () => false);
  assert.equal(sends, 0);
});

test('leadership loss before POST refunds claim, but interrupted POST remains ambiguous', async (t) => {
  const f = await staffMaxFixture(t);
  f.connect(f.users[2], 2);
  f.create();
  let leader = true,
    sends = 0;
  const first = createStaffMaxRuntime({
    platform: f.platform,
    store: f.platform.staffMaxNotifications,
    identity: f.identity,
    clock: f.clock,
    bot: { send: async () => sends++ },
    pacing: {
      acquire: async () => {
        leader = false;
        return true;
      },
    },
  });
  await first.tick(undefined, () => leader);
  assert.equal(f.jobs()[0].status, 'pending');
  assert.equal(f.jobs()[0].attempts, 0);
  assert.equal(sends, 0);
  f.advance(1001);
  const controller = new AbortController();
  const second = createStaffMaxRuntime({
    platform: f.platform,
    store: f.platform.staffMaxNotifications,
    identity: f.identity,
    clock: f.clock,
    pacing: { acquire: async () => true },
    bot: {
      send: async () => {
        sends++;
        controller.abort();
        throw Error('Synthetic interrupted POST');
      },
    },
  });
  await second.tick(controller.signal, () => true);
  assert.equal(f.jobs()[0].status, 'sending');
  f.advance(120001);
  assert.equal(f.platform.staffMaxNotifications.claim(f.clock()), null);
  assert.equal(f.jobs()[0].status, 'uncertain');
  assert.equal(sends, 1);
});
