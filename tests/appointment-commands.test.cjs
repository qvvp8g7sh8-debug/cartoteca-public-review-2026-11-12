const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const {
  validateAppointmentCommand,
} = require('../src/server/modules/cabinet/appointment-commands.cjs');
const { readReceipt } = require('../src/server/infrastructure/mutation-receipts.cjs');

async function fixture(t, withStaff = false, schema = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-appointment-command-'));
  let platform, storage;
  t.after(() => {
    storage?.close();
    platform?.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.match(path.basename(target), /^cartoteca-appointment-command-/);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  platform = createPlatformStore(path.join(directory, 'platform'));
  const owner = await platform.registerOwner({
    email: 'command@example.test',
    password: 'Synthetic-command-password',
    displayName: 'Synthetic',
    organizationName: 'Synthetic',
  });
  platform.verifyEmail(owner.verificationToken);
  const token = (await platform.login('command@example.test', 'Synthetic-command-password')).token;
  let staff, staffToken;
  if (withStaff) {
    const invitation = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role: 'cosmetologist',
    });
    staff = await platform.acceptInvitation({
      token: invitation.token,
      email: 'staff-command@example.test',
      password: 'Synthetic-staff-password',
      displayName: 'Synthetic staff',
    });
    staffToken = (await platform.login('staff-command@example.test', 'Synthetic-staff-password'))
      .token;
  }
  storage = createStorage(path.join(directory, 'tenant'));
  const appointment = (id, time, staffId = owner.accountId) => ({
    id,
    date: '2035-01-01',
    time,
    duration: 30,
    staffId,
    roomId: 'main',
    status: 'scheduled',
    service: 'Synthetic',
  });
  const first = {
    id: 'first',
    name: 'Synthetic client',
    createdBy: owner.accountId,
    notes: 'Profile preserved',
    visits: [
      {
        id: 'visit',
        date: '2020-01-01',
        staffId: owner.accountId,
        procedure: 'Synthetic private history',
        photos: [],
      },
    ],
    appointments: [appointment('a', '09:00'), appointment('b', '11:00', staff?.accountId)],
  };
  storage.write({
    revision: 0,
    patients: [
      first,
      {
        id: 'private',
        name: 'Synthetic private',
        createdBy: owner.accountId,
        visits: [],
        appointments: [],
      },
    ],
    services: [],
  });
  if (schema === 2) {
    require('../src/server/migrations/002-cabinet-records.cjs').migrateCabinetRecords(storage);
    storage.close();
    storage = createStorage(path.join(directory, 'tenant'), { cabinetSchema: 2 });
  }
  if (staff) {
    const settings = platform.workspaceSettings(owner.organizationId);
    platform.saveWorkspace(
      owner.organizationId,
      owner.accountId,
      {
        ...settings,
        roomLayout: 'single',
        rooms: [
          {
            ...settings.rooms[0],
            staffMode: 'multiple',
            staffIds: [owner.accountId, staff.accountId],
          },
        ],
      },
      () => storage.read(),
    );
  }
  for (const staffId of [owner.accountId, ...(staff ? [staff.accountId] : [])])
    platform.workSchedules.save(
      token,
      {
        dates: ['2035-01-01'],
        staffId,
        status: 'working',
        intervals: [['00:00', '24:00']],
        revision: 0,
        expectedTimeZone: 'Europe/Moscow',
      },
      storage,
    );
  const makeContext = (sessionToken) => ({
    current: platform.session(sessionToken),
    platform,
    token: sessionToken,
    req: { headers: {} },
    tenantStore: (org) => {
      assert.equal(org, owner.organizationId);
      return storage;
    },
    assertCurrent() {
      if (!platform.session(sessionToken))
        throw Object.assign(Error('Synthetic signed out'), { status: 401 });
    },
  });
  const context = makeContext(token),
    staffContext = staffToken && makeContext(staffToken);
  const command = (id = 'a', changes = {}) => {
    const before = storage
      .readSelected(['first'])
      .patients[0].appointments.find((a) => a.id === id);
    return {
      revision: storage.get('revision'),
      patientId: 'first',
      changes: [{ id, before: structuredClone(before), after: { ...before, ...changes } }],
    };
  };
  const save = (body, operation = 'synthetic-appointment-command', ctx = context) => {
    ctx.req.headers['x-cartoteca-operation'] = operation;
    return saveMutation(ctx, body, { appointmentCommand: true });
  };
  return { platform, storage, owner, token, staff, context, staffContext, command, save };
}

test('appointment command validates the narrow envelope and distinct expected versions', () => {
  const valid = {
    revision: 0,
    patientId: 'p',
    changes: [{ id: 'a', before: null, after: { id: 'a' } }],
  };
  assert.equal(validateAppointmentCommand(valid), valid);
  for (const body of [
    null,
    [],
    { ...valid, patients: [] },
    { ...valid, revision: -1 },
    { ...valid, patientId: '' },
    { ...valid, changes: [] },
    { ...valid, changes: [...valid.changes, ...valid.changes] },
    { ...valid, changes: [{ id: 'a', before: null, after: null }] },
    { ...valid, changes: [{ id: 'a', before: null, after: { id: 'b' } }] },
    { ...valid, changes: [{ id: 'a', after: { id: 'a' } }] },
    { ...valid, changes: [{ ...valid.changes[0], profile: {} }] },
  ])
    assert.throws(
      () => validateAppointmentCommand(body),
      (error) => error.status === 400,
    );
});

test('command preserves current profile/history and unrelated appointments changed during preparation', async (t) => {
  const f = await fixture(t),
    body = f.command('a', { notes: 'Our appointment' }),
    prepare = f.storage.prepareWrite;
  f.storage.prepareWrite = (...args) => {
    const token = prepare(...args),
      concurrent = f.storage.readSelected(['first']);
    concurrent.patients[0].notes = 'Concurrent profile';
    concurrent.patients[0].appointments[1].notes = 'Concurrent other appointment';
    f.storage.write(concurrent, { changedIds: { patients: ['first'], services: [] } });
    return token;
  };
  const saved = await f.save(body);
  assert.equal(saved.revision, 3);
  const patient = f.storage.readSelected(['first']).patients[0];
  assert.equal(patient.notes, 'Concurrent profile');
  assert.equal(patient.visits[0].procedure, 'Synthetic private history');
  assert.deepEqual(
    patient.appointments.map((a) => a.notes),
    ['Our appointment', 'Concurrent other appointment'],
  );
});

test('same appointment conflict is checked again under lock without partial writes', async (t) => {
  const f = await fixture(t),
    body = f.command('a', { notes: 'Must not overwrite' }),
    prepare = f.storage.prepareWrite;
  f.storage.prepareWrite = (...args) => {
    const token = prepare(...args),
      concurrent = f.storage.readSelected(['first']);
    concurrent.patients[0].appointments[0].notes = 'Concurrent winner';
    f.storage.write(concurrent, { changedIds: { patients: ['first'], services: [] } });
    return token;
  };
  await assert.rejects(f.save(body), (error) => error.status === 409);
  assert.equal(f.storage.get('revision'), 2);
  assert.equal(f.storage.read().patients[0].appointments[0].notes, 'Concurrent winner');
  assert.equal(f.storage.get('mutation-operation-index', []).length, 0);
});

test('original command identity replays a lost response before expansion and rejects altered command', async (t) => {
  const f = await fixture(t),
    body = f.command('a', { time: '09:30' });
  const saved = await f.save(body),
    revision = f.storage.get('revision');
  assert.deepEqual(await f.save(body), saved);
  assert.equal(f.storage.get('revision'), revision);
  const receipt = readReceipt(f.storage, f.context.current, 'synthetic-appointment-command');
  assert.deepEqual(receipt.saved, saved);
  assert.deepEqual(receipt.recipe, { patients: [{ id: 'first', after: {} }], services: [] });
  await assert.rejects(
    f.save({ ...body, revision: body.revision + 1 }),
    (error) => error.status === 409,
  );
  assert.equal(f.storage.get('revision'), revision);
});

test('staff changes only own appointment and response excludes protected history', async (t) => {
  const f = await fixture(t, true),
    route = require('../src/server/modules/cabinet/routes.cjs').routes.find(
      (r) => r.path === '/api/cabinet/appointments',
    );
  assert.equal(route.method, 'POST');
  assert.equal(route.access, 'organization');
  const body = f.command('b', { notes: 'Staff appointment' });
  body.changes[0].before.telegramConfirmedAt = 123;
  body.changes[0].after.notificationConfirmedAt = 456;
  let response;
  Object.assign(f.staffContext, {
    readBody: async () => body,
    res: {},
    appointmentState: { decorate: (value) => value },
    json: (_res, status, value) => {
      response = { status, value };
    },
  });
  await route.handle(f.staffContext);
  assert.equal(response.status, 200);
  assert.equal(response.value.patients.length, 1);
  assert.deepEqual(response.value.patients[0].visits, []);
  assert.deepEqual(
    response.value.patients[0].appointments.map((a) => a.id),
    ['b'],
  );
  assert.equal(response.value.patients[0].appointments[0].notificationConfirmedAt, undefined);
  const stored = f.storage.read().patients[0];
  assert.equal(stored.visits.length, 1);
  assert.equal(stored.appointments.length, 2);
  await assert.rejects(
    f.save(f.command('a', { notes: 'Forbidden' }), 'synthetic-forbidden-owner', f.staffContext),
    (error) => error.status === 403,
  );
  await assert.rejects(
    f.save({ ...f.command('b'), patientId: 'private' }, 'synthetic-hidden-patient', f.staffContext),
    (error) => error.status === 404,
  );
});

test('create/delete and occupancy use the common pipeline and malformed appointment does not commit', async (t) => {
  const f = await fixture(t);
  const third = { ...f.command().changes[0].before, id: 'c', time: '13:00' };
  const create = {
    revision: 1,
    patientId: 'first',
    changes: [{ id: 'c', before: null, after: third }],
  };
  await f.save(create, 'synthetic-command-create');
  assert.equal(f.storage.read().patients[0].appointments.length, 3);
  await assert.rejects(
    f.save(f.command('c', { time: '09:00' }), 'synthetic-command-overlap'),
    (error) => error.status === 409,
  );
  await assert.rejects(
    f.save(f.command('c', { duration: 7 }), 'synthetic-command-duration'),
    (error) => error.status === 400,
  );
  const remove = f.command('c');
  remove.changes[0].after = null;
  await f.save(remove, 'synthetic-command-remove');
  assert.deepEqual(
    f.storage.read().patients[0].appointments.map((a) => a.id),
    ['a', 'b'],
  );
  assert.equal(f.storage.get('revision'), 3);
});

test('command rechecks revocation and cannot replace the patient envelope', async (t) => {
  const f = await fixture(t),
    body = f.command('a', { notes: 'Denied' }),
    prepare = f.storage.prepareWrite;
  f.storage.prepareWrite = (...args) => {
    const token = prepare(...args);
    f.platform.logout(f.token);
    return token;
  };
  await assert.rejects(f.save(body), (error) => error.status === 401);
  assert.equal(f.storage.get('revision'), 1);
  assert.throws(
    () => validateAppointmentCommand({ ...body, services: [] }),
    (error) => error.status === 400,
  );
});

test('legacy PATCH appointment optimization keeps original body identity, response and receipt replay', async (t) => {
  const f = await fixture(t),
    before = f.storage.readSelected(['first']),
    after = structuredClone(before.patients[0]);
  after.appointments[0].notes = 'Legacy notes only';
  const body = {
    revision: before.revision,
    patients: [{ id: 'first', before: structuredClone(before.patients[0]), after }],
    services: [],
  };
  f.context.req.headers['x-cartoteca-operation'] = 'legacy-appointment-only145';
  const bytes = JSON.stringify(body);
  const saved = await saveMutation(f.context, body, { partial: true });
  assert.equal(JSON.stringify(body), bytes);
  assert.equal(saved.patients[0].appointments[0].notes, 'Legacy notes only');
  const revision = f.storage.get('revision');
  assert.deepEqual(await saveMutation(f.context, JSON.parse(bytes), { partial: true }), saved);
  assert.equal(f.storage.get('revision'), revision);
  const altered = JSON.parse(bytes);
  altered.patients[0].after.appointments[0].notes = 'Different original body';
  await assert.rejects(
    saveMutation(f.context, altered, { partial: true }),
    (error) => error.status === 409,
  );
  assert.equal(f.storage.get('revision'), revision);
});

test('legacy PATCH optimization rechecks whole history CAS after preparation and cannot overwrite an unrelated visit edit', async (t) => {
  const f = await fixture(t),
    before = f.storage.readSelected(['first']),
    after = structuredClone(before.patients[0]);
  after.appointments[0].notes = 'Must not commit';
  const body = {
    revision: before.revision,
    patients: [{ id: 'first', before: structuredClone(before.patients[0]), after }],
    services: [],
  };
  f.context.req.headers['x-cartoteca-operation'] = 'legacy-full-before-cas145';
  const prepare = f.storage.prepareWrite;
  let changed = false;
  f.storage.prepareWrite = (...args) => {
    const prepared = prepare(...args);
    if (!changed) {
      changed = true;
      const latest = f.storage.readSelected(['first']);
      latest.patients[0].visits[0].notes = 'Concurrent visit note';
      f.storage.write(latest, { changedIds: { patients: ['first'], services: [] } });
    }
    return prepared;
  };
  await assert.rejects(
    saveMutation(f.context, body, { partial: true }),
    (error) => error.status === 409,
  );
  const current = f.storage.readSelected(['first']).patients[0];
  assert.equal(current.visits[0].notes, 'Concurrent visit note');
  assert.equal(current.appointments[0].notes, undefined);
  assert.equal(readReceipt(f.storage, f.context.current, 'legacy-full-before-cas145'), null);
});

test('schema2 narrow SAVE preserves history, fresh scheduling/conflicts, canonical indexes and receipt replay', async (t) => {
  const f = await fixture(t, false, 2),
    original = f.storage.readSelected(['first']).patients[0],
    summary = f.storage.indexes.summaries(f.context.current, ['first'])[0],
    body = f.command('a', { time: '09:30', notes: 'Delta' });
  const saved = await f.save(body, 'synthetic-schema2-command145');
  assert.deepEqual(saved.patients[0].visits, original.visits);
  assert.equal(saved.patients[0].notes, original.notes);
  assert.equal(saved.patients[0].appointments[0].time, '09:30');
  const afterSummary = f.storage.indexes.summaries(f.context.current, ['first'])[0];
  assert.equal(afterSummary.visitCount, summary.visitCount);
  assert.deepEqual(afterSummary.lastVisit, summary.lastVisit);
  assert.deepEqual(await f.save(body, 'synthetic-schema2-command145'), saved);
  const conflict = f.command('a', { time: '11:00' });
  await assert.rejects(f.save(conflict, 'synthetic-schema2-conflict145'), (error) =>
    [409, 400].includes(error.status),
  );
  assert.equal(f.storage.readSelected(['first']).patients[0].appointments[0].time, '09:30');
});

test('151 compact appointment ACK and replay omit history; full readers remain complete', async (t) => {
  const f = await fixture(t, false, 2),
    body = f.command('a', { notes: 'Compact reply' });
  f.context.req.headers['x-cartoteca-appointment-response'] = 'delta-v1';
  const prepare = f.storage.db.prepare.bind(f.storage.db);
  f.storage.db.prepare = (sql) => {
    if (/SELECT.*value FROM cabinet_patient_records.*kind='visit'/i.test(sql))
      throw Error('151 must not hydrate visit history');
    return prepare(sql);
  };
  const saved = await f.save(body, 'synthetic-compact-151');
  assert.equal(saved.appointmentOnly, true);
  assert.equal(saved.patients[0].visits.length, 0);
  assert.equal(saved.patients[0].appointments[0].notes, 'Compact reply');
  assert.deepEqual(await f.save(body, 'synthetic-compact-151'), saved);
  f.storage.db.prepare = prepare;
  const full = readReceipt(f.storage, f.context.current, 'synthetic-compact-151').saved;
  assert.equal(full.appointmentOnly, undefined);
  assert.equal(full.patients[0].visits[0].procedure, 'Synthetic private history');
  delete f.context.req.headers['x-cartoteca-appointment-response'];
  assert.equal((await f.save(body, 'synthetic-compact-151')).patients[0].visits.length, 1);
  f.storage.set('revision', saved.revision + 1);
  assert.throws(
    () => readReceipt(f.storage, f.context.current, 'synthetic-compact-151'),
    (e) => e.status === 409,
  );
});
