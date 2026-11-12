const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { assertSchedule, busyIntervals } = require('../src/server/modules/workspace/policy.cjs');
const { createWorkspace } = require('../src/server/modules/workspace/service.cjs');
test('pre-upgrade stored rooms infer layout and staffing without changing saved configuration', () => {
  const saved = {
      revision: 7,
      enabled: false,
      mode: 'shared',
      rooms: [
        { id: 'old1', name: 'Прежний кабинет', active: true, staffIds: ['one', 'two'] },
        { id: 'old2', name: 'Личный кабинет', active: true, staffIds: ['one'] },
      ],
    },
    before = structuredClone(saved);
  const workspace = createWorkspace({ organization: () => ({ workspace: saved }) });
  const settings = workspace.workspaceSettings('synthetic-org');
  assert.equal(settings.roomLayout, 'multiple');
  assert.equal(settings.revision, 7);
  assert.equal(settings.enabled, false);
  assert.deepEqual(
    settings.rooms.map((r) => [r.id, r.staffMode]),
    [
      ['old1', 'multiple'],
      ['old2', 'single'],
    ],
  );
  assert.deepEqual(saved, before);
  saved.rooms[1].active = false;
  assert.equal(workspace.workspaceSettings('synthetic-org').roomLayout, 'single');
});
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-rooms-')),
    platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'rooms-owner@example.test',
    password: 'Rooms-test-owner-password',
    displayName: 'Владелец',
    organizationName: 'Тестовый салон',
  });
  platform.verifyEmail(owner.verificationToken);
  const members = {};
  for (const [key, role] of [
    ['first', 'cosmetologist'],
    ['second', 'cosmetologist'],
    ['admin', 'salon_admin'],
  ]) {
    const invitation = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role,
    });
    members[key] = await platform.acceptInvitation({
      token: invitation.token,
      email: key + '@example.test',
      password: 'Rooms-test-' + key + '-password',
      displayName: 'Тестовый ' + key,
    });
  }
  const other = await platform.registerOwner({
    email: 'other-rooms@example.test',
    password: 'Rooms-test-other-password',
    displayName: 'Другой',
    organizationName: 'Другая организация',
  });
  platform.verifyEmail(other.verificationToken);
  await platform.bootstrapGlobalAdmin({
    email: 'global-rooms@example.test',
    password: 'Rooms-test-global-password',
    displayName: 'Глобальный',
  });
  const clinic = createStorage(path.join(dir, 'tenants', owner.organizationId));
  clinic.write({
    revision: 0,
    services: [],
    patients: [
      {
        id: 'p',
        name: 'PRIVATE-CLIENT',
        phone: 'PRIVATE-PHONE',
        createdBy: owner.accountId,
        appointments: [],
        visits: [
          {
            id: 'v1',
            date: '2020-01-01',
            procedure: 'FIRST-HISTORY',
            staffId: members.first.accountId,
            photos: [],
          },
          {
            id: 'v2',
            date: '2020-01-02',
            procedure: 'SECOND-HISTORY',
            staffId: members.second.accountId,
            photos: [],
          },
        ],
      },
    ],
  });
  const setupToken = (await platform.login('rooms-owner@example.test', 'Rooms-test-owner-password'))
    .token;
  for (const account of [owner, members.first, members.second])
    for (const [date, revision] of [
      ['2030-01-01', 0],
      ['2020-01-01', 1],
    ])
      platform.workSchedules.save(
        setupToken,
        {
          staffId: account.accountId,
          dates: [date],
          status: 'working',
          intervals: [['00:00', '24:00']],
          revision,
          expectedTimeZone: 'Europe/Moscow',
        },
        clinic,
      );
  platform.logout(setupToken);
  clinic.close();
  platform.close();
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: null,
    telegramAutostart: false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const authContexts = new Map();
  async function request(route, body, cookie = '', method = body ? 'POST' : 'GET') {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookie,
        ...authContexts.get(cookie),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json(),
      nextCookie = response.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && response.status === 200)
      authContexts.set(nextCookie, authContextHeaders(data));
    return { status: response.status, data, cookie: nextCookie };
  }
  const cookies = {};
  for (const [key, email, password] of [
    ['owner', 'rooms-owner@example.test', 'Rooms-test-owner-password'],
    ['first', 'first@example.test', 'Rooms-test-first-password'],
    ['second', 'second@example.test', 'Rooms-test-second-password'],
    ['admin', 'admin@example.test', 'Rooms-test-admin-password'],
    ['other', 'other-rooms@example.test', 'Rooms-test-other-password'],
    ['global', 'global-rooms@example.test', 'Rooms-test-global-password'],
  ])
    cookies[key] = (await request('/api/auth/login', { email, password })).cookie;
  const config = () => ({
    revision: 0,
    enabled: true,
    mode: 'shared',
    rooms: [
      {
        id: 'r1',
        name: 'Общий кабинет',
        active: true,
        staffIds: [members.first.accountId, members.second.accountId],
      },
      {
        id: 'r2',
        name: 'Второй кабинет',
        active: true,
        staffIds: [members.first.accountId, members.second.accountId],
      },
    ],
  });
  const read = async (role = 'owner') => (await request('/api/cabinet', null, cookies[role])).data;
  const save = (data, role = 'owner') => request('/api/cabinet', data, cookies[role], 'PUT');
  const appointment = (
    id,
    staff,
    room = 'r1',
    time = '10:00',
    date = '2030-01-01',
    duration = 60,
  ) => ({
    id,
    staffId: members[staff].accountId,
    roomId: room,
    date,
    time,
    duration,
    service: 'PRIVATE-SERVICE',
    notes: 'PRIVATE-NOTE',
  });
  return { request, cookies, config, read, save, appointment, members, owner, base };
}
test('administrator assigns specialists to existing rooms without structural or clinical changes', async (t) => {
  const f = await fixture(t),
    config = f.config();
  config.staffRules = [{ staffId: f.members.first.accountId, preventOverlap: false }];
  assert.equal((await f.request('/api/workspace', config, f.cookies.owner)).status, 200);
  const before = (await f.request('/api/workspace', null, f.cookies.admin)).data,
    cabinet = await f.read(),
    patch = {
      revision: before.revision,
      roomAssignments: [{ id: 'r1', staffMode: 'single', staffIds: [f.members.first.accountId] }],
    };
  assert.equal(before.canEdit, false);
  assert.equal(before.canEditRoomAssignments, true);
  assert.equal(before.canEditRoomOverlap, true);
  assert.equal(
    (await f.request('/api/workspace', null, f.cookies.owner)).data.canEditRoomOverlap,
    true,
  );
  assert.equal(
    (await f.request('/api/workspace', null, f.cookies.first)).data.canEditRoomOverlap,
    false,
  );
  assert.equal(
    (await f.request('/api/workspace', null, f.cookies.first)).data.canEditRoomAssignments,
    false,
  );
  for (const role of ['first', 'global'])
    assert.equal((await f.request('/api/workspace', patch, f.cookies[role])).status, 403);
  assert.equal((await f.request('/api/workspace', patch, f.cookies.other)).status, 400);
  const saved = await f.request('/api/workspace', patch, f.cookies.admin);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.rooms[0], { ...before.rooms[0], ...patch.roomAssignments[0] });
  assert.deepEqual(saved.data.rooms[1], before.rooms[1]);
  for (const field of ['enabled', 'roomLayout', 'staffRules'])
    assert.deepEqual(saved.data[field], before[field]);
  assert.deepEqual(await f.read(), cabinet);
  assert.equal((await f.request('/api/workspace', patch, f.cookies.admin)).status, 409);
  const next = { ...patch, revision: saved.data.revision };
  for (const extra of [
    { rooms: before.rooms },
    { enabled: false },
    { mode: 'separate' },
    { roomLayout: 'single' },
    { staffRules: [] },
    { canEdit: true },
  ])
    assert.equal(
      (await f.request('/api/workspace', { ...next, ...extra }, f.cookies.admin)).status,
      403,
    );
  for (const roomAssignments of [
    [{ ...patch.roomAssignments[0], id: 'new-room' }],
    [{ ...patch.roomAssignments[0], name: 'Другое название' }],
    [{ ...patch.roomAssignments[0], active: false }],
    [{ ...patch.roomAssignments[0], preventOverlap: 'false' }],
    [{ ...patch.roomAssignments[0], preventOverlap: null }],
    [{ ...patch.roomAssignments[0], preventOverlap: 0 }],
    [{ id: 'r1' }],
    [{ id: 'r1', staffMode: 'single' }],
    [{ id: 'r1', staffIds: [f.members.first.accountId] }],
    [],
    [{ ...patch.roomAssignments[0], staffIds: ['foreign'] }],
    [{ ...patch.roomAssignments[0], staffIds: [f.members.admin.accountId] }],
    [{ ...patch.roomAssignments[0], staffIds: [] }],
    [
      {
        ...patch.roomAssignments[0],
        staffIds: [f.members.first.accountId, f.members.first.accountId],
      },
    ],
    [patch.roomAssignments[0], patch.roomAssignments[0]],
  ])
    assert.equal(
      (await f.request('/api/workspace', { ...next, roomAssignments }, f.cookies.admin)).status,
      400,
    );
  const unchanged = (await f.request('/api/workspace', null, f.cookies.owner)).data;
  assert.deepEqual(unchanged.rooms, saved.data.rooms);
  assert.equal(unchanged.revision, saved.data.revision);
  assert.deepEqual(await f.read(), cabinet);
});

test('administrator toggles individual room protection with revision and role boundaries', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/workspace', f.config(), f.cookies.owner)).status, 200);
  const before = (await f.request('/api/workspace', null, f.cookies.admin)).data,
    cabinet = await f.read(),
    patch = {
      revision: before.revision,
      roomAssignments: [{ id: 'r1', preventOverlap: false }],
    };
  for (const role of ['first', 'global'])
    assert.equal((await f.request('/api/workspace', patch, f.cookies[role])).status, 403);
  assert.equal((await f.request('/api/workspace', patch, f.cookies.other)).status, 400);
  const saved = await f.request('/api/workspace', patch, f.cookies.admin);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.canEdit, false);
  assert.equal(saved.data.canEditRoomOverlap, true);
  assert.deepEqual(saved.data.rooms[0], { ...before.rooms[0], preventOverlap: false });
  assert.deepEqual(saved.data.rooms[1], before.rooms[1]);
  for (const field of ['enabled', 'mode', 'roomLayout', 'staffRules'])
    assert.deepEqual(saved.data[field], before[field]);
  assert.deepEqual(await f.read(), cabinet);
  assert.equal((await f.request('/api/workspace', patch, f.cookies.admin)).status, 409);
  const assigned = await f.request(
    '/api/workspace',
    {
      revision: saved.data.revision,
      roomAssignments: [{ id: 'r1', staffMode: 'single', staffIds: [f.members.first.accountId] }],
    },
    f.cookies.admin,
  );
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.rooms[0].preventOverlap, false, 'Omitted protection is preserved');
  const enabled = await f.request(
    '/api/workspace',
    {
      revision: assigned.data.revision,
      roomAssignments: [{ id: 'r1', preventOverlap: true }],
    },
    f.cookies.admin,
  );
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.data.rooms[0], { ...assigned.data.rooms[0], preventOverlap: true });
  assert.deepEqual(await f.read(), cabinet);
});

test('administrator enabling room protection rejects future conflicts atomically and preserves history', async (t) => {
  const f = await fixture(t),
    config = f.config();
  config.enabled = false;
  config.rooms.forEach((room) => {
    room.preventOverlap = false;
  });
  config.staffRules = [{ staffId: f.members.first.accountId, preventOverlap: true }];
  assert.equal((await f.request('/api/workspace', config, f.cookies.owner)).status, 200);
  const cabinet = await f.read();
  cabinet.patients[0].appointments = [
    f.appointment('first', 'first'),
    f.appointment('second', 'second'),
  ];
  assert.equal((await f.save(cabinet)).status, 200);
  const before = await f.read(),
    settings = (await f.request('/api/workspace', null, f.cookies.admin)).data,
    patch = {
      revision: settings.revision,
      roomAssignments: [{ id: 'r1', preventOverlap: true }, { id: 'r2', preventOverlap: true }],
    },
    denied = await f.request('/api/workspace', patch, f.cookies.admin);
  assert.equal(denied.status, 409);
  assert.doesNotMatch(denied.data.error, /PRIVATE/);
  const unchanged = (await f.request('/api/workspace', null, f.cookies.admin)).data;
  assert.equal(unchanged.revision, settings.revision);
  assert.deepEqual(unchanged.rooms, settings.rooms);
  assert.deepEqual(unchanged.staffRules, settings.staffRules);
  assert.deepEqual(await f.read(), before);
  const history = await f.read();
  history.patients[0].appointments.forEach((appointment) => {
    appointment.date = '2020-01-01';
  });
  assert.equal((await f.save(history)).status, 200);
  const savedHistory = await f.read(),
    enabled = await f.request('/api/workspace', patch, f.cookies.admin);
  assert.equal(enabled.status, 200);
  assert.ok(enabled.data.rooms.every((room) => room.preventOverlap));
  assert.deepEqual(enabled.data.staffRules, settings.staffRules);
  assert.deepEqual(await f.read(), savedHistory);
  const staffConflict = await f.read();
  staffConflict.patients[0].appointments.push(
    f.appointment('staff-first', 'first', 'r1', '12:00'),
    f.appointment('staff-second', 'first', 'r2', '12:00'),
  );
  assert.equal((await f.save(staffConflict)).status, 409, 'Personal specialist rule still applies');
  assert.deepEqual(await f.read(), savedHistory);
});

test('room assignment removal protects future bookings even with overlap protection disabled', async (t) => {
  const f = await fixture(t),
    config = f.config();
  config.enabled = false;
  config.rooms.forEach((room) => {
    room.preventOverlap = false;
  });
  assert.equal((await f.request('/api/workspace', config, f.cookies.owner)).status, 200);
  const cabinet = await f.read();
  cabinet.patients[0].appointments = [f.appointment('future', 'first')];
  assert.equal((await f.save(cabinet)).status, 200);
  const before = await f.read(),
    patch = {
      revision: 1,
      roomAssignments: [{ id: 'r1', staffMode: 'single', staffIds: [f.members.second.accountId] }],
    };
  const denied = await f.request('/api/workspace', patch, f.cookies.admin);
  assert.equal(denied.status, 409);
  assert.match(denied.data.error, /будущие записи/);
  assert.doesNotMatch(denied.data.error, /PRIVATE/);
  assert.deepEqual(await f.read(), before);
  assert.equal((await f.request('/api/workspace', null, f.cookies.owner)).data.revision, 1);
  const history = await f.read();
  history.patients[0].appointments = [f.appointment('past', 'first', 'r1', '10:00', '2020-01-01')];
  assert.equal((await f.save(history)).status, 200);
  const savedHistory = await f.read();
  assert.equal((await f.request('/api/workspace', patch, f.cookies.admin)).status, 200);
  assert.deepEqual(await f.read(), savedHistory);
  assert.equal(savedHistory.patients[0].appointments[0].roomId, 'r1');
});

test('assignments cannot silently change or make ambiguous the room of a future legacy booking', async (t) => {
  const f = await fixture(t),
    config = f.config();
  config.enabled = false;
  config.rooms.forEach((room, index) => {
    room.preventOverlap = false;
    room.staffIds = [f.members[index ? 'second' : 'first'].accountId];
  });
  assert.equal((await f.request('/api/workspace', config, f.cookies.owner)).status, 200);
  const cabinet = await f.read(),
    appointment = f.appointment('legacy', 'first');
  delete appointment.roomId;
  cabinet.patients[0].appointments = [appointment];
  assert.equal((await f.save(cabinet)).status, 200);
  const before = await f.read();
  for (const roomAssignments of [
    [
      {
        id: 'r2',
        staffMode: 'multiple',
        staffIds: [f.members.first.accountId, f.members.second.accountId],
      },
    ],
    [
      { id: 'r1', staffMode: 'single', staffIds: [f.members.second.accountId] },
      { id: 'r2', staffMode: 'single', staffIds: [f.members.first.accountId] },
    ],
  ]) {
    const denied = await f.request(
      '/api/workspace',
      { revision: 1, roomAssignments },
      f.cookies.admin,
    );
    assert.equal(denied.status, 409);
    assert.match(denied.data.error, /без указанного кабинета/);
  }
  assert.deepEqual(await f.read(), before);
  assert.equal((await f.request('/api/workspace', null, f.cookies.owner)).data.revision, 1);
});

test('individual staff rules stay private and schedule validation applies to owner and administrator', async (t) => {
  const f = await fixture(t),
    config = f.config();
  config.enabled = false;
  config.rooms.forEach((room) => {
    room.preventOverlap = false;
  });
  config.staffRules = [
    { staffId: f.members.first.accountId, preventOverlap: true },
    { staffId: f.members.second.accountId, preventOverlap: false },
  ];
  assert.equal((await f.request('/api/workspace', config, f.cookies.owner)).status, 200);
  const own = (await f.request('/api/workspace', null, f.cookies.first)).data;
  assert.deepEqual(own.staffRules, [config.staffRules[0]]);
  assert.doesNotMatch(JSON.stringify(own), new RegExp(f.members.second.accountId));
  const second = await f.read('second');
  second.patients[0].appointments.push(
    f.appointment('a', 'second', 'r1'),
    f.appointment('b', 'second', 'r2'),
  );
  assert.equal((await f.save(second, 'second')).status, 200);
  const first = await f.read('first');
  first.patients[0].appointments.push(
    f.appointment('c', 'first', 'r1'),
    f.appointment('d', 'first', 'r2'),
  );
  assert.equal((await f.save(first, 'first')).status, 409);
  assert.equal((await f.read()).patients[0].appointments.length, 2);
  const next = {
    ...config,
    revision: 1,
    staffRules: config.staffRules.map((rule) => ({ ...rule, preventOverlap: true })),
  };
  assert.equal((await f.request('/api/workspace', next, f.cookies.admin)).status, 403);
  assert.equal(
    (
      await f.request(
        '/api/workspace',
        { revision: next.revision, staffRules: next.staffRules },
        f.cookies.admin,
      )
    ).status,
    409,
  );
  assert.equal((await f.request('/api/workspace', next, f.cookies.owner)).status, 409);
  const unchanged = (await f.request('/api/workspace', null, f.cookies.owner)).data;
  assert.equal(unchanged.revision, 1);
  assert.deepEqual(unchanged.staffRules, config.staffRules);
  next.staffRules = [{ staffId: 'other-organization-staff', preventOverlap: true }];
  assert.equal((await f.request('/api/workspace', next, f.cookies.owner)).status, 400);
});

test('administrator updates only staff rules with revision checks and no room changes', async (t) => {
  const f = await fixture(t),
    before = (await f.request('/api/workspace', null, f.cookies.admin)).data;
  assert.equal(before.canEdit, false);
  assert.equal(before.canEditStaffRules, true);
  const patch = {
    revision: before.revision,
    staffRules: [{ staffId: f.members.first.accountId, preventOverlap: true }],
  };
  for (const role of ['first', 'global'])
    assert.equal((await f.request('/api/workspace', patch, f.cookies[role])).status, 403);
  assert.equal((await f.request('/api/workspace', patch, f.cookies.other)).status, 400);
  const saved = await f.request('/api/workspace', patch, f.cookies.admin);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.staffRules, patch.staffRules);
  assert.deepEqual(saved.data.rooms, before.rooms);
  for (const field of ['enabled', 'mode', 'roomLayout'])
    assert.equal(saved.data[field], before[field]);
  assert.equal((await f.request('/api/workspace', patch, f.cookies.admin)).status, 409);
  const next = { ...patch, revision: saved.data.revision };
  for (const extra of [
    { rooms: before.rooms },
    { enabled: true },
    { mode: 'shared' },
    { roomLayout: 'multiple' },
    { canEdit: true },
  ])
    assert.equal(
      (await f.request('/api/workspace', { ...next, ...extra }, f.cookies.admin)).status,
      403,
    );
  assert.equal(
    (
      await f.request(
        '/api/workspace',
        { ...next, staffRules: [{ staffId: 'foreign', preventOverlap: true }] },
        f.cookies.admin,
      )
    ).status,
    400,
  );
  const unchanged = (await f.request('/api/workspace', null, f.cookies.owner)).data;
  assert.equal(unchanged.revision, saved.data.revision);
  assert.deepEqual(unchanged.rooms, before.rooms);
  const own = (await f.request('/api/workspace', null, f.cookies.first)).data;
  assert.equal(own.canEditStaffRules, false);
});

test('workspace permissions, tenant separation, revision and room assignments are server-enforced', async (t) => {
  const f = await fixture(t),
    c = f.config();
  assert.equal((await f.request('/api/workspace')).status, 401);
  assert.equal((await f.request('/api/workspace', null, f.cookies.global)).status, 403);
  assert.equal((await f.request('/api/workspace', c, f.cookies.first)).status, 403);
  assert.equal((await f.request('/api/workspace', c, f.cookies.admin)).status, 403);
  assert.equal((await f.request('/api/workspace', c, f.cookies.owner)).status, 200);
  const own = (await f.request('/api/workspace', null, f.cookies.first)).data;
  assert.equal(own.rooms.length, 2);
  assert.deepEqual(own.members, []);
  assert.ok(
    own.rooms.every((r) => Object.keys(r).sort().join(',') === 'active,id,name,preventOverlap'),
  );
  assert.equal(own.canEdit, false);
  const other = (await f.request('/api/workspace', null, f.cookies.other)).data;
  assert.equal(other.rooms.length, 1);
  assert.equal(other.rooms[0].name, 'Основной кабинет');
  assert.equal(other.roomLayout, 'single');
  assert.equal(other.enabled, false);
  assert.equal((await f.request('/api/workspace', c, f.cookies.owner)).status, 409);
  const invalid = { ...c, revision: 1, mode: 'separate' };
  assert.equal((await f.request('/api/workspace', invalid, f.cookies.owner)).status, 400);
  invalid.mode = 'shared';
  invalid.rooms[0].staffIds.push('other-organization-staff');
  assert.equal((await f.request('/api/workspace', invalid, f.cookies.owner)).status, 400);
  assert.equal((await f.request('/api/workspace', null, f.cookies.owner)).data.revision, 1);
  for (const query of [
    'from=bad&to=2030-01-01',
    'from=2030-02-30&to=2030-03-01',
    'from=2030-01-02&to=2030-01-01',
    'from=2030-01-01&to=2031-01-01',
  ])
    assert.equal(
      (await f.request('/api/workspace/availability?' + query, null, f.cookies.first)).status,
      400,
    );
});

test('default room is stable, protected by default, owner-only, and does not rewrite cabinet data', async (t) => {
  const f = await fixture(t),
    before = await f.read();
  const first = (await f.request('/api/workspace', null, f.cookies.owner)).data,
    second = (await f.request('/api/workspace', null, f.cookies.owner)).data;
  assert.deepEqual(first, second);
  assert.equal(first.revision, 0);
  assert.equal(first.enabled, false);
  assert.equal(first.roomLayout, 'single');
  assert.deepEqual(first.rooms, [
    {
      id: 'main',
      name: 'Основной кабинет',
      active: true,
      preventOverlap: true,
      staffMode: 'single',
      staffIds: [f.owner.accountId],
    },
  ]);
  assert.deepEqual((await f.request('/api/workspace', null, f.cookies.first)).data.rooms, []);
  assert.deepEqual(await f.read(), before);
  const {
    members,
    canEdit,
    canEditStaffRules,
    canEditRoomAssignments,
    canEditRoomOverlap,
    ...values
  } = first;
  assert.equal((await f.request('/api/workspace', values, f.cookies.owner)).status, 200);
  assert.deepEqual(await f.read(), before);
  assert.equal((await f.request('/api/workspace', null, f.cookies.owner)).data.revision, 1);
});

test('per-room single/multiple staffing supports mixed rooms and protects single-room transitions', async (t) => {
  const f = await fixture(t),
    c = f.config();
  c.roomLayout = 'multiple';
  c.mode = 'separate';
  c.rooms[0].staffMode = 'multiple';
  c.rooms[1].staffMode = 'single';
  c.rooms[1].staffIds = [f.members.first.accountId];
  const saved = await f.request('/api/workspace', c, f.cookies.owner);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.mode, 'shared');
  assert.deepEqual(
    saved.data.rooms.map((r) => r.staffMode),
    ['multiple', 'single'],
  );
  const invalid = { ...c, revision: 1, roomLayout: 'single' };
  assert.equal((await f.request('/api/workspace', invalid, f.cookies.owner)).status, 400);
  invalid.roomLayout = 'multiple';
  invalid.rooms = structuredClone(c.rooms);
  invalid.rooms[0].staffMode = 'single';
  assert.equal((await f.request('/api/workspace', invalid, f.cookies.owner)).status, 400);
  invalid.rooms[0].staffMode = 'bad';
  assert.equal((await f.request('/api/workspace', invalid, f.cookies.owner)).status, 400);
  invalid.rooms[0].staffMode = 'multiple';
  invalid.rooms[0].staffIds = [];
  assert.equal((await f.request('/api/workspace', invalid, f.cookies.owner)).status, 400);
  const data = await f.read();
  data.patients[0].appointments = [f.appointment('used', 'first', 'r2')];
  assert.equal((await f.save(data)).status, 200);
  const one = { ...c, revision: 1, roomLayout: 'single', rooms: structuredClone(c.rooms) };
  one.rooms[1].active = false;
  assert.equal((await f.request('/api/workspace', one, f.cookies.owner)).status, 409);
  const before = await f.read();
  one.enabled = false;
  one.rooms.forEach((room) => {
    room.preventOverlap = false;
  });
  assert.equal((await f.request('/api/workspace', one, f.cookies.owner)).status, 200);
  assert.deepEqual(await f.read(), before);
  assert.equal((await f.request('/api/workspace', null, f.cookies.owner)).data.rooms.length, 2);
  one.revision = 2;
  one.rooms = one.rooms.slice(0, 1);
  assert.equal((await f.request('/api/workspace', one, f.cookies.owner)).status, 409);
});
test('shared rooms prohibit physical and specialist overlaps, allow adjacent appointments and concurrent different rooms', async (t) => {
  const f = await fixture(t);
  await f.request('/api/workspace', f.config(), f.cookies.owner);
  let state = await f.read();
  state.patients[0].appointments = [f.appointment('a', 'first')];
  assert.equal((await f.save(state)).status, 200);
  for (const [staff, room, time, expected] of [
    ['second', 'r1', '10:30', 409],
    ['first', 'r2', '10:30', 409],
    ['second', 'r2', '10:30', 200],
    ['second', 'r1', '11:30', 200],
  ]) {
    state = await f.read();
    state.patients[0].appointments.push(f.appointment('b-' + time + '-' + room, staff, room, time));
    const result = await f.save(state);
    assert.equal(result.status, expected);
    if (expected !== 200) assert.doesNotMatch(result.data.error, /PRIVATE|Тестовый/);
  }
  const before = await f.read(),
    first = await f.read('first'),
    second = await f.read('second');
  assert.equal(before.patients[0].visits.length, 2);
  assert.deepEqual(
    first.patients[0].visits.map((v) => v.procedure),
    ['FIRST-HISTORY'],
  );
  assert.deepEqual(
    second.patients[0].visits.map((v) => v.procedure),
    ['SECOND-HISTORY'],
  );
  assert.ok(first.patients[0].appointments.every((a) => a.staffId === f.members.first.accountId));
  assert.ok(second.patients[0].appointments.every((a) => a.staffId === f.members.second.accountId));
  const busy = (
    await f.request(
      '/api/workspace/availability?from=2030-01-01&to=2030-01-01',
      null,
      f.cookies.first,
    )
  ).data.busy;
  assert.equal(busy.length, 2);
  for (const interval of busy)
    assert.deepEqual(Object.keys(interval).sort(), ['date', 'duration', 'roomId', 'time']);
  assert.doesNotMatch(
    JSON.stringify(busy),
    /PRIVATE|staffId|patientId|appointmentId|SECOND-HISTORY/,
  );
  const fresh = await f.read('first');
  fresh.patients[0].appointments.push(f.appointment('foreign-room', 'first', 'r-unknown', '14:00'));
  assert.equal((await f.save(fresh, 'first')).status, 409);
  assert.deepEqual(await f.read(), before);
});
test('separate mode supports several exclusive rooms per specialist and protects configuration changes', async (t) => {
  const f = await fixture(t),
    c = f.config();
  c.mode = 'separate';
  c.rooms[0].staffIds = [f.members.first.accountId];
  c.rooms[1].staffIds = [f.members.first.accountId];
  c.rooms.push({
    id: 'r3',
    name: 'Кабинет другого сотрудника',
    active: true,
    staffIds: [f.members.second.accountId],
  });
  assert.equal((await f.request('/api/workspace', c, f.cookies.owner)).status, 200);
  const data = await f.read();
  data.patients[0].appointments = [
    f.appointment('a', 'first', 'r1'),
    f.appointment('b', 'second', 'r3'),
  ];
  assert.equal((await f.save(data)).status, 200);
  assert.equal((await f.request('/api/workspace', null, f.cookies.first)).data.rooms.length, 2);
  assert.deepEqual(
    (
      await f.request(
        '/api/workspace/availability?from=2030-01-01&to=2030-01-01',
        null,
        f.cookies.first,
      )
    ).data.busy,
    [],
  );
  const incoming = await f.read('first');
  incoming.patients[0].appointments.push(f.appointment('forbidden', 'first', 'r3', '14:00'));
  assert.equal((await f.save(incoming, 'first')).status, 409);
  c.revision = 1;
  c.rooms = c.rooms.filter((r) => r.id !== 'r3');
  assert.equal((await f.request('/api/workspace', c, f.cookies.owner)).status, 409);
  assert.equal((await f.request('/api/workspace', null, f.cookies.owner)).data.rooms.length, 3);
});
test('legacy bookings remain unchanged and activation waits for unambiguous rooms; concurrent saves cannot double-book', async (t) => {
  const f = await fixture(t),
    unprotected = f.config();
  unprotected.enabled = false;
  unprotected.rooms.forEach((room) => {
    room.preventOverlap = false;
  });
  assert.equal((await f.request('/api/workspace', unprotected, f.cookies.owner)).status, 200);
  const legacy = await f.read();
  const a = f.appointment('legacy', 'first');
  delete a.roomId;
  legacy.patients[0].appointments = [a];
  assert.equal((await f.save(legacy)).status, 200);
  const c = f.config();
  c.revision = 1;
  assert.equal((await f.request('/api/workspace', c, f.cookies.owner)).status, 409);
  assert.equal((await f.request('/api/workspace', null, f.cookies.owner)).data.enabled, false);
  c.enabled = false;
  c.rooms.forEach((room) => {
    room.preventOverlap = false;
  });
  assert.equal((await f.request('/api/workspace', c, f.cookies.owner)).status, 200);
  const assigned = await f.read();
  assigned.patients[0].appointments[0].roomId = 'r1';
  assert.equal((await f.save(assigned)).status, 200);
  c.revision = 2;
  c.enabled = true;
  c.rooms.forEach((room) => {
    room.preventOverlap = true;
  });
  assert.equal((await f.request('/api/workspace', c, f.cookies.owner)).status, 200);
  const first = await f.read('first'),
    second = await f.read('second');
  first.patients[0].appointments.push(f.appointment('x', 'first', 'r2', '14:00'));
  second.patients[0].appointments.push(f.appointment('y', 'second', 'r2', '14:00'));
  const results = await Promise.all([f.save(first, 'first'), f.save(second, 'second')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const final = await f.read();
  assert.equal(final.patients[0].appointments.filter((a) => a.time === '14:00').length, 1);
});
test('cross-midnight conflicts and anonymous merging preserve duration without leaking booking count', () => {
  const config = {
    enabled: true,
    mode: 'shared',
    rooms: [{ id: 'r', name: 'Общий', active: true, staffIds: ['one', 'two'] }],
  };
  const a = {
    id: 'private-a',
    date: '2030-01-01',
    time: '23:30',
    duration: 90,
    staffId: 'two',
    roomId: 'r',
    service: 'SECRET',
  };
  const b = {
    id: 'private-b',
    date: '2030-01-02',
    time: '01:00',
    duration: 30,
    staffId: 'two',
    roomId: 'r',
  };
  const state = { patients: [{ id: 'secret-client', appointments: [a, b] }] };
  assert.deepEqual(
    busyIntervals(
      config,
      state,
      { role: 'cosmetologist', accountId: 'one' },
      '2030-01-01',
      '2030-01-02',
    ),
    [
      { roomId: 'r', date: '2030-01-01', time: '23:30', duration: 30 },
      { roomId: 'r', date: '2030-01-02', time: '00:00', duration: 90 },
    ],
  );
  state.patients[0].appointments.push({ ...b, id: 'overlap', staffId: 'one', time: '00:30' });
  assert.throws(() => assertSchedule(config, state, new Set(['one', 'two']), 'Europe/Moscow', 0), {
    status: 409,
  });
});
