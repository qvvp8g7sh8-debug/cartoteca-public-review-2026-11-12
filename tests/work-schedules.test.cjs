const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const postcss = require('postcss');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { normalizeDay, bookingWarning, validDate } = require('../src/shared/work-schedule.cjs');
const { fail } = require('../src/shared/errors.cjs');
const password = 'Synthetic-schedule-only-password';
const day = '2030-01-01';
const { createSyntheticSeed, createFixtureTimer } = require('./helpers/synthetic-seed.cjs');
const scheduleSeed = createSyntheticSeed({
  name: 'workdays',
  async prepare(dir) {
    const platform = createPlatformStore(path.join(dir, 'platform'));
    let clinic, server;
    try {
      const owner = await platform.registerOwner({
        email: 'owner@schedule.test',
        password,
        displayName: 'Synthetic owner',
        organizationName: 'Synthetic organization',
      });
      platform.verifyEmail(owner.verificationToken);
      const members = { owner };
      for (const [key, role] of [
        ['staff', 'cosmetologist'],
        ['admin', 'salon_admin'],
      ]) {
        const invitation = platform.createInvitation({
          organizationId: owner.organizationId,
          invitedBy: owner.accountId,
          role,
        });
        members[key] = await platform.acceptInvitation({
          token: invitation.token,
          email: key + '@schedule.test',
          password,
          displayName: 'Synthetic ' + key,
        });
      }
      const other = await platform.registerOwner({
        email: 'other@schedule.test',
        password,
        displayName: 'Other',
        organizationName: 'Other organization',
      });
      platform.verifyEmail(other.verificationToken);
      members.other = other;
      await platform.bootstrapGlobalAdmin({
        email: 'global@schedule.test',
        password,
        displayName: 'Global',
      });
      clinic = createStorage(path.join(dir, 'tenants', owner.organizationId));
      clinic.write({
        revision: 0,
        services: [{ id: 's', name: 'Уход', category: 'other', duration: '60 минут', price: 1000 }],
        patients: [
          {
            id: 'p',
            name: 'PRIVATE-PATIENT',
            createdBy: owner.accountId,
            phone: 'PRIVATE-PHONE',
            visits: [],
            appointments: [],
          },
        ],
      });
      const login = await platform.login('owner@schedule.test', password);
      const workspace = platform.workspaceSettings(owner.organizationId);
      platform.saveWorkspace(
        owner.organizationId,
        owner.accountId,
        {
          ...workspace,
          rooms: workspace.rooms.map((r) => ({
            ...r,
            staffMode: 'multiple',
            staffIds: [owner.accountId, members.staff.accountId],
          })),
        },
        () => clinic.read(),
      );
      server = createMultiServer({
        dataDir: dir,
        sendMail: null,
        telegramBot: null,
        telegramAutostart: false,
        supportAutostart: false,
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const base = 'http://127.0.0.1:' + server.address().port,
        cookies = {},
        contexts = {};
      for (const key of ['owner', 'staff', 'admin', 'other', 'global']) {
        const response = await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { Origin: base, 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
          body: JSON.stringify({ email: key + '@schedule.test', password }),
        });
        assert.equal(response.status, 200);
        contexts[key] = authContextHeaders(await response.json());
        cookies[key] = response.headers.get('set-cookie')?.split(';')[0];
        assert.ok(cookies[key]);
      }
      return { owner, members, cookies, contexts, token: login.token };
    } finally {
      try {
        if (server?.listening) {
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
        }
      } finally {
        try {
          clinic?.close();
        } finally {
          platform.close();
        }
      }
    }
  },
});
test.after(() => scheduleSeed.close());
async function fixture(t) {
  const timing = createFixtureTimer(t, 'work-schedules');
  const copy = await scheduleSeed.clone(),
    { dir } = copy,
    { owner, members, cookies, contexts, token } = copy.data,
    windows = [];
  let platform, clinic, server;
  t.after(() =>
    timing.cleanup(async () => {
      try {
        windows.forEach((w) => {
          w.dispatchEvent(new w.Event('pagehide'));
          w.close();
        });
      } finally {
        try {
          if (server?.listening) {
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
          }
        } finally {
          try {
            clinic?.close();
          } finally {
            try {
              platform?.close();
            } finally {
              copy.close();
            }
          }
        }
      }
    }),
  );
  platform = createPlatformStore(path.join(dir, 'platform'));
  clinic = createStorage(path.join(dir, 'tenants', owner.organizationId));
  server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: null,
    telegramAutostart: false,
    supportAutostart: false,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(
    url,
    body,
    key = 'owner',
    method = body ? 'POST' : 'GET',
    acknowledgement = '',
  ) {
    const response = await fetch(base + url, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookies[key] || '',
        ...contexts[key],
        ...(acknowledgement ? { 'X-Cartoteca-Schedule-Ack': acknowledgement } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }
  const url = (staff = owner.accountId, from = day, to = from) =>
    '/api/work-schedules?staffId=' + staff + '&from=' + from + '&to=' + to;
  const config = async (
    staff = owner.accountId,
    dates = [day],
    status = 'working',
    intervals = [['09:00', '19:00']],
  ) => {
    const view = (await request(url(staff))).data;
    return {
      staffId: staff,
      dates,
      status,
      intervals,
      revision: view.revision,
      expectedTimeZone: view.timeZone,
    };
  };
  const appointment = (id, staff = owner.accountId, time = '10:00', date = day) => ({
    id,
    staffId: staff,
    date,
    time,
    duration: 60,
    service: 'PRIVATE-SERVICE',
    notes: 'PRIVATE-NOTE',
  });
  const read = async (key = 'owner') => (await request('/api/cabinet', null, key)).data;
  const save = (body, key = 'owner', ack = '') => request('/api/cabinet', body, key, 'PUT', ack);
  timing.ready();
  return {
    dir,
    platform,
    clinic,
    owner,
    members,
    cookies,
    request,
    url,
    config,
    appointment,
    read,
    save,
    base,
    windows,
    token,
  };
}

test('date-only work intervals validate order, breaks, midnight and unknown days', () => {
  assert.equal(validDate('2030-02-30'), false);
  assert.deepEqual(
    normalizeDay(
      {
        status: 'working',
        intervals: [
          ['14:00', '19:00'],
          ['09:00', '13:00'],
        ],
      },
      fail,
    ).intervals,
    [
      ['09:00', '13:00'],
      ['14:00', '19:00'],
    ],
  );
  for (const intervals of [
    [],
    [['10:00', '09:00']],
    [
      ['09:00', '13:00'],
      ['12:30', '19:00'],
    ],
    [['9:00', '19:00']],
    [['09:00', '24:01']],
  ])
    assert.throws(() => normalizeDay({ status: 'working', intervals }, fail), { status: 400 });
  const working = {
    status: 'working',
    intervals: [
      ['09:00', '13:00'],
      ['14:00', '19:00'],
    ],
  };
  assert.equal(
    bookingWarning(
      { date: day, time: '12:00', duration: 60 },
      () => working,
      () => null,
    ),
    '',
  );
  assert.match(
    bookingWarning(
      { date: day, time: '12:30', duration: 60 },
      () => working,
      () => null,
    ),
    /перерыв/,
  );
  assert.equal(
    bookingWarning(
      { date: day, time: '23:30', duration: 60 },
      () => null,
      () => null,
    ),
    '',
  );
  const midnight = { status: 'working', intervals: [['00:00', '24:00']] };
  assert.equal(
    bookingWarning(
      { date: day, time: '23:30', duration: 60 },
      () => midnight,
      () => null,
    ),
    '',
  );
  assert.match(
    bookingWarning(
      { date: day, time: '23:30', duration: 60 },
      (d) => (d === day ? midnight : { status: 'closed' }),
      () => null,
    ),
    /выходной/,
  );
  assert.match(
    bookingWarning(
      { date: day, time: '23:30', duration: 60 },
      () => null,
      (d) => (d === day ? null : { status: 'closed' }),
    ),
    /закрыта/,
  );
});

test('owner and administrator can change the organization calendar start; employee cannot', async (t) => {
  const f = await fixture(t),
    initial = (await f.request(f.url())).data;
  assert.equal(initial.calendarHiddenUntil, '07:00');
  assert.equal(initial.canManageCalendar, true);
  let reply = await f.request('/api/work-schedules/calendar-settings', {
    revision: initial.calendarRevision,
    hiddenUntil: '09:00',
  });
  assert.equal(reply.status, 200);
  assert.equal((await f.request(f.url())).data.calendarHiddenUntil, '09:00');
  const adminView = (await f.request(f.url(f.members.admin.accountId), null, 'admin')).data;
  reply = await f.request(
    '/api/work-schedules/calendar-settings',
    { revision: adminView.calendarRevision, hiddenUntil: '08:00' },
    'admin',
  );
  assert.equal(reply.status, 200);
  const staffView = (await f.request(f.url(f.members.staff.accountId), null, 'staff')).data;
  assert.equal(staffView.calendarHiddenUntil, '08:00');
  assert.equal(staffView.canManageCalendar, false);
  assert.equal(
    (
      await f.request(
        '/api/work-schedules/calendar-settings',
        { revision: staffView.calendarRevision, hiddenUntil: '06:00' },
        'staff',
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request('/api/work-schedules/calendar-settings', {
        revision: reply.data.revision,
        hiddenUntil: '08:30',
      })
    ).status,
    400,
  );
});

test('working-time union respects active staff and organization boundaries; staff receives only own intervals', async (t) => {
  const f = await fixture(t),
    staff = f.members.staff.accountId;
  await f.request(
    '/api/work-schedules',
    await f.config(f.owner.accountId, [day], 'working', [
      ['09:15', '12:30'],
      ['14:00', '17:00'],
    ]),
  );
  await f.request(
    '/api/work-schedules',
    await f.config(staff, [day], 'working', [
      ['12:00', '13:00'],
      ['23:30', '24:00'],
    ]),
  );
  for (const key of ['owner', 'admin']) {
    const reply = await f.request(f.url(), null, key);
    assert.deepEqual(reply.data.workingIntervals[day], [
      ['09:15', '13:00'],
      ['14:00', '17:00'],
      ['23:30', '24:00'],
    ]);
    assert.doesNotMatch(JSON.stringify(reply.data.workingIntervals), /PRIVATE|accountId|staffId/);
  }
  const own = (await f.request(f.url(staff), null, 'staff')).data;
  assert.deepEqual(own.workingIntervals[day], [
    ['12:00', '13:00'],
    ['23:30', '24:00'],
  ]);
  assert.deepEqual(Object.keys(own.staffDays), [staff]);
  assert.deepEqual(own.staffDays[staff][day].intervals, [
    ['12:00', '13:00'],
    ['23:30', '24:00'],
  ]);
  assert.equal((await f.request(f.url(), null, 'staff')).status, 403);
  assert.deepEqual(
    (await f.request(f.url(f.members.other.accountId), null, 'other')).data.workingIntervals,
    {},
  );
  assert.equal((await f.request(f.url(), null, 'global')).status, 403);
  f.platform.updateMembership({
    organizationId: f.owner.organizationId,
    actorId: f.owner.accountId,
    accountId: staff,
    status: 'suspended',
    role: 'cosmetologist',
  });
  assert.deepEqual((await f.request(f.url())).data.workingIntervals[day], [
    ['09:15', '12:30'],
    ['14:00', '17:00'],
  ]);
});

test('work grid covers midnight endpoints, excludes closures/unset days and clips fractional hours', async (t) => {
  const vm = require('node:vm');
  const state = {
    multiUser: true,
    currentView: 'calendar',
    account: { id: 'staff', organizationId: 'org' },
    selectedScheduleStaff: 'staff',
    calendarAnchorDate: new Date(2030, 0, 1),
  };
  const snapshot = {
    staffId: 'staff',
    from: day,
    to: '2030-01-03',
    members: [{ accountId: 'staff' }],
    days: { [day]: { status: 'working', intervals: [['00:00', '24:00']] } },
    closures: {},
    workingIntervals: {},
  };
  const actions = {
    accountId: () => 'staff',
    accountRole: () => 'cosmetologist',
    calendarRange: () => ({ from: day, to: '2030-01-03' }),
    readBackground: async () => snapshot,
    $: () => null,
    setView: () => {},
  };
  const context = vm.createContext({ state, actions });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/client/modules/work-schedules.js'), 'utf8') +
      '\nthis.feature=createWorkSchedules(state,actions);',
    context,
  );
  const feature = context.feature;
  await feature.loadCalendarSchedule();
  assert.equal(feature.scheduleDayKind(day), 'working');
  assert.equal(feature.scheduleDayKind('2030-01-02'), 'unset');
  for (const start of [0, 60, 1380])
    assert.equal(feature.scheduleSlotStyle(day, start), 'var(--calendar-work-grid),#fafbfc');
  assert.equal(feature.scheduleSlotStyle('2030-01-02', 600), '');
  snapshot.closures[day] = { status: 'closed' };
  assert.equal(feature.scheduleSlotStyle(day, 600), '#e4e7eb');
  delete snapshot.closures[day];
  snapshot.days[day] = { status: 'closed' };
  assert.equal(feature.scheduleSlotStyle(day, 600), '#e4e7eb');
  assert.equal(feature.scheduleDayKind(day), 'closed');
  snapshot.days[day] = { status: 'working', intervals: [['12:15', '12:45']] };
  assert.match(
    feature.scheduleSlotStyle(day, 720),
    /#e8f3ec 0% 25%,transparent 25% 75%,#e8f3ec 75% 100%/,
  );
  snapshot.days[day] = { status: 'working', intervals: [['14:00', '18:00']] };
  for (const start of [840, 900, 960, 1020])
    assert.equal(feature.scheduleSlotStyle(day, start), 'var(--calendar-work-grid),#fafbfc');
  for (const start of [780, 1080]) assert.equal(feature.scheduleSlotStyle(day, start), '#e8f3ec');
});

test('schedule rights are isolated by organization and employee; owner controls self-edit permission', async (t) => {
  const f = await fixture(t),
    staff = f.members.staff.accountId;
  assert.equal((await f.request(f.url(), null, 'global')).status, 403);
  assert.equal((await f.request(f.url(staff), null, 'other')).status, 403);
  assert.equal((await f.request(f.url(), null, 'staff')).status, 403);
  const own = (await f.request(f.url(staff), null, 'staff')).data;
  assert.equal(own.canEdit, true);
  assert.equal(own.revision, 0);
  assert.deepEqual(own.days, {});
  assert.deepEqual(
    own.members.map((m) => m.accountId),
    [staff],
  );
  assert.doesNotMatch(JSON.stringify(own), /PRIVATE-PATIENT|PRIVATE-PHONE|Synthetic owner/);
  assert.equal(
    (await f.request('/api/work-schedules', await f.config(staff), 'staff')).status,
    200,
  );
  const permission = { staffId: staff, revision: 1, allowSelfEdit: false };
  assert.equal(
    (await f.request('/api/work-schedules/permission', permission, 'admin')).status,
    403,
  );
  assert.equal((await f.request('/api/work-schedules/permission', permission)).status, 200);
  assert.equal((await f.request(f.url(staff), null, 'staff')).data.canEdit, false);
  assert.equal(
    (await f.request('/api/work-schedules', await f.config(staff), 'staff')).status,
    403,
  );
  assert.equal(
    (await f.request('/api/work-schedules', await f.config(staff), 'admin')).status,
    200,
  );
  assert.equal((await f.request('/api/work-schedules/permission', permission)).status, 409);
});

test('explicit date batches never recur or copy and stale/invalid changes do not commit', async (t) => {
  const f = await fixture(t),
    body = await f.config(f.owner.accountId, [day, '2030-01-03']);
  for (const invalid of [
    { ...body, repeat: true },
    { ...body, copyFrom: day },
    { ...body, dates: ['2030-02-30'] },
    { ...body, dates: [day, day] },
    { ...body, dates: [day, '2031-01-01'] },
    { ...body, intervals: [['12:00', '11:00']] },
  ])
    assert.equal((await f.request('/api/work-schedules', invalid)).status, 400);
  assert.equal((await f.request('/api/work-schedules', body)).status, 200);
  assert.equal((await f.request('/api/work-schedules', body)).status, 409);
  assert.deepEqual(
    Object.keys((await f.request(f.url(f.owner.accountId, day, '2030-01-31'))).data.days),
    [day, '2030-01-03'],
  );
  assert.deepEqual(
    (await f.request(f.url(f.owner.accountId, '2030-02-01', '2030-02-28'))).data.days,
    {},
  );
  const reset = await f.config(f.owner.accountId, [day], 'reset', []);
  await f.request('/api/work-schedules', reset);
  assert.deepEqual((await f.request(f.url())).data.days, {});
});

test('schedule changes warn about existing bookings, recheck new conflicts and never rewrite visits or appointments', async (t) => {
  const f = await fixture(t),
    data = await f.read();
  data.patients[0].appointments = [f.appointment('a')];
  const initial = (await f.request('/api/work-schedules/check', data.patients[0].appointments[0]))
    .data;
  assert.match(initial.warning, /День не настроен/);
  assert.equal((await f.save(data)).status, 412);
  assert.equal((await f.save(data, 'owner', initial.acknowledgement)).status, 200);
  const values = await f.config(f.owner.accountId, [day], 'closed', []);
  let reply = await f.request('/api/work-schedules', values);
  assert.equal(reply.data.requiresConfirmation, true);
  assert.equal(reply.data.conflictCount, 1);
  assert.doesNotMatch(JSON.stringify(reply.data), /PRIVATE|appointmentId|patientId/);
  assert.deepEqual((await f.request(f.url())).data.days, {});
  const next = await f.read();
  next.patients[0].appointments.push(f.appointment('b', f.owner.accountId, '12:00'));
  const another = (
    await f.request('/api/work-schedules/check', next.patients[0].appointments.at(-1))
  ).data;
  assert.equal((await f.save(next, 'owner', another.acknowledgement)).status, 200);
  values.confirmation = reply.data.confirmation;
  reply = await f.request('/api/work-schedules', values);
  assert.equal(reply.data.requiresConfirmation, true);
  assert.equal(reply.data.conflictCount, 2);
  const before = await f.read();
  values.confirmation = reply.data.confirmation;
  assert.equal((await f.request('/api/work-schedules', values)).data.saved, true);
  assert.deepEqual(await f.read(), before);
  assert.equal((await f.request(f.url())).data.days[day].status, 'closed');
});

test('PUT/PATCH enforce schedule boundaries; owner override is explicit, time-bound, revision-bound and not stored clinically', async (t) => {
  const f = await fixture(t),
    staff = f.members.staff.accountId;
  await f.request('/api/work-schedules', await f.config(staff, [day], 'closed', []));
  const a = f.appointment('a', staff),
    data = await f.read();
  data.patients[0].appointments = [a];
  assert.equal((await f.save(data)).status, 412);
  const check = (await f.request('/api/work-schedules/check', a)).data;
  assert.equal(check.canOverride, true);
  assert.match(check.warning, /выходной/);
  const employee = (await f.request('/api/work-schedules/check', a, 'staff')).data;
  assert.equal(employee.canOverride, false);
  assert.equal(employee.acknowledgement, '');
  assert.equal((await f.save(data, 'owner', '1.forged')).status, 412);
  const unicodeAck = check.acknowledgement.split('.')[0] + '.' + 'é'.repeat(43);
  assert.equal((await f.save(data, 'owner', unicodeAck)).status, 412);
  const wrongDate = structuredClone(data);
  wrongDate.patients[0].appointments[0].time = '11:00';
  assert.equal((await f.save(wrongDate, 'owner', check.acknowledgement)).status, 412);
  assert.equal((await f.save(data, 'owner', check.acknowledgement)).status, 200);
  assert.doesNotMatch(JSON.stringify(await f.read()), /acknowledgement|scheduleAck/);
  const staffState = await f.read('staff');
  staffState.patients[0].appointments.push(f.appointment('staff-b', staff, '14:00'));
  assert.equal((await f.save(staffState, 'staff', check.acknowledgement)).status, 403);
  const previous = await f.read(),
    after = structuredClone(previous.patients[0]);
  after.appointments.push(f.appointment('patch-b', staff, '15:00'));
  assert.equal(
    (
      await f.request(
        '/api/cabinet/changes',
        {
          revision: previous.revision,
          patients: [{ id: 'p', before: previous.patients[0], after }],
          services: [],
        },
        'owner',
        'PATCH',
      )
    ).status,
    412,
  );
  const stale = (await f.request('/api/work-schedules/check', after.appointments.at(-1))).data;
  await f.request('/api/work-schedules/permission', {
    staffId: staff,
    revision: 1,
    allowSelfEdit: false,
  });
  assert.equal(
    (await f.save({ ...previous, patients: [after] }, 'owner', stale.acknowledgement)).status,
    412,
  );
  const zoneAck = (await f.request('/api/work-schedules/check', after.appointments.at(-1))).data
    .acknowledgement;
  await f.request('/api/cabinet/time-zone', {
    timeZone: 'Europe/Samara',
    expectedTimeZone: 'Europe/Moscow',
  });
  assert.equal((await f.save({ ...previous, patients: [after] }, 'owner', zoneAck)).status, 412);
  const unchanged = await f.read();
  unchanged.patients[0].appointments[0].notes = 'Changed note only';
  assert.equal((await f.save(unchanged)).status, 200);
});

test('legacy missing duration keeps its sixty-minute meaning; malformed preview cannot cause a server error', async (t) => {
  const f = await fixture(t),
    data = await f.read();
  const legacy = f.appointment('legacy');
  delete legacy.duration;
  data.patients[0].appointments = [legacy];
  assert.equal((await f.save(data)).status, 412);
  const ack = (await f.request('/api/work-schedules/check', legacy)).data.acknowledgement;
  assert.equal((await f.save(data, 'owner', ack)).status, 200);
  const config = await f.config(f.owner.accountId, [day], 'working', [['10:00', '10:30']]);
  const result = await f.request('/api/work-schedules', config);
  assert.equal(result.data.conflictCount, 1);
  for (const body of [
    [],
    {},
    { date: day, time: '25:00', duration: 60, staffId: f.owner.accountId },
  ])
    assert.equal((await f.request('/api/work-schedules/check', body)).status, 400);
});

test('organization closure preserves personal schedules and override never bypasses room or staff overlap checks', async (t) => {
  const f = await fixture(t);
  await f.request('/api/work-schedules', await f.config());
  const personal = (await f.request(f.url())).data.days;
  await f.request('/api/work-schedules', await f.config('organization', [day], 'closed', []));
  assert.deepEqual((await f.request(f.url())).data.days, personal);
  assert.equal((await f.request(f.url())).data.closures[day].status, 'closed');
  const ws = f.platform.workspaceSettings(f.owner.organizationId);
  f.platform.saveWorkspace(
    f.owner.organizationId,
    f.owner.accountId,
    { ...ws, enabled: true },
    () => f.clinic.read(),
  );
  const first = f.appointment('a');
  first.roomId = 'main';
  let data = await f.read();
  data.patients[0].appointments = [first];
  let ack = (await f.request('/api/work-schedules/check', first)).data.acknowledgement;
  assert.equal((await f.save(data, 'owner', ack)).status, 200);
  data = await f.read();
  const second = { ...first, id: 'overlap', time: '10:30' };
  data.patients[0].appointments.push(second);
  ack = (await f.request('/api/work-schedules/check', second)).data.acknowledgement;
  assert.equal((await f.save(data, 'owner', ack)).status, 409);
  assert.equal((await f.read()).patients[0].appointments.length, 1);
});

test('schema 7 takes a verified pre-migration backup and rollback does not touch account ciphertext', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-workdays-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let platform = createPlatformStore(directory);
  const user = await platform.registerOwner({
    email: 'migration@schedule.test',
    password,
    displayName: 'Synthetic',
    organizationName: 'Synthetic',
  });
  platform.verifyEmail(user.verificationToken);
  platform.close();
  let raw = createPlatformDatabase(directory);
  const bytes = Buffer.from(
    raw.db.prepare('SELECT value FROM accounts WHERE id=?').get(user.accountId).value,
  );
  require('./helpers/platform-inspection.cjs').dropAdminSchema(raw.db);
  raw.db.exec(
    'DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; DROP TABLE booking_requests; DROP TABLE email_invitations; DROP TABLE work_schedule_days; DROP TABLE work_schedule_profiles; PRAGMA user_version=6',
  );
  raw.db.close();
  platform = createPlatformStore(directory);
  assert.ok(await platform.login('migration@schedule.test', password));
  platform.close();
  raw = createPlatformDatabase(directory);
  assert.equal(raw.db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.deepEqual(
    Buffer.from(raw.db.prepare('SELECT value FROM accounts WHERE id=?').get(user.accountId).value),
    bytes,
  );
  raw.db.close();
  const backup = fs
    .readdirSync(path.join(directory, 'migration-backups'))
    .find((name) => name.startsWith('before-007-'));
  const snapshot = new DatabaseSync(
    path.join(directory, 'migration-backups', backup, 'platform.sqlite'),
    { readOnly: true },
  );
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  snapshot.close();
  assert.deepEqual(
    fs.readFileSync(path.join(directory, 'migration-backups', backup, 'platform.key')),
    fs.readFileSync(path.join(directory, 'platform.key')),
  );
  raw = createPlatformDatabase(directory);
  require('./helpers/platform-inspection.cjs').dropAdminSchema(raw.db);
  raw.db.exec(
    'DROP TABLE email_invitations; DROP TABLE work_schedule_days; DROP TABLE work_schedule_profiles; CREATE TABLE work_schedule_days(bad TEXT); PRAGMA user_version=6',
  );
  raw.db.close();
  assert.throws(() => createPlatformStore(directory));
  raw = createPlatformDatabase(directory);
  assert.equal(raw.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(
    raw.db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_schedule_profiles'").get(),
    undefined,
  );
  assert.deepEqual(
    Buffer.from(raw.db.prepare('SELECT value FROM accounts WHERE id=?').get(user.accountId).value),
    bytes,
  );
  raw.db.close();
});

async function until(condition, context = () => '') {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('Workdays UI timeout: ' + context());
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function ui(f, width, key = 'owner') {
  const { JSDOM, VirtualConsole } = require('jsdom'),
    errors = [],
    vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const root = path.resolve(__dirname, '..');
  const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
    url: f.base,
    runScripts: 'outside-only',
    virtualConsole: vc,
  }).window;
  f.windows.push(w);
  w.structuredClone = structuredClone;
  w.AbortController = AbortController;
  w.confirm = () => true;
  w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
  require('./helpers/action-confirmation.cjs').installActionConfirmation(w);
  w.fetch = (url, options = {}) =>
    fetch(f.base + url, {
      ...options,
      headers: { ...options.headers, Origin: f.base, Cookie: f.cookies[key] },
    });
  require('./helpers/client-bundle.cjs').evaluateClient(w);
  await until(() => !w.document.body.classList.contains('app-loading'));
  return {
    w,
    errors,
    $: (s) => w.document.querySelector(s),
    change(node, value) {
      node.value = value;
      node.dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    submit() {
      w.document
        .querySelector('#editor-form')
        .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    },
  };
}

for (const width of [390, 1440])
  for (const key of ['owner', 'admin', 'staff'])
    test('working grid is visible in day/week for ' + key + ' at ' + width, async (t) => {
      const f = await fixture(t),
        target = key === 'admin' ? f.owner.accountId : f.members[key].accountId;
      await f.request(
        '/api/work-schedules',
        await f.config(target, [day], 'working', [
          ['09:15', '12:30'],
          ['14:00', '17:00'],
        ]),
      );
      const h = await ui(f, width, key),
        { $, w } = h;
      if ($('[data-calendar-date="' + day + '"]')) $('[data-calendar-date="' + day + '"]').click();
      else {
        // Select a date through the common month picker without relying on today's month.
        const input = w.document.querySelector('[data-calendar-date]');
        input.dataset.calendarDate = day;
        input.click();
      }
      if ($('#calendar-grouping')) h.change($('#calendar-grouping'), 'staff');
      if ($('#calendar-schedule-staff')) {
        h.change($('#calendar-schedule-staff'), target);
        await until(() => $('.time-day-heading')?.textContent.includes('09:15'));
        assert.equal(
          $('.calendar-work-schedule'),
          null,
          'Day hours appear in the employee column, without a duplicate caption',
        );
      }
      await until(() =>
        $(
          '[data-slot-date="' + day + '"][data-slot-time="09:00"]',
        )?.dataset.workBackground.includes('--calendar-work-grid'),
      );
      const slot = (time) => $('[data-slot-date="' + day + '"][data-slot-time="' + time + '"]');
      assert.match(slot('09:00').dataset.workBackground, /#e8f3ec 0% 25%/);
      assert.match(slot('12:00').dataset.workBackground, /transparent 0% 50%/);
      assert.equal(slot('13:00').dataset.workBackground, '#e8f3ec');
      assert.equal(slot('14:00').dataset.workBackground, 'var(--calendar-work-grid),#fafbfc');
      assert.ok(slot('14:00').style.background.includes('--calendar-work-grid'));
      assert.equal(slot('13:00').style.backgroundColor, 'rgb(232, 243, 236)');
      assert.equal($('.calendar-work-key'), null);
      for (const mode of ['day', 'week']) {
        $('[data-calendar-mode="' + mode + '"]').click();
        const dateButton = $('[data-calendar-date]');
        dateButton.dataset.calendarDate = day;
        dateButton.click();
        await until(() => slot('09:00')?.dataset.workBackground.includes('--calendar-work-grid'));
      }
      assert.deepEqual(h.errors, []);
    });
function selectWorkTime(h, index, endpoint, value) {
  const field = h.$('[data-work-' + endpoint + '="' + index + '"]').closest('[data-work-time]');
  const [hour, minute] = value.split(':');
  h.change(field.querySelector('[data-work-hour]'), hour);
  if (hour !== '24') h.change(field.querySelector('[data-work-minute]'), minute);
  assert.equal(field.querySelector('input').value, value);
}
for (const width of [390, 1440])
  test(
    'management exposes date selection, breaks and fixed-frame editor with a calendar shortcut at ' +
      width,
    async (t) => {
      const f = await fixture(t),
        h = await ui(f, width),
        { $, w } = h;
      $('[data-view="settings"]').click();
      await until(() => $('#account-profile-form'));
      assert.equal($('#work-schedules-settings'), null);
      $('[data-view="services"]').click();
      await until(() => $('[data-management-tab="schedule"]'));
      $('[data-management-tab="schedule"]').click();
      await until(() => $('[data-work-date]'));
      const dates = [...w.document.querySelectorAll('[data-work-date]')]
        .slice(0, 2)
        .map((b) => b.dataset.workDate);
      for (const date of dates) $('[data-work-date="' + date + '"]').click();
      assert.equal(w.document.querySelectorAll('[data-work-date][aria-pressed="true"]').length, 2);
      $('[data-work-edit]').click();
      assert.equal($('#editor').open, true);
      assert.ok($('.work-schedule-form.visit-form-grid'));
      selectWorkTime(h, 0, 'start', '09:00');
      selectWorkTime(h, 0, 'end', '13:00');
      $('[data-work-add]').click();
      selectWorkTime(h, 1, 'start', '14:00');
      selectWorkTime(h, 1, 'end', '19:00');
      h.submit();
      await until(() => !$('#editor').open);
      await until(() => $('[data-work-date="' + dates[0] + '"]')?.classList.contains('is-working'));
      assert.equal($('#account-profile-form'), null);
      assert.equal($('[data-management-tab="schedule"]').getAttribute('aria-selected'), 'true');
      const stored = (await f.request(f.url(f.owner.accountId, dates[0], dates[1]))).data;
      assert.deepEqual(stored.days[dates[0]].intervals, [
        ['09:00', '13:00'],
        ['14:00', '19:00'],
      ]);
      assert.deepEqual(stored.days[dates[1]], stored.days[dates[0]]);
      h.change($('#work-schedule-staff'), f.members.staff.accountId);
      await until(() => $('#work-schedule-permission'));
      const permission = $('#work-schedule-permission');
      assert.equal(permission.checked, true);
      permission.checked = false;
      permission.dispatchEvent(new w.Event('change', { bubbles: true }));
      await until(
        () => $('#work-schedule-permission') && $('#work-schedule-permission') !== permission,
      );
      assert.equal($('#work-schedule-permission').checked, false);
      $('[data-view="calendar"]').click();
      if ($('#calendar-grouping')) h.change($('#calendar-grouping'), 'staff');
      await until(
        () => $('#calendar-schedule-staff'),
        () => $('#global-view').textContent.slice(0, 900),
      );
      const calendarSelector = $('#calendar-schedule-staff');
      h.change(calendarSelector, f.owner.accountId);
      await until(
        () =>
          $('#calendar-schedule-staff') !== calendarSelector &&
          $('#calendar-schedule-staff')?.value === f.owner.accountId,
      );
      const shortcut = $(
        width <= 700
          ? '.mobile-calendar-heading [data-open-work-schedule]'
          : '.calendar-actions [data-open-work-schedule]',
      );
      assert.ok(shortcut);
      assert.equal($('.calendar-work-schedule [data-open-work-schedule]'), null);
      shortcut.click();
      await until(
        () =>
          $('[data-work-date]') &&
          $('[data-management-tab="schedule"]')?.getAttribute('aria-selected') === 'true',
      );
      assert.deepEqual(h.errors, []);
      const css = fs.readFileSync(
        path.join(__dirname, '../src/client/styles/compact-forms.css'),
        'utf8',
      );
      const selector = '#editor:has(.visit-form-grid)';
      const mobileFrame = postcss
        .parse(css)
        .nodes.find(
          (node) =>
            node.type === 'atrule' &&
            node.name === 'media' &&
            node.params.replace(/[\t\n\f\r ]/g, '') === '(max-width:700px)' &&
            node.nodes?.some((rule) => rule.type === 'rule' && rule.selector === selector),
        );
      assert.ok(mobileFrame, 'Visit editor must retain its mobile-only frame');
      const editorFrame = mobileFrame.nodes.find(
        (node) => node.type === 'rule' && node.selector === selector,
      );
      assert.equal(
        editorFrame.nodes.find((node) => node.type === 'decl' && node.prop === 'height')?.value,
        'calc(100dvh - 16px)',
      );
    },
  );

for (const width of [320, 1440])
  test(
    'both schedule endpoints use matching hour/minute choices, retain exact minutes and enforce midnight at ' +
      width,
    async (t) => {
      const f = await fixture(t);
      let h = await ui(f, width),
        $ = h.$;
      $('[data-view="services"]').click();
      $('[data-management-tab="schedule"]').click();
      await until(() => $('[data-work-date]'));
      const date = $('[data-work-date]').dataset.workDate;
      $('[data-work-date]').click();
      $('[data-work-edit]').click();
      assert.equal($('[data-work-start="0"]').value, '08:00');
      assert.equal($('[data-work-end="0"]').value, '20:00');
      for (const endpoint of ['start', 'end'])
        assert.deepEqual(
          [
            ...$('[data-work-' + endpoint + '="0"]')
              .closest('[data-work-time]')
              .querySelector('[data-work-minute]').options,
          ].map((option) => option.value),
          ['00', '15', '30', '45'],
        );
      selectWorkTime(h, 0, 'start', '00:00');
      selectWorkTime(h, 0, 'end', '24:00');
      assert.equal($('[data-work-start="0"]').value, '00:00');
      assert.equal($('[data-work-end="0"]').value, '24:00');
      h.submit();
      await until(() => !$('#editor').open);
      await until(() => $('[data-work-date="' + date + '"]')?.classList.contains('is-working'));
      const fullDay = (await f.request(f.url(f.owner.accountId, date))).data;
      assert.deepEqual(fullDay.days[date].intervals, [['00:00', '24:00']]);
      // Previously stored exact minutes remain valid although new choices use quarter hours.
      const exact = await f.request('/api/work-schedules', {
        staffId: f.owner.accountId,
        dates: [date],
        status: 'working',
        intervals: [['23:07', '23:59']],
        revision: fullDay.revision,
        expectedTimeZone: fullDay.timeZone,
      });
      assert.equal(exact.status, 200);
      h = await ui(f, width);
      $ = h.$;
      $('[data-view="services"]').click();
      $('[data-management-tab="schedule"]').click();
      await until(() => $('[data-work-date="' + date + '"]'));
      $('[data-work-date="' + date + '"]').click();
      $('[data-work-edit]').click();
      const start = $('[data-work-start="0"]').closest('[data-work-time]'),
        end = $('[data-work-end="0"]').closest('[data-work-time]');
      assert.equal(start.querySelector('[data-work-hour]').options.length, 25);
      assert.equal(end.querySelector('[data-work-hour]').options.length, 26);
      assert.deepEqual(
        [...start.querySelector('[data-work-minute]').options].map((option) => option.value),
        ['00', '07', '15', '30', '45'],
      );
      assert.deepEqual(
        [...end.querySelector('[data-work-minute]').options].map((option) => option.value),
        ['00', '15', '30', '45', '59'],
      );
      assert.equal(start.querySelector('[data-work-hour]').checkValidity(), true);
      selectWorkTime(h, 0, 'start', '23:07');
      selectWorkTime(h, 0, 'end', '23:59');
      h.change(end.querySelector('[data-work-hour]'), '24');
      assert.equal(end.querySelector('[data-work-minute]').value, '00');
      assert.equal(end.querySelector('[data-work-minute]').disabled, true);
      h.change(end.querySelector('[data-work-hour]'), '23');
      assert.equal(end.querySelector('[data-work-minute]').disabled, false);
      selectWorkTime(h, 0, 'end', '24:00');
      $('[data-work-add]').click();
      assert.equal($('[data-work-start="0"]').value, '23:07');
      assert.equal($('[data-work-end="0"]').value, '24:00');
      $('[data-work-remove="1"]').click();
      h.change($('#work-day-status'), 'closed');
      h.change($('#work-day-status'), 'working');
      assert.equal(
        $('[data-work-end="0"]').closest('[data-work-time]').querySelector('[data-work-minute]')
          .disabled,
        true,
      );
      h.submit();
      await until(() => !$('#editor').open);
      const stored = (await f.request(f.url(f.owner.accountId, date))).data;
      assert.deepEqual(stored.days[date].intervals, [['23:07', '24:00']]);
      $('[data-work-edit]').click();
      assert.equal(
        $('[data-work-start="0"]').closest('[data-work-time]').querySelector('[data-work-minute]')
          .value,
        '07',
      );
      assert.equal(
        $('[data-work-end="0"]').closest('[data-work-time]').querySelector('[data-work-hour]')
          .value,
        '24',
      );
      assert.deepEqual(h.errors, []);
    },
  );

test('employee management exposes only own dates and owner disabling self-edit prevents the day editor', async (t) => {
  const f = await fixture(t),
    staff = f.members.staff.accountId;
  await f.request('/api/work-schedules/permission', {
    staffId: staff,
    revision: 0,
    allowSelfEdit: false,
  });
  const h = await ui(f, 390, 'staff');
  h.$('[data-view="services"]').click();
  h.$('[data-management-tab="schedule"]').click();
  await until(() => h.$('[data-work-date]'));
  assert.equal(h.$('#work-schedule-staff').options.length, 1);
  assert.equal(h.$('#work-schedule-permission'), null);
  h.$('[data-work-date]').click();
  assert.equal(h.$('[data-work-edit]').disabled, true);
  assert.doesNotMatch(
    h.$('#work-schedules-settings').textContent,
    /Synthetic owner|Вся организация/,
  );
  assert.deepEqual(h.errors, []);
});

test('lost schedule acknowledgement is checked by a scoped read, never by an automatic duplicate write', async (t) => {
  const f = await fixture(t),
    h = await ui(f, 390),
    { $, w } = h;
  $('[data-view="services"]').click();
  $('[data-management-tab="schedule"]').click();
  await until(() => $('[data-work-date]'));
  const date = $('[data-work-date]').dataset.workDate;
  $('[data-work-date]').click();
  $('[data-work-edit]').click();
  h.change($('#work-day-status'), 'closed');
  const realFetch = w.fetch;
  let writes = 0;
  w.fetch = async (url, options = {}) => {
    const result = await realFetch(url, options);
    if (url === '/api/work-schedules' && options.method === 'POST') {
      writes++;
      throw Error('Synthetic lost acknowledgement');
    }
    return result;
  };
  h.submit();
  await until(() => !$('#editor').open);
  assert.equal(writes, 1);
  const stored = (await f.request(f.url(f.owner.accountId, date))).data;
  assert.equal(stored.revision, 1);
  assert.equal(stored.days[date].status, 'closed');
  assert.deepEqual(h.errors, []);
});

test('outside-hours cancellation adds no phantom patient; confirmed override retains normal saving and invitation flow', async (t) => {
  const f = await fixture(t);
  await f.request('/api/work-schedules', await f.config(f.owner.accountId, [day], 'closed', []));
  const h = await ui(f, 390),
    { $, w } = h;
  $('#calendar-new').click();
  await until(() => $('#appointment-patient-add'));
  $('#appointment-patient-add').click();
  $('[name="newFirstName"]').value = 'Synthetic new';
  $('[name="newPhone"]').value = '+70000000001';
  h.change($('[name="date"]'), day);
  $('#appointment-service').open = true;
  const service = $('[data-appointment-service="s"]');
  assert.ok(service);
  service.closest('details').querySelector('summary').click();
  service.click();
  assert.equal(service.disabled, true);
  let warnings = 0;
  w.confirm = () => {
    warnings++;
    return false;
  };
  h.submit();
  await until(() => warnings === 1 && !$('#save-editor').disabled);
  assert.equal($('#editor').open, true);
  assert.equal((await f.read()).patients.length, 1);
  w.confirm = () => true;
  h.submit();
  await until(() => !$('#editor').open);
  const data = await f.read();
  assert.equal(data.patients.length, 2);
  assert.equal(
    data.patients.find((p) => p.firstName === 'Synthetic new').appointments[0].date,
    day,
  );
  assert.deepEqual(h.errors, []);
});
