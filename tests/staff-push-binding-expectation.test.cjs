const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { connectFresh } = require('./helpers/staff-push-connect.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { createMultiServer } = require('../src/server/application/server.cjs');

function subscription(index) {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-binding-cas-' + index,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}
const expect = (store, user, sub) => store.status(user.token, sub.endpoint).bindingExpectation;
const state = (f) => ({
  devices: f.database.db.prepare('SELECT * FROM staff_push_devices ORDER BY id').all(),
  jobs: f.database.db.prepare('SELECT * FROM staff_push_jobs ORDER BY id').all(),
  versions: f.database.db
    .prepare("SELECT * FROM telegram_runtime WHERE key GLOB 'push-binding-v1:*' ORDER BY key")
    .all(),
});
const shape = /^staff-push-binding-expectation-v1:[a-f0-9]{64}$/;

test('service connect requires an explicit actual-endpoint expectation and status remains read-only', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    store = f.platform.staffPush,
    a = f.users[0],
    sub = subscription('required');
  const before = state(f),
    version = f.database.db.prepare('PRAGMA data_version').get().data_version;
  assert.equal(store.status(a.token).bindingExpectation, null);
  const expected = expect(store, a, sub);
  assert.match(expected, shape);
  assert.equal(f.database.db.prepare('PRAGMA data_version').get().data_version, version);
  for (const bad of [undefined, null, '', 'unknown', {}, 1]) {
    assert.throws(() => store.connect(a.token, sub, bad), { status: 400 });
    assert.deepEqual(state(f), before);
  }
  const unknown = 'staff-push-binding-expectation-v1:' + '0'.repeat(64);
  assert.throws(() => store.connect(a.token, sub, unknown), { status: 409 });
  assert.throws(() => store.connect('invalid-synthetic-session', sub, expected), { status: 403 });
  assert.deepEqual(state(f), before);
  assert.ok(store.connect(a.token, sub, expected).device);
});

test('a stale A expectation cannot steal B, and copied actor or endpoint expectations cannot mutate it', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    store = f.platform.staffPush,
    [a, b] = f.users,
    sub = subscription('actor');
  connectFresh(store, a.token, sub);
  const oldA = expect(store, a, sub),
    oldB = expect(store, b, sub);
  assert.notEqual(oldA, oldB);
  const bDevice = store.connect(b.token, sub, oldB).device;
  store.test(b.token, bDevice.id);
  const leasedB = store.claim(),
    bExpected = expect(store, b, sub);
  assert.ok(store.valid(leasedB));
  const before = state(f);
  for (const invalid of [oldA, bExpected, expect(store, a, subscription('other-endpoint'))]) {
    assert.throws(() => store.connect(a.token, sub, invalid), { status: 409 });
    assert.deepEqual(state(f), before);
    assert.ok(store.valid(leasedB));
  }
  assert.equal(store.status(b.token, sub.endpoint).device.id, bDevice.id);
  assert.equal(store.status(a.token, sub.endpoint).device, null);
});

test('an expectation also pins organization when the synthetic authenticated account stays the same', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    a = f.users[0],
    sub = subscription('organization');
  const other = await f.platform.registerOwner({
    email: 'other-scope@push-cas.test',
    password: 'Synthetic-scope-password',
    displayName: 'Synthetic other scope',
    organizationName: 'Synthetic other scope organization',
  });
  const expected = expect(f.platform.staffPush, a, sub);
  const actor = f.platform.onlineBooking.actor(a.token);
  // Unit-level scope projection only: production actor authorization is unchanged.
  const alternate =
    require('../src/server/modules/notifications/push-devices.cjs').createPushDevices({
      ...f.database,
      ...f.platform,
      fail: require('../src/shared/errors.cjs').fail,
      onlineBooking: { actor: () => ({ ...actor, organizationId: other.organizationId }) },
    });
  assert.notEqual(alternate.status(a.token, sub.endpoint).bindingExpectation, expected);
  const before = state(f);
  assert.throws(() => alternate.connect(a.token, sub, expected), { status: 409 });
  assert.deepEqual(state(f), before);
});

test('initial absence is not reused after B connect/disconnect, including a fresh store process view', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    store = f.platform.staffPush,
    [a, b] = f.users,
    sub = subscription('aba');
  const absentA = expect(store, a, sub);
  assert.match(absentA, shape);
  const deviceB = connectFresh(store, b.token, sub).device;
  store.update(b.token, { deviceId: deviceB.id }, true);
  assert.equal(store.status(a.token, sub.endpoint).device, null);
  assert.notEqual(expect(store, a, sub), absentA);
  const restarted = createPlatformStore(f.platformDirectory, { notificationSchema: 17 });
  try {
    const before = state(f);
    assert.throws(() => restarted.staffPush.connect(a.token, sub, absentA), { status: 409 });
    assert.deepEqual(state(f), before);
    assert.ok(connectFresh(restarted.staffPush, a.token, sub).device);
  } finally {
    restarted.close();
  }
});

test('own reconnect rotates the expectation while other endpoint changes leave it valid', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    store = f.platform.staffPush,
    a = f.users[0],
    sub = subscription('own');
  const initial = expect(store, a, sub);
  const first = store.connect(a.token, sub, initial).device;
  const bound = expect(store, a, sub);
  assert.notEqual(bound, initial);
  const before = state(f);
  assert.throws(() => store.connect(a.token, sub, initial), { status: 409 });
  assert.deepEqual(state(f), before);
  connectFresh(store, a.token, subscription('unrelated'));
  assert.equal(expect(store, a, sub), bound);
  assert.equal(store.connect(a.token, sub, bound).device.id, first.id);
  assert.notEqual(expect(store, a, sub), bound);
});

test('expiration advances absence, late old expiration preserves B expectation, and interest resets preserve tombstones', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    store = f.platform.staffPush,
    [a, b] = f.users,
    sub = subscription('expire');
  const old = connectFresh(store, a.token, sub).device,
    oldBinding = store.device(old.id).decoded.bindingId;
  const aExpected = expect(store, a, sub);
  store.expire(old.id, oldBinding);
  const absent = expect(store, a, sub),
    before = state(f);
  assert.notEqual(absent, aExpected);
  assert.throws(() => store.connect(a.token, sub, aExpected), { status: 409 });
  assert.deepEqual(state(f), before);
  require('../src/server/modules/notifications/push-activity.cjs').resetPushNotificationInterest(
    f.database.db,
  );
  assert.equal(expect(store, a, sub), absent);
  const bDevice = connectFresh(store, b.token, sub).device,
    bExpected = expect(store, b, sub);
  store.expire(old.id, oldBinding);
  assert.equal(expect(store, b, sub), bExpected);
  assert.equal(store.status(b.token, sub.endpoint).device.id, bDevice.id);
});

test('bound versus absent state rejects pre-restore expectations even if durable revision is retained', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    store = f.platform.staffPush,
    a = f.users[0],
    sub = subscription('presence');
  const initial = expect(store, a, sub),
    device = connectFresh(store, a.token, sub).device;
  const bound = expect(store, a, sub),
    revisions = state(f).versions;
  // Simulate the existing offline organization-restore policy: revoke the device,
  // retain global metadata. No live restore or migration is performed here.
  f.database.db.prepare('DELETE FROM staff_push_devices WHERE id=?').run(device.id);
  assert.deepEqual(state(f).versions, revisions);
  const absent = expect(store, a, sub),
    before = state(f);
  assert.notEqual(absent, initial);
  assert.notEqual(absent, bound);
  for (const stale of [initial, bound]) {
    assert.throws(() => store.connect(a.token, sub, stale), { status: 409 });
    assert.deepEqual(state(f), before);
  }
});

test('real HTTP paused A connect cannot retake B after B login and connect commit', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    [a, b] = f.users,
    sub = subscription('http-paused');
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
      throw Error('External delivery forbidden');
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port,
    cookieA = 'cartoteca_v2_session=' + a.token;
  function request(route, cookie, actor, body, extra = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    let yes, no;
    const response = new Promise((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    const req = http.request(
      base + route,
      {
        method: text ? 'POST' : 'GET',
        headers: {
          host: 'synthetic.test',
          origin: 'https://synthetic.test',
          'x-cartoteca-request': '1',
          cookie,
          ...(actor ? authContextHeaders(actor.login) : {}),
          ...(text
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }
            : {}),
          ...extra,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () =>
          yes({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }),
        );
      },
    );
    req.on('error', no);
    return { req, response, text };
  }
  async function complete(route, cookie, actor, body) {
    const value = request(route, cookie, actor, body);
    value.req.end(value.text);
    return value.response;
  }
  let late;
  try {
    const statusA = await complete('/api/push/staff/status', cookieA, a, {
      endpoint: sub.endpoint,
    });
    assert.match(statusA.body.bindingExpectation, shape);
    const firstA = await complete('/api/push/staff/connect', cookieA, a, {
      subscription: sub,
      bindingExpectation: statusA.body.bindingExpectation,
    });
    assert.equal(firstA.status, 200);
    const beforeA = await complete('/api/push/staff/status', cookieA, a, {
      endpoint: sub.endpoint,
    });
    let arrived;
    const accepted = new Promise((resolve) => {
      arrived = resolve;
    });
    server.on('request', (req) => {
      if (req.headers['x-synthetic-paused-connect'] === '1') arrived();
    });
    late = request(
      '/api/push/staff/connect',
      cookieA,
      a,
      { subscription: sub, bindingExpectation: beforeA.body.bindingExpectation },
      { 'x-synthetic-paused-connect': '1' },
    );
    const split = Math.floor(late.text.length / 2);
    late.req.write(late.text.slice(0, split));
    await accepted;
    const loginB = await complete('/api/auth/login', cookieA, null, {
      email: 'staff0@staff-max.test',
      password: 'Synthetic-staff-max-password',
    });
    assert.equal(loginB.status, 200);
    const cookieB = loginB.headers['set-cookie'][0].split(';')[0];
    assert.equal((await complete('/api/auth/session', cookieA, null)).body.user.id, a.accountId);
    const statusB = await complete('/api/push/staff/status', cookieB, b, {
      endpoint: sub.endpoint,
    });
    const connectedB = await complete('/api/push/staff/connect', cookieB, b, {
      subscription: sub,
      bindingExpectation: statusB.body.bindingExpectation,
    });
    assert.equal(connectedB.status, 200);
    const bId = connectedB.body.device.id;
    late.req.end(late.text.slice(split));
    assert.equal(
      (await late.response).status,
      409,
      'the stale A binding expectation is rejected after B commits',
    );
    assert.equal(
      (await complete('/api/push/staff/status', cookieB, b, { endpoint: sub.endpoint })).body.device
        .id,
      bId,
    );
    assert.equal(
      (await complete('/api/push/staff/status', cookieA, a, { endpoint: sub.endpoint })).body
        .device,
      null,
    );
    assert.equal(
      (await complete('/api/push/staff/connect', cookieA, a, { subscription: sub })).status,
      400,
      'legacy connect has no implicit expectation',
    );
    assert.equal(
      (
        await complete('/api/push/staff/connect', cookieA, a, {
          subscription: sub,
          bindingExpectation: connectedB.body.bindingExpectation,
        })
      ).status,
      409,
      'copied B expectation is bound to B',
    );
    assert.equal(
      (
        await complete(
          '/api/push/staff/connect',
          'cartoteca_v2_session=invalid-synthetic-session',
          a,
          { subscription: sub, bindingExpectation: beforeA.body.bindingExpectation },
        )
      ).status,
      401,
      'invalid cookie is rejected by the real HTTP authentication guard before CAS',
    );
    assert.equal(
      (await complete('/api/push/staff/status', cookieB, b, { endpoint: sub.endpoint })).body.device
        .id,
      bId,
    );
  } finally {
    late?.req.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
