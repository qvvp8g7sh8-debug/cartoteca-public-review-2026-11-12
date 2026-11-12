const test = require('node:test');
const assert = require('node:assert/strict');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { storedEvents } = require('../src/server/modules/notifications/staff-event-preferences.cjs');
const legacy = ['new-request', 'client-agreed', 'client-declined'];
async function fixture(t, channel) {
  const f = await staffMaxFixture(t);
  const user = f.users[2];
  const store =
    channel === 'max' ? f.platform.staffMaxNotifications : f.platform.staffNotifications;
  const table = channel === 'max' ? 'staff_max_links' : 'staff_telegram_links';
  const connect = channel === 'max' ? f.connect : f.connectTelegram;
  connect(user, 2);
  const status = () => store.status(user.token, '123');
  const update = (patch, token = user.token, disconnect = false) =>
    store.update(token, { bindingId: status().bindingId, ...patch }, disconnect, '123');
  const saved = () =>
    f.database.db
      .prepare(`SELECT value FROM ${table} WHERE organization_id=? AND account_id=?`)
      .get(f.owner.organizationId, user.accountId).value;
  const setLink = (value) =>
    f.database.db
      .prepare(`UPDATE ${table} SET value=? WHERE organization_id=? AND account_id=?`)
      .run(f.database.seal(value), f.owner.organizationId, user.accountId);
  return { ...f, user, store, status, update, saved, setLink, channel };
}
function reply(f, record, decision = 'agree') {
  return f.platform.withWriteLock(() => {
    const offered = f.platform.bookingProposals.offer(
      f.owner.organizationId,
      record,
      { date: record.date, time: '11:00' },
      f.clock() + 600000,
      f.clock(),
      f.platform.organizationTimeZone(f.owner.organizationId),
    );
    return f.platform.bookingProposals.reply(f.owner.organizationId, offered, decision, f.clock());
  });
}
test('historical defaults stay fixed and malformed stored events cannot enable new types', () => {
  assert.deepEqual(storedEvents({}), legacy);
  assert.deepEqual(storedEvents({ events: [] }), []);
  assert.deepEqual(storedEvents({ events: null }), []);
  assert.deepEqual(storedEvents({ events: ['test', 'unknown', 'moved', 'moved'] }), ['moved']);
});
for (const channel of ['telegram', 'max']) {
  test(
    channel + ' preserves legacy defaults, explicit empty choices and master state independently',
    async (t) => {
      const f = await fixture(t, channel);
      assert.deepEqual(f.status().events, legacy);
      const value = f.database.open(f.saved());
      assert.deepEqual(value.events, legacy);
      delete value.events;
      f.setLink(value);
      const returned = f.status().events;
      returned.push('moved');
      assert.deepEqual(f.status().events, legacy);
      f.update({ events: [] });
      assert.equal(f.status().enabled, true);
      assert.deepEqual(f.status().events, []);
      f.create('synthetic-no-selected-events');
      assert.equal(f.jobs(channel).length, 0);
      f.update({ enabled: false });
      f.update({ events: ['moved'] });
      assert.equal(f.status().enabled, false);
      assert.deepEqual(f.status().events, ['moved']);
      f.update({ enabled: true });
      assert.equal(f.status().enabled, true);
      assert.deepEqual(f.status().events, ['moved']);
      assert.deepEqual(f.database.open(f.saved()).events, ['moved']);
    },
  );
  test(
    channel + ' rejects invalid event patches and another account cannot edit the binding',
    async (t) => {
      const f = await fixture(t, channel),
        original = Buffer.from(f.saved());
      for (const patch of [
        {},
        { events: ['unknown'] },
        { events: ['test'] },
        { events: ['new-request', 'new-request'] },
        { events: null },
        { events: 'new-request' },
        { events: {} },
        { enabled: null },
        { events: [], accountId: f.users[3].accountId },
        { events: [], organizationId: 'another' },
      ])
        assert.throws(() => f.update(patch), { status: 400 });
      assert.throws(() => f.update({ events: [] }, f.users[3].token), { status: 409 });
      assert.deepEqual(Buffer.from(f.saved()), original);
      assert.deepEqual(f.status().events, legacy);
    },
  );
  test(
    channel + ' disables only its own matching pending and claimed jobs and rejects future copies',
    async (t) => {
      const f = await fixture(t, channel);
      f.connect(f.users[0], 0);
      f.connectTelegram(f.users[0], 0);
      const other = channel === 'max' ? 'telegram' : 'max';
      if (other === 'max') f.connect(f.user, 2);
      else f.connectTelegram(f.user, 2);
      const first = f.create('synthetic-first-selected-event');
      let claimed;
      for (let i = 0; i < 2; i++) {
        const job = f.store.claim(f.clock());
        if (job.account_id === f.user.accountId) {
          claimed = job;
          break;
        }
      }
      assert.ok(claimed);
      assert.ok(f.store.valid(claimed, f.clock()));
      f.create('synthetic-pending-selected-event');
      reply(f, f.create('synthetic-agreed-control'));
      const before = f.jobs(channel),
        untouched = f.jobs(other);
      f.update({ events: ['client-agreed', 'client-declined'] });
      const after = new Map(f.jobs(channel).map((job) => [job.id, job]));
      for (const job of before) {
        const event = f.database.open(job.value).event,
          next = after.get(job.id);
        if (job.account_id === f.user.accountId && event === 'new-request') {
          assert.equal(next.status, 'cancelled');
          assert.equal(next.lease_id, null);
          assert.equal(next.lease_until, 0);
        } else assert.deepEqual(next, job);
      }
      assert.deepEqual(f.jobs(other), untouched);
      assert.equal(f.store.valid(claimed, f.clock()), null);
      const previousOwnCount = f
        .jobs(channel)
        .filter((job) => job.account_id === f.user.accountId).length;
      f.create('synthetic-new-type-disabled');
      assert.equal(
        f.jobs(channel).filter((job) => job.account_id === f.user.accountId).length,
        previousOwnCount,
      );
      assert.equal(first.staffId, f.user.accountId);
    },
  );
  test(
    channel + ' rechecks selected events for a live lease independently of queue cancellation',
    async (t) => {
      const f = await fixture(t, channel);
      f.create();
      const job = f.store.claim(f.clock());
      assert.ok(f.store.valid(job, f.clock()));
      f.setLink({ ...f.database.open(f.saved()), events: [] });
      assert.equal(f.jobs(channel)[0].status, 'sending');
      assert.equal(f.store.valid(job, f.clock()), null);
    },
  );
  test(
    channel + ' queues a rate-limited test only to its owner even with master and events disabled',
    async (t) => {
      const f = await fixture(t, channel);
      f.update({ enabled: false, events: [] });
      const bindingId = f.status().bindingId;
      assert.throws(() => f.store.test(f.users[3].token, { bindingId }, f.clock()), {
        status: 409,
      });
      assert.throws(
        () => f.store.test(f.user.token, { bindingId, accountId: f.users[3].accountId }, f.clock()),
        { status: 400 },
      );
      assert.deepEqual(f.store.test(f.user.token, { bindingId }, f.clock()), { queued: true });
      assert.throws(() => f.store.test(f.user.token, { bindingId }, f.clock()), { status: 429 });
      const job = f.store.claim(f.clock());
      assert.equal(job.account_id, f.user.accountId);
      assert.equal(job.decoded.event, 'test');
      assert.equal(job.expires_at, f.clock() + 60000);
      assert.equal(f.store.valid(job, f.clock()).kind, 'test');
      f.update({ enabled: false, events: ['moved'] });
      assert.equal(f.store.valid(job, f.clock()).kind, 'test');
      f.update({}, f.user.token, true);
      assert.equal(f.store.valid(job, f.clock()), null);
      assert.equal(f.jobs(channel)[0].status, 'cancelled');
    },
  );
}
