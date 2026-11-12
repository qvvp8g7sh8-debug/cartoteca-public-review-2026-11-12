const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const { bookingPreview } = require('../src/server/modules/booking/preview.cjs');
const { calendarRead } = require('../src/server/modules/cabinet/calendar-read.cjs');
const { calendarPeriod } = require('../src/server/modules/cabinet/queries.cjs');
const {
  validatePersonalEvent,
  personalCollection,
} = require('../src/shared/personal-calendar.cjs');
const date = '2090-01-02',
  password = 'Synthetic-personal-calendar-password';
async function fixture(t, shared = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-personal-calendar-'));
  const platform = createPlatformStore(path.join(dir, 'platform'), { sharedCabinetWrites: shared });
  let storage;
  t.after(() => {
    storage?.close();
    platform.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const owner = await platform.registerOwner({
    email: 'personal-owner@example.test',
    password,
    displayName: 'Synthetic owner',
    organizationName: 'Synthetic personal calendar',
  });
  platform.verifyEmail(owner.verificationToken);
  const token = (await platform.login('personal-owner@example.test', password)).token;
  const people = {};
  for (const [key, role] of [
    ['first', 'cosmetologist'],
    ['second', 'cosmetologist'],
    ['admin', 'salon_admin'],
  ]) {
    const invite = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role,
    });
    const account = await platform.acceptInvitation({
      token: invite.token,
      email: key + '@personal.test',
      password,
      displayName: 'Synthetic ' + key,
    });
    people[key] = {
      ...account,
      token: (await platform.login(key + '@personal.test', password)).token,
    };
  }
  storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
  storage.write({
    revision: 0,
    patients: [],
    services: [{ id: 's', name: 'Synthetic service', duration: '30 минут', price: 100 }],
  });
  const event = (changes = {}) => ({
    id: randomUUID(),
    date,
    time: '10:00',
    duration: 30,
    staffId: owner.accountId,
    notes: 'Synthetic personal note',
    ...changes,
  });
  const save = (
    item,
    revision = platform.personalEvents.view(platform.session(token)).personalRevision,
    actorToken = token,
  ) =>
    platform.personalEvents.save(
      actorToken,
      { revision, event: item },
      storage,
      owner.organizationId,
    );
  const remove = (id, revision, actorToken = token) =>
    platform.personalEvents.remove(actorToken, { revision, id }, owner.organizationId);
  return { dir, platform, storage, owner, token, people, event, save, remove };
}
test('personal event validates exact five-minute durations, calendar dates and fields without patient/service/room', () => {
  const event = {
    id: randomUUID(),
    date,
    time: '23:55',
    duration: 5,
    staffId: 'synthetic',
    notes: 'Synthetic',
  };
  for (const duration of [5, 10, 20, 80, 1440])
    assert.equal(validatePersonalEvent({ ...event, duration }).duration, duration);
  for (const changes of [
    { duration: 0 },
    { duration: 7 },
    { duration: 1445 },
    { duration: '20' },
    { time: '10:03' },
    { date: '2090-02-30' },
    { roomId: 'main' },
    { patientId: 'p' },
    { service: 's' },
    { id: 'bad' },
    { notes: 'x'.repeat(2001) },
    { date: '9999-12-31', duration: 10 },
  ])
    assert.throws(() => validatePersonalEvent({ ...event, ...changes }), { status: 400 });
  assert.deepEqual(personalCollection(undefined), { version: 1, revision: 0, events: [] });
  assert.throws(() => personalCollection({ version: 2, revision: 0, events: [] }), { status: 400 });
  assert.throws(() => personalCollection({ version: 1, revision: 0, events: [event, event] }), {
    status: 400,
  });
});
test('personal time needs neither a working day nor a service/client and exact retries do not duplicate it', async (t) => {
  const f = await fixture(t),
    item = f.event({ time: '03:05', duration: 20 });
  const before = f.storage.read(),
    saved = await f.save(item, 0);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.event, item);
  assert.deepEqual(await f.save(item, 0), saved);
  assert.deepEqual(f.storage.read(), before);
  assert.equal(f.platform.organization(f.owner.organizationId).personalEvents.version, 1);
  await f.save(f.event({ time: '04:00' }), 1);
  await assert.rejects(f.save({ ...item, notes: 'Stale changed note' }, 0), { status: 409 });
  assert.equal(
    f.platform.personalEvents.view(f.platform.session(f.token)).personalEvents.length,
    2,
  );
  const deleted = await f.remove(item.id, 2);
  assert.deepEqual(await f.remove(item.id, 0), deleted);
});
test('staff see and edit only their own notes while owner/admin can reserve active specialists', async (t) => {
  const f = await fixture(t),
    first = f.event({ staffId: f.people.first.accountId, notes: 'FIRST PRIVATE NOTE' }),
    second = f.event({ staffId: f.people.second.accountId, notes: 'SECOND PRIVATE NOTE' });
  await f.save(first, 0, f.people.first.token);
  await f.save(second, 1, f.people.admin.token);
  const view = f.platform.personalEvents.view(f.platform.session(f.people.first.token));
  assert.deepEqual(view.personalEvents, [first]);
  assert.doesNotMatch(JSON.stringify(view), /SECOND PRIVATE NOTE/);
  assert.equal(
    f.platform.personalEvents.view(f.platform.session(f.people.admin.token)).personalEvents.length,
    2,
  );
  await assert.rejects(f.save({ ...second, notes: 'Hijack' }, 2, f.people.first.token), {
    status: 403,
  });
  await assert.rejects(f.remove(second.id, 2, f.people.first.token), { status: 403 });
  await assert.rejects(f.save(f.event({ staffId: f.people.admin.accountId }), 2), { status: 403 });
  await assert.rejects(f.save(f.event({ staffId: 'foreign-specialist' }), 2), { status: 403 });
  await f.platform.bootstrapGlobalAdmin({
    email: 'personal-global@example.test',
    password,
    displayName: 'Synthetic global',
  });
  const globalToken = (await f.platform.login('personal-global@example.test', password)).token;
  await assert.rejects(f.save(f.event(), 2, globalToken), { status: 403 });
});
test('overlaps are denied independently of staff/room switches but touching boundaries and other specialists are free', async (t) => {
  const f = await fixture(t),
    item = f.event();
  assert.equal(f.platform.workspaceSettings(f.owner.organizationId).enabled, false);
  await f.save(item);
  for (const changes of [
    { time: '09:55', duration: 10 },
    { time: '10:00', duration: 5 },
    { time: '09:00', duration: 120 },
  ])
    await assert.rejects(f.save(f.event(changes), 1), { status: 409 });
  await f.save(f.event({ time: '09:30' }), 1);
  await f.save(f.event({ time: '10:30' }), 2);
  await f.save(f.event({ staffId: f.people.first.accountId }), 3);
  assert.equal(
    f.platform.personalEvents.view(f.platform.session(f.token)).personalEvents.length,
    4,
  );
});
test('past completed appointments stay busy, cancelled/no-show appointments do not prevent personal time', async (t) => {
  const f = await fixture(t),
    past = '2020-01-02';
  f.storage.write({
    ...f.storage.read(),
    patients: [
      {
        id: 'p',
        name: 'Synthetic',
        createdBy: f.owner.accountId,
        visits: [
          {
            id: 'v',
            date: past,
            procedure: 'Synthetic',
            photos: [],
            staffId: f.owner.accountId,
            appointmentId: 'a',
          },
        ],
        appointments: [
          {
            id: 'a',
            date: past,
            time: '10:00',
            duration: 30,
            staffId: f.owner.accountId,
            status: 'completed',
            completedVisitId: 'v',
            service: 'Synthetic',
          },
        ],
      },
    ],
  });
  await assert.rejects(f.save(f.event({ date: past })), { status: 409 });
  const state = f.storage.read();
  state.patients[0].visits = [];
  for (const status of ['cancelled', 'no_show']) {
    state.patients[0].appointments = [
      {
        id: 'a',
        date: past,
        time: '10:00',
        duration: 30,
        staffId: f.owner.accountId,
        status,
        outcomeAt: 1,
        outcomeBy: f.owner.accountId,
        service: 'Synthetic',
      },
    ];
    state.revision = f.storage.read().revision;
    f.storage.write(state);
    const saved = await f.save(f.event({ date: past }));
    await f.remove(saved.event.id, saved.revision);
  }
});
test('pending online reservation prevents personal save, without disclosing contact data', async (t) => {
  const f = await fixture(t),
    now = Date.now();
  f.platform.withWriteLock(() =>
    f.platform.bookingRequests.create(
      f.owner.organizationId,
      'synthetic-personal-hold-key',
      {
        kind: 'reserve',
        date,
        time: '10:00',
        duration: 30,
        staffId: f.owner.accountId,
        roomId: 'main',
        phone: 'PRIVATE PHONE',
      },
      30,
      now,
    ),
  );
  await assert.rejects(
    f.save(f.event()),
    (error) => error.status === 409 && !/PRIVATE PHONE/.test(error.message),
  );
  assert.equal(f.platform.personalEvents.view(f.platform.session(f.token)).personalRevision, 0);
});
test('manual save and public booking exclude personal time even with all overlap guards disabled', async (t) => {
  const f = await fixture(t),
    workspace = f.platform.workspaceSettings(f.owner.organizationId);
  f.platform.saveWorkspace(
    f.owner.organizationId,
    f.owner.accountId,
    {
      ...workspace,
      rooms: workspace.rooms.map((room) => ({ ...room, preventOverlap: false })),
      staffRules: [{ staffId: f.owner.accountId, preventOverlap: false }],
    },
    () => f.storage.read(),
  );
  f.platform.workSchedules.save(
    f.token,
    {
      staffId: f.owner.accountId,
      dates: [date],
      status: 'working',
      intervals: [['09:00', '12:00']],
      revision: 0,
      expectedTimeZone: 'Europe/Moscow',
    },
    f.storage,
  );
  const settings = f.platform.onlineBooking.view(f.token);
  f.platform.onlineBooking.save(
    f.token,
    {
      revision: settings.revision,
      mode: 'any',
      minimumLeadMinutes: 0,
      reservationMinutes: 30,
      staff: {},
      services: {},
    },
    new Set(['s']),
  );
  await f.save(f.event());
  const current = f.platform.session(f.token),
    context = {
      current,
      token: f.token,
      platform: f.platform,
      tenantStore: () => f.storage,
      assertCurrent: () => assert.ok(f.platform.session(f.token)),
    };
  const state = f.storage.read();
  await assert.rejects(
    saveMutation(context, {
      ...state,
      patients: [
        {
          id: 'p',
          name: 'Synthetic',
          createdBy: f.owner.accountId,
          visits: [],
          appointments: [
            {
              id: 'a',
              date,
              time: '10:00',
              duration: 30,
              staffId: f.owner.accountId,
              roomId: 'main',
              service: 'Synthetic',
            },
          ],
        },
      ],
    }),
    { status: 409 },
  );
  assert.equal(f.storage.read().patients.length, 0);
  const preview = bookingPreview(
    f.platform,
    f.token,
    f.storage,
    { date, serviceIds: ['s'] },
    Date.parse(date + 'T00:00:00Z'),
  );
  assert.ok(
    !preview.slots.some(
      (slot) => slot.time === '10:00' || slot.time === '09:45' || slot.time === '10:15',
    ),
  );
  assert.ok(preview.slots.some((slot) => slot.time === '09:30'));
  assert.ok(preview.slots.some((slot) => slot.time === '10:30'));
});
test('cross-midnight blocks are projected once with both month markers and no occupancy comment', async (t) => {
  const f = await fixture(t),
    item = f.event({ date: '2090-01-01', time: '23:30', duration: 60 });
  await f.save(item);
  const current = f.platform.session(f.token),
    view = f.platform.personalEvents.view(current, date, date);
  assert.deepEqual(view.personalEvents, [item]);
  const occupancy = f.platform.personalEvents.view(current, date, date, {
    projection: 'occupancy',
  });
  assert.equal(occupancy.personalEvents[0].duration, 60);
  assert.ok(!('notes' in occupancy.personalEvents[0]));
  assert.deepEqual(
    f.platform.personalEvents.overview(current, '2090-01-01', date).map((day) => day.date),
    ['2090-01-01', date],
  );
  await assert.rejects(f.save(f.event({ time: '00:25', duration: 10 }), 1), { status: 409 });
  await f.save(f.event({ time: '00:30', duration: 5 }), 1);
});
test('compact calendar invalidates a prior unchanged token when only personal data changes', async (t) => {
  const f = await fixture(t),
    current = f.platform.session(f.token);
  const c = {
    url: new URL(
      'http://localhost/api/cabinet/calendar?from=' +
        date +
        '&to=' +
        date +
        '&compact=1&monthFrom=' +
        date +
        '&monthTo=' +
        date,
    ),
    current,
    platform: f.platform,
    tenantStore: () => f.storage,
    telegram: { status: () => ({}) },
    appointmentState: { decorate: (value) => value },
    json: (_res, _status, value) => value,
  };
  const first = calendarRead(c, calendarPeriod);
  c.url.searchParams.set('until', String(first.validUntil));
  c.url.searchParams.set('version', first.version);
  assert.equal(calendarRead(c, calendarPeriod).unchanged, true);
  await f.save(f.event());
  const second = calendarRead(c, calendarPeriod);
  assert.equal(second.unchanged, undefined);
  assert.equal(second.personalRevision, 1);
  assert.equal(second.personalEvents.length, 1);
  assert.equal(second.personalOverview[0].count, 1);
});
test('independent coordinated platform writers cannot reserve overlapping personal intervals', async (t) => {
  const f = await fixture(t, true),
    other = createPlatformStore(path.join(f.dir, 'platform'), { sharedCabinetWrites: true });
  try {
    const first = f.event(),
      second = f.event({ time: '10:15' });
    const results = await Promise.allSettled([
      f.save(first, 0),
      other.personalEvents.save(
        f.token,
        { revision: 0, event: second },
        f.storage,
        f.owner.organizationId,
      ),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failed = results.find((result) => result.status === 'rejected');
    assert.equal(failed.reason.status, 409);
    assert.equal(
      f.platform.personalEvents.view(f.platform.session(f.token)).personalEvents.length,
      1,
    );
  } finally {
    other.close();
  }
});
test('cabinet replacement and organization profile edits preserve separate personal data', async (t) => {
  const f = await fixture(t),
    item = f.event();
  await f.save(item);
  f.storage.write({ revision: f.storage.read().revision, patients: [], services: [] });
  const raw = createPlatformDatabase(path.join(f.dir, 'platform'));
  try {
    const row = raw.db
      .prepare('SELECT value FROM organizations WHERE id=?')
      .get(f.owner.organizationId);
    raw.db
      .prepare('UPDATE organizations SET value=? WHERE id=?')
      .run(
        raw.seal({ ...raw.open(row.value), city: 'Synthetic new city' }),
        f.owner.organizationId,
      );
  } finally {
    raw.db.close();
  }
  assert.deepEqual(f.platform.personalEvents.view(f.platform.session(f.token)).personalEvents, [
    item,
  ]);
});
test('HTTP personal save/delete and cabinet/bootstrap/calendar reads share the authorized projection', async (t) => {
  const f = await fixture(t),
    server = createMultiServer({
      dataDir: f.dir,
      telegramAutostart: false,
      bookingPublicationAutostart: false,
    });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const authContexts = new Map();
  const request = async (route, method = 'GET', body, cookie = '') => {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookie,
        ...authContexts.get(cookie),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json(),
      nextCookie = response.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && response.status === 200)
      authContexts.set(nextCookie, authContextHeaders(data));
    return { status: response.status, data, cookie: nextCookie };
  };
  try {
    const ownerCookie = (
      await request('/api/auth/login', 'POST', { email: 'personal-owner@example.test', password })
    ).cookie;
    const staffCookie = (
      await request('/api/auth/login', 'POST', { email: 'first@personal.test', password })
    ).cookie;
    const item = f.event();
    assert.equal(
      (
        await request(
          '/api/calendar/personal-event',
          'POST',
          { revision: 0, event: item },
          ownerCookie,
        )
      ).status,
      200,
    );
    for (const route of [
      '/api/cabinet',
      '/api/cabinet/bootstrap',
      '/api/cabinet/calendar?from=' + date + '&to=' + date,
    ]) {
      const own = await request(route, 'GET', undefined, ownerCookie);
      assert.equal(own.status, 200);
      assert.equal(own.data.personalRevision, 1);
      assert.deepEqual(own.data.personalEvents, [item]);
      const staff = await request(route, 'GET', undefined, staffCookie);
      assert.equal(staff.status, 200);
      assert.deepEqual(staff.data.personalEvents, []);
      assert.doesNotMatch(JSON.stringify(staff.data), /Synthetic personal note/);
    }
    assert.equal(
      (
        await request(
          '/api/calendar/personal-event',
          'DELETE',
          { revision: 1, id: item.id },
          staffCookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/api/calendar/personal-event',
          'DELETE',
          { revision: 1, id: item.id },
          ownerCookie,
        )
      ).status,
      200,
    );
    assert.deepEqual(
      (await request('/api/cabinet', 'GET', undefined, ownerCookie)).data.personalEvents,
      [],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
