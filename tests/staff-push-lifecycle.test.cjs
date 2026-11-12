const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { connectFresh } = require('./helpers/staff-push-connect.cjs');
const {
  pushAppointmentChanges,
  createPushSchedule,
} = require('../src/server/modules/notifications/push-events.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
function subscription(index) {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/lifecycle-' + index,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}
test('appointment changes still notify managers and assigned staff and reject obsolete cancellation', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    store = f.platform.staffPush,
    org = f.owner.organizationId;
  for (const [i, user] of f.users.entries()) connectFresh(store, user.token, subscription(i));
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(
    new Date(f.clock() + 20 * 60000),
  );
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(f.clock() + 20 * 60000));
  let a = {
    id: 'appointment',
    patientId: 'patient',
    staffId: f.users[2].accountId,
    date,
    time,
    duration: 30,
  };
  const storage = {
    indexes: { appointments: () => [a] },
    transaction: (fn) => fn(),
    readSelected: () => ({ patients: [{ id: 'patient', appointments: [a] }] }),
  };
  const schedule = createPushSchedule(f.platform, () => storage, store, f.clock);
  a = { ...a, status: 'cancelled' };
  const before = {
    revision: 1,
    patients: [{ id: 'patient', appointments: [{ ...a, status: undefined }] }],
  };
  const next = { revision: 2, patients: [{ id: 'patient', appointments: [a] }] };
  f.platform.withWriteLock(() => pushAppointmentChanges(f.platform, org, before, next));
  const jobs = f.database.db.prepare('SELECT * FROM staff_push_jobs').all();
  assert.equal(jobs.length, 3);
  assert.ok(!jobs.some((j) => j.account_id === f.users[3].accountId));
  const cancellation = jobs.find((j) => f.database.open(j.value).event === 'change');
  cancellation.decoded = f.database.open(cancellation.value);
  assert.equal(schedule.current(cancellation), true);
  a = { ...a, status: undefined };
  assert.equal(schedule.current(cancellation), false);
});
test('first confirmation deduplicates across channels; preferences and reconnect revoke leased work', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    s = f.platform.staffPush,
    u = f.users[0],
    sub = subscription(9);
  const device = connectFresh(s, u.token, sub).device,
    a = { id: 'a', date: '2035-01-01', time: '10:00', staffId: f.users[2].accountId };
  f.platform.withWriteLock(() => {
    s.confirmation(u.organizationId, 'p', a);
    s.confirmation(u.organizationId, 'p', a);
  });
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM staff_push_jobs').get().n, 1);
  const old = s.claim();
  assert.ok(s.valid(old));
  connectFresh(s, u.token, sub);
  assert.equal(s.valid(old), null);
  assert.equal(s.finish(old, 'sent'), 0);
  assert.equal(s.status(u.token, sub.endpoint).device.id, device.id);
  assert.throws(
    () => require('../src/server/migrations/017-staff-push.cjs').rollbackEmptyStaffPush(f.database),
    /Push data exists/,
  );
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
  assert.ok(fingerprint(a));
});
test('provider 410 revokes device; closed-storage settlement after a known ACK remains an explicit unknown', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    s = f.platform.staffPush,
    u = f.users[0];
  const device = connectFresh(s, u.token, subscription(10)).device;
  s.test(u.token, device.id);
  const empty = () => ({ indexes: { appointments: () => [] }, transaction: (fn) => fn() });
  const expired = createPushRuntime({
    platform: f.platform,
    tenantStore: empty,
    origin: 'https://synthetic.test',
    enabled: true,
    send: async () => {
      throw { statusCode: 410 };
    },
  });
  expired.start();
  await expired.tick();
  expired.stop();
  assert.equal(s.device(device.id), null);
  const current = connectFresh(s, u.token, subscription(11)).device;
  s.test(u.token, current.id);
  let resolve, started;
  const began = new Promise((r) => (started = r));
  const runtime = createPushRuntime({
    platform: f.platform,
    tenantStore: empty,
    origin: 'https://synthetic.test',
    enabled: true,
    send: () => {
      started();
      return new Promise((r) => (resolve = r));
    },
  });
  runtime.start();
  const pending = runtime.tick();
  await began;
  runtime.stop();
  const finish = s.finish;
  s.finish = () => {
    throw Error('Storage is closed');
  };
  try {
    resolve();
    await assert.rejects(pending, /Storage is closed/);
    const job = f.database.db
      .prepare('SELECT status,attempts FROM staff_push_jobs WHERE device_id=?')
      .get(current.id);
    assert.equal(
      job.status,
      'sending',
      'failed ACK persistence is unknown, not a fabricated resend',
    );
    assert.equal(job.attempts, 1);
  } finally {
    s.finish = finish;
  }
});
test('real HTTP push API enforces authentication, CSRF, ownership and explicit disabled runtime', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const { createMultiServer } = require('../src/server/application/server.cjs');
  const server = createMultiServer({
    dataDir: f.source,
    notificationSchema: 17,
    origin: 'https://synthetic.test',
    production: false,
    pushEnabled: true,
    pushAutostart: false,
    telegramAutostart: false,
    supportAutostart: false,
    pushSend: () => {
      throw Error('No external delivery in tests');
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (route, body, token = f.users[0].token, origin = 'https://synthetic.test') =>
      new Promise((resolve, reject) => {
        const actor = f.users.find((user) => user.token === token);
        const expected = actor ? authContextHeaders(actor.login) : {};
        const request = require('node:http').request(
          base + '/api/push/staff/' + route,
          {
            method: 'POST',
            headers: {
              host: 'synthetic.test',
              'content-type': 'application/json',
              'x-cartoteca-request': '1',
              origin,
              cookie: 'cartoteca_v2_session=' + token,
              ...expected,
            },
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (bytes) => (text += bytes));
            response.on('end', () =>
              resolve({ status: response.statusCode, json: async () => JSON.parse(text) }),
            );
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify(body));
      });
    assert.equal((await post('status', {}, 'invalid')).status, 401);
    const sub = subscription(20);
    const initial = await post('status', { endpoint: sub.endpoint });
    assert.equal(initial.status, 200);
    const { bindingExpectation } = await initial.json();
    assert.match(bindingExpectation, /^staff-push-binding-expectation-v1:[a-f0-9]{64}$/u);
    assert.equal(
      (await post('connect', { subscription: sub, bindingExpectation }, 'invalid')).status,
      401,
    );
    assert.equal(
      (
        await post(
          'connect',
          { subscription: sub, bindingExpectation },
          f.users[0].token,
          'https://evil.test',
        )
      ).status,
      403,
    );
    const connected = await post('connect', { subscription: sub, bindingExpectation });
    assert.equal(connected.status, 200);
    const value = await connected.json();
    assert.equal(value.device.enabled, true);
    assert.ok(value.publicKey);
    assert.ok(!JSON.stringify(value).includes('privateKey'));
    assert.equal(
      (await post('disconnect', { deviceId: value.device.id }, f.users[1].token)).status,
      404,
    );
    assert.equal((await post('test', { deviceId: value.device.id })).status, 200);
    assert.equal((await post('disconnect', { deviceId: value.device.id })).status, 200);
    assert.equal(server.staffPushRuntime.available, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
