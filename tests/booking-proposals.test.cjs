const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs');
const { submitRequest, rejectRequest } = require('../src/server/modules/booking/requests.cjs');
const { acceptRequest } = require('../src/server/modules/booking/acceptance.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const {
  proposalOptions,
  propose,
  proposalLink,
  inspectProposal,
  respondProposal,
} = require('../src/server/modules/booking/proposals.cjs');
const date = '2030-01-01',
  now = Date.parse(date + 'T00:00:00Z'),
  password = 'Synthetic-proposal-password';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-proposal-')),
    platform = createPlatformStore(path.join(dir, 'platform'));
  let storage;
  t.after(() => {
    storage?.close();
    platform.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const owner = await platform.registerOwner({
    email: 'owner@proposal.test',
    password,
    displayName: 'Synthetic specialist',
    organizationName: 'Synthetic organization',
  });
  platform.verifyEmail(owner.verificationToken);
  const login = await platform.login('owner@proposal.test', password),
    token = login.token,
    contextHeaders = authContextHeaders(login);
  storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
  storage.write({
    revision: 0,
    patients: [],
    services: [{ id: 's', name: 'Synthetic service', duration: '30 минут', price: 120 }],
  });
  platform.workSchedules.save(
    token,
    {
      staffId: owner.accountId,
      dates: [date, '2030-01-02'],
      status: 'working',
      intervals: [
        ['09:00', '12:00'],
        ['13:00', '18:00'],
      ],
      revision: 0,
      expectedTimeZone: 'Europe/Moscow',
    },
    storage,
  );
  platform.bookingPublication.save(token, { enabled: true, revision: 0 });
  const context = {
    platform,
    token,
    current: platform.session(token),
    tenantStore: () => storage,
    assertCurrent() {},
  };
  const record = submitRequest(
    platform,
    token,
    storage,
    {
      key: 'synthetic-proposal-original',
      date,
      time: '09:00',
      serviceIds: ['s'],
      staffId: owner.accountId,
      kind: 'other-time',
      firstName: 'Synthetic private contact',
      phone: '+79990000000',
      comment: 'Private note',
      consent: true,
    },
    now,
  );
  const offer = (extra = {}) =>
    propose(
      context,
      { id: record.id, revision: record.revision, date, time: '10:00', ...extra },
      now,
    );
  const secret = (offer) => offer.path.split('#reply=')[1];
  return { dir, platform, owner, token, contextHeaders, storage, context, record, offer, secret };
}
for (const decision of ['agree', 'decline'])
  test(
    'client ' + decision + ' queues exactly one encrypted staff event in the same transaction',
    async (t) => {
      const f = await fixture(t),
        issued = f.platform.staffNotifications.issue(f.token, now);
      f.platform.staffNotifications.consume(issued.token, '100001', now);
      const offered = f.offer(),
        secret = f.secret(offered);
      respondProposal(f.context, { secret, decision }, now);
      respondProposal(f.context, { secret, decision }, now);
      const raw = createPlatformDatabase(path.join(f.dir, 'platform'));
      try {
        const rows = raw.db.prepare('SELECT * FROM staff_notification_jobs').all();
        assert.equal(rows.length, 1);
        assert.doesNotMatch(
          Buffer.from(rows[0].value).toString(),
          /Private note|79990000000|private contact/,
        );
        const job = f.platform.staffNotifications.claim(now);
        assert.equal(job.decoded.event, decision === 'agree' ? 'client-agreed' : 'client-declined');
        assert.ok(f.platform.staffNotifications.valid(job, now));
        assert.equal(
          job.decoded.revision,
          f.platform.bookingRequests.get(f.owner.organizationId, f.record.id, now).revision,
        );
      } finally {
        raw.db.close();
      }
    },
  );

test('proposal has no reserve, hides contacts, blocks acceptance until agreement and then accepts once', async (t) => {
  const f = await fixture(t),
    result = f.offer(),
    secret = f.secret(result);
  assert.equal(result.record.revision, 1);
  assert.equal(result.record.proposal.state, 'waiting');
  assert.equal(
    f.platform.bookingRequests.reserves(f.owner.organizationId, date, date, now).length,
    0,
  );
  assert.equal(f.storage.read().patients.length, 0);
  await assert.rejects(acceptRequest(f.context, { id: f.record.id, revision: 1 }, now), {
    status: 409,
  });
  assert.deepEqual(
    f.offer(),
    result,
    'network retry returns the identical link, not a new proposal',
  );
  assert.equal(proposalLink(f.context, f.record.id, now).path, result.path);
  const view = inspectProposal(f.context, secret, now),
    text = JSON.stringify(view);
  assert.equal(view.time, '10:00');
  for (const privateText of [
    'private contact',
    '79990000000',
    'Private note',
    'roomId',
    'patientId',
    'nonce',
    'fingerprint',
    'owner@',
  ])
    assert.ok(!text.includes(privateText));
  const agreed = respondProposal(f.context, { secret, decision: 'agree' }, now);
  assert.equal(agreed.state, 'agreed');
  assert.deepEqual(respondProposal(f.context, { secret, decision: 'agree' }, now), agreed);
  assert.equal(
    f.storage.read().patients.length,
    0,
    'client agreement itself is not a clinical mutation',
  );
  assert.equal(
    f.platform.bookingRequests.reserves(f.owner.organizationId, date, date, now).length,
    0,
  );
  const current = f.platform.bookingRequests.get(f.owner.organizationId, f.record.id, now);
  await acceptRequest(f.context, { id: f.record.id, revision: current.revision }, now);
  assert.equal(f.storage.read().patients[0].appointments[0].time, '10:00');
  assert.equal(inspectProposal(f.context, secret, now).state, 'accepted');
  assert.equal(
    (await acceptRequest(f.context, { id: f.record.id, revision: current.revision }, now)).status,
    'accepted',
  );
});
test('superseded, forged, expired and disabled links cannot confirm; decline is idempotent', async (t) => {
  const f = await fixture(t),
    first = f.offer(),
    secret = f.secret(first);
  const forged = secret.slice(0, -1) + (secret.endsWith('0') ? '1' : '0');
  assert.throws(() => inspectProposal(f.context, forged, now), { status: 404 });
  const second = propose(f.context, { id: f.record.id, revision: 1, date, time: '11:00' }, now);
  assert.throws(() => respondProposal(f.context, { secret, decision: 'agree' }, now), {
    status: 404,
  });
  assert.throws(
    () =>
      respondProposal(
        f.context,
        { secret: f.secret(second), decision: 'agree' },
        now + 24 * 60 * 60000,
      ),
    { status: 410 },
  );
  f.platform.bookingPublication.save(f.token, { enabled: false, revision: 1 });
  assert.throws(() => inspectProposal(f.context, f.secret(second), now), { status: 404 });
  f.platform.bookingPublication.save(f.token, { enabled: true, revision: 2 });
  const declined = respondProposal(
    f.context,
    { secret: f.secret(second), decision: 'decline' },
    now,
  );
  assert.equal(declined.state, 'rejected');
  assert.deepEqual(
    respondProposal(f.context, { secret: f.secret(second), decision: 'decline' }, now),
    declined,
  );
  assert.throws(
    () => respondProposal(f.context, { secret: f.secret(second), decision: 'agree' }, now),
    { status: 409 },
  );
  await assert.rejects(acceptRequest(f.context, { id: f.record.id, revision: 4 }, now), {
    status: 409,
  });
});
test('proposals ignore sequential mode but respect breaks, closed days, lead time and service snapshots', async (t) => {
  const f = await fixture(t),
    s = f.platform.onlineBooking.view(f.token);
  f.platform.onlineBooking.save(
    f.token,
    {
      revision: s.revision,
      mode: 'sequential',
      minimumLeadMinutes: s.minimumLeadMinutes,
      reservationMinutes: s.reservationMinutes,
      staff: s.staff,
      services: s.services,
    },
    new Set(['s']),
  );
  const options = proposalOptions(f.context, { id: f.record.id, date }, now);
  assert.ok(options.times.includes('10:00'));
  assert.ok(!options.times.includes('12:00'));
  for (const values of [
    { time: '12:00' },
    { date: '2030-01-03' },
    { time: '10:01' },
    { duration: 15 },
  ])
    assert.throws(
      () => f.offer(values),
      (e) => [400, 409].includes(e.status),
    );
  const state = f.storage.read();
  f.storage.write({ ...state, services: [{ ...state.services[0], price: 200 }] });
  assert.throws(() => f.offer(), { status: 409 });
  assert.equal(
    f.platform.bookingRequests.get(f.owner.organizationId, f.record.id, now).revision,
    0,
  );
});
test('occupancy is rechecked both on client agreement and final acceptance without reserving the wish', async (t) => {
  const f = await fixture(t),
    result = f.offer(),
    secret = f.secret(result),
    state = f.storage.read();
  const occupied = {
    id: 'occupied',
    name: 'Synthetic busy client',
    createdBy: f.owner.accountId,
    visits: [],
    appointments: [
      {
        id: 'occupied-a',
        date,
        time: '10:00',
        duration: 30,
        staffId: f.owner.accountId,
        roomId: result.record.roomId,
      },
    ],
  };
  f.storage.write({ ...state, patients: [occupied] });
  assert.throws(() => respondProposal(f.context, { secret, decision: 'agree' }, now), {
    status: 409,
  });
  assert.equal(
    f.platform.bookingRequests.get(f.owner.organizationId, f.record.id, now).proposal.state,
    'waiting',
  );
  f.storage.write({ ...f.storage.read(), patients: [] });
  respondProposal(f.context, { secret, decision: 'agree' }, now);
  f.storage.write({ ...f.storage.read(), patients: [occupied] });
  await assert.rejects(acceptRequest(f.context, { id: f.record.id, revision: 2 }, now), {
    status: 409,
  });
  assert.equal(f.storage.read().patients.length, 1);
});
test('another tenant or unprivileged staff cannot create or recover a proposal link', async (t) => {
  const f = await fixture(t),
    invitation = f.platform.createInvitation({
      organizationId: f.owner.organizationId,
      invitedBy: f.owner.accountId,
      role: 'cosmetologist',
    });
  await f.platform.acceptInvitation({
    token: invitation.token,
    email: 'staff@proposal.test',
    password,
    displayName: 'Synthetic staff',
  });
  const token = (await f.platform.login('staff@proposal.test', password)).token;
  const staffContext = { ...f.context, token, current: f.platform.session(token) };
  assert.throws(
    () => propose(staffContext, { id: f.record.id, revision: 0, date, time: '10:00' }, now),
    { status: 403 },
  );
  const settings = f.platform.onlineBooking.view(f.token);
  f.platform.onlineBooking.save(
    f.token,
    {
      revision: settings.revision,
      mode: settings.mode,
      minimumLeadMinutes: settings.minimumLeadMinutes,
      reservationMinutes: settings.reservationMinutes,
      staff: settings.staff,
      services: { s: [f.owner.accountId] },
    },
    new Set(['s']),
  );
  const offered = f.offer();
  assert.throws(() => proposalLink(staffContext, f.record.id, now), { status: 403 });
  assert.throws(
    () =>
      propose(
        { ...f.context, current: { ...f.context.current, organizationId: 'other' } },
        { id: f.record.id, revision: 1, date, time: '11:00' },
        now,
      ),
    { status: 403 },
  );
  rejectRequest(f.platform, f.token, { id: f.record.id, revision: 1 }, now, f.storage);
  assert.equal(inspectProposal(f.context, f.secret(offered), now).state, 'rejected');
  assert.throws(
    () => respondProposal(f.context, { secret: f.secret(offered), decision: 'agree' }, now),
    { status: 409 },
  );
});
test('HTTP proposal routes keep authorization, CSRF and secrets out of public URLs; two responses share one revision', async (t) => {
  const f = await fixture(t),
    offered = f.offer(),
    secret = f.secret(offered);
  const server = createMultiServer({
    dataDir: f.dir,
    telegramBot: null,
    supportBot: null,
    telegramAutostart: false,
    supportAutostart: false,
    sendMail: null,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body, headers = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (
        await post('/api/online-booking/requests/propose', {
          id: f.record.id,
          revision: 1,
          date,
          time: '11:00',
        })
      ).status,
      401,
    );
    assert.equal(
      (await post('/api/public-booking/proposal', { secret }, { 'X-Cartoteca-Request': '' }))
        .status,
      403,
    );
    assert.equal(
      (await post('/api/public-booking/proposal', { secret, patientId: 'forged' })).status,
      400,
    );
    const view = await post('/api/public-booking/proposal', { secret });
    assert.equal(view.status, 200);
    assert.equal((await view.json()).state, 'waiting');
    const headers = { Cookie: 'cartoteca_v2_session=' + f.token, ...f.contextHeaders };
    const link = await fetch(
      base + '/api/online-booking/requests/proposal-link?id=' + f.record.id,
      { headers },
    );
    assert.equal(link.status, 200);
    assert.equal((await link.json()).path, offered.path);
    const results = await Promise.all([
      post('/api/public-booking/proposal-response', { secret, decision: 'agree' }),
      post('/api/public-booking/proposal-response', { secret, decision: 'agree' }),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200],
    );
    assert.equal(
      f.platform.bookingRequests.get(f.owner.organizationId, f.record.id, now).revision,
      2,
    );
    assert.equal(f.storage.read().patients.length, 0);
    const opposite = await post('/api/public-booking/proposal-response', {
      secret,
      decision: 'decline',
    });
    assert.equal(opposite.status, 409);
    assert.throws(() => inspectProposal(f.context, secret, offered.record.proposal.expiresAt), {
      status: 410,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('organization timezone change invalidates waiting and agreed proposals without shifting an appointment silently', async (t) => {
  const f = await fixture(t),
    offered = f.offer(),
    secret = f.secret(offered);
  respondProposal(f.context, { secret, decision: 'agree' }, now);
  f.platform.updateOrganizationTimeZone(f.token, {
    timeZone: 'Europe/Samara',
    expectedTimeZone: 'Europe/Moscow',
  });
  assert.throws(() => inspectProposal(f.context, secret, now), { status: 409 });
  await assert.rejects(acceptRequest(f.context, { id: f.record.id, revision: 2 }, now), {
    status: 409,
  });
  assert.equal(f.storage.read().patients.length, 0);
  const fresh = propose(f.context, { id: f.record.id, revision: 2, date, time: '11:00' }, now);
  assert.equal(
    inspectProposal(f.context, f.secret(fresh), now).organization.timeZone,
    'Europe/Samara',
  );
  assert.throws(() => inspectProposal(f.context, secret, now), { status: 404 });
});

test('late offers and their retries cannot extend the original request deadline, including legacy NULL deadlines', async (t) => {
  const f = await fixture(t),
    deadline = now + 86400000,
    late = deadline - 3600000;
  const raw = createPlatformDatabase(path.join(f.dir, 'platform'));
  try {
    raw.db.prepare('UPDATE booking_requests SET expires_at=NULL WHERE id=?').run(f.record.id);
  } finally {
    raw.db.close();
  }
  const values = { id: f.record.id, revision: 0, date: '2030-01-02', time: '10:00' };
  const offered = propose(f.context, values, late),
    secret = f.secret(offered);
  assert.equal(offered.record.expiresAt, deadline);
  assert.equal(offered.record.proposal.expiresAt, deadline);
  assert.deepEqual(propose(f.context, values, deadline - 1), offered);
  assert.equal(inspectProposal(f.context, secret, deadline - 1).state, 'waiting');
  const legacy = createPlatformDatabase(path.join(f.dir, 'platform'));
  try {
    const row = legacy.db.prepare('SELECT value FROM booking_requests WHERE id=?').get(f.record.id);
    const value = legacy.open(row.value);
    value.proposal.expiresAt = deadline + 3600000;
    legacy.db
      .prepare('UPDATE booking_requests SET value=? WHERE id=?')
      .run(legacy.seal(value), f.record.id);
  } finally {
    legacy.db.close();
  }
  assert.equal(inspectProposal(f.context, secret, deadline - 1).expiresAt, deadline);
  assert.throws(() => respondProposal(f.context, { secret, decision: 'agree' }, deadline), {
    status: 410,
  });
  assert.throws(
    () => proposalOptions(f.context, { id: f.record.id, date: '2030-01-02' }, deadline),
    { status: 409 },
  );
  assert.throws(() => propose(f.context, { ...values, revision: 1 }, deadline), { status: 409 });
  assert.throws(() => proposalLink(f.context, f.record.id, deadline), { status: 409 });
  assert.equal(
    f.platform.bookingRequests.get(f.owner.organizationId, f.record.id, deadline).status,
    'expired',
  );
  assert.equal(f.storage.read().patients.length, 0);
});

test('staff queue cancels an agreed request that expires while waiting to send, without sending Telegram', async (t) => {
  const f = await fixture(t),
    deadline = now + 86400000,
    late = deadline - 60000;
  const issued = f.platform.staffNotifications.issue(f.token, now);
  f.platform.staffNotifications.consume(issued.token, '100001', now);
  const offered = propose(
    f.context,
    { id: f.record.id, revision: 0, date: '2030-01-02', time: '10:00' },
    late,
  );
  respondProposal(f.context, { secret: f.secret(offered), decision: 'agree' }, late);
  let clock = deadline - 1,
    sends = 0;
  const {
    createStaffTelegramRuntime,
  } = require('../src/server/modules/notifications/staff-runtime.cjs');
  const runtime = createStaffTelegramRuntime({
    platform: f.platform,
    bot: { send: async () => sends++ },
    clock: () => clock,
    pacing: {
      acquire: async () => {
        clock = deadline;
        return true;
      },
    },
  });
  await runtime.tick(undefined, () => true);
  assert.equal(sends, 0);
  const raw = createPlatformDatabase(path.join(f.dir, 'platform'));
  try {
    assert.equal(
      raw.db.prepare('SELECT status FROM staff_notification_jobs').get().status,
      'cancelled',
    );
  } finally {
    raw.db.close();
  }
});
