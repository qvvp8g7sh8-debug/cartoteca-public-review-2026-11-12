const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
function fixture() {
  const state = {
      data: [
        { id: 'p1', name: 'One', visits: [], appointments: [] },
        { id: 'p2', name: 'Two', visits: [], appointments: [] },
      ],
      services: [],
      revision: 1,
    },
    calls = [];
  const actions = {
    request: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, options, body });
      return {
        revision: 2,
        patients: body.patients.map((change) => change.after).filter(Boolean),
        services: body.services.map((change) => change.after).filter(Boolean),
        removedPatientIds: body.patients
          .filter((change) => change.after === null)
          .map((change) => change.id),
      };
    },
  };
  const context = vm.createContext({ structuredClone, fetch, Map, Set, JSON, Error });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/client/core/cabinet-store.js'), 'utf8') +
      ';globalThis.factory=createCabinetStore;',
    context,
  );
  Object.assign(actions, context.factory(state, actions));
  actions.rememberCabinet({ patients: state.data, services: state.services, partialWrites: true });
  return { state, actions, calls };
}
test('client store sends only changed records and keeps an independent rollback baseline', async () => {
  const f = fixture();
  f.state.data[0].notes = 'Changed';
  await f.actions.save();
  assert.equal(f.calls[0].url, '/api/cabinet/changes');
  assert.equal(f.calls[0].options.method, 'PATCH');
  assert.equal(f.calls[0].body.patients.length, 1);
  assert.equal(f.calls[0].body.patients[0].id, 'p1');
  assert.equal(f.state.data[1].name, 'Two');
  await f.actions.save();
  assert.equal(f.calls.length, 1);
  f.state.data[0].notes = 'Unsaved';
  f.actions.rollback();
  assert.equal(f.state.data[0].notes, 'Changed');
});
test('initial default services are saved even when the server cabinet starts empty', async () => {
  const f = fixture();
  f.state.services = [{ id: 's', name: 'Seed', price: 10 }];
  f.actions.rememberCabinet({ patients: [], services: [], partialWrites: true });
  await f.actions.save();
  assert.equal(f.calls[0].body.services.length, 1);
  assert.equal(f.calls[0].body.services[0].before, null);
});
test('server-owned confirmation changes do not become clinical mutations and failed saves retain baseline', async () => {
  const f = fixture();
  f.state.data[0].appointments = [{ id: 'a', telegramConfirmedAt: 123 }];
  f.actions.rememberCabinet({ patients: f.state.data, services: [], partialWrites: true });
  f.state.data[0].appointments[0].telegramConfirmedAt = 456;
  await f.actions.save();
  assert.equal(f.calls.length, 0);
  f.actions.request = async () => {
    throw Error('Synthetic offline');
  };
  f.state.data[0].notes = 'Unsaved';
  await assert.rejects(f.actions.save(), /offline/);
  f.actions.rollback();
  assert.equal(f.state.data[0].notes, undefined);
});
test('large imports retain compatible full PUT and replace the baseline only after success', async () => {
  const f = fixture();
  f.state.data = Array.from({ length: 201 }, (_, i) => ({
    id: 'new' + i,
    name: 'Synthetic',
    visits: [],
    appointments: [],
  }));
  f.actions.request = async (url, options) => {
    const body = JSON.parse(options.body);
    f.calls.push({ url, options, body });
    return { ...body, revision: 2 };
  };
  await f.actions.save();
  assert.equal(f.calls[0].url, '/api/cabinet');
  assert.equal(f.calls[0].options.method, 'PUT');
  assert.equal(f.calls[0].body.patients.length, 201);
  await f.actions.save();
  assert.equal(f.calls.length, 1);
});

test('client uses an immutable operation ID and checks a durable receipt without resending normalized photos', async () => {
  const f = fixture();
  f.actions.rememberCabinet({
    patients: f.state.data,
    services: [],
    partialWrites: true,
    idempotentWrites: true,
  });
  f.state.data[0].notes = 'Saved';
  let sent;
  f.actions.request = async (url, options) => {
    sent = { url, options };
    throw Object.assign(Error('Lost response'), { outcomeUnknown: true });
  };
  await assert.rejects(f.actions.save());
  assert.match(sent.options.headers['X-Cartoteca-Operation'], /^[a-zA-Z0-9-]{16,80}$/);
  f.actions.rollback();
  f.actions.request = async (url, options) => {
    assert.equal(options, undefined);
    assert.equal(
      url,
      '/api/cabinet/operation?id=' +
        sent.options.headers['X-Cartoteca-Operation'] +
        '&statusOnly=1',
    );
    return {
      status: 'committed',
      result: {
        revision: 2,
        patients: [{ ...f.state.data[0], notes: 'Saved' }],
        services: [],
        removedPatientIds: [],
        removedServiceIds: [],
      },
    };
  };
  assert.equal((await f.actions.recoverCabinetSave()).status, 'saved');
  assert.equal(f.state.data[0].notes, 'Saved');
});

test('appointment-only command omits the profile and history and recovers a lost response', async () => {
  const f = fixture();
  f.state.data[0].visits = [
    { id: 'visit', date: '2030-01-01', notes: 'PRIVATE HISTORY', photos: [] },
  ];
  f.state.data[0].appointments = [
    { id: 'appointment', date: '2030-01-02', time: '09:00', duration: 60 },
  ];
  f.actions.rememberCabinet({
    patients: f.state.data,
    services: [],
    partialWrites: true,
    idempotentWrites: true,
    appointmentWrites: true,
  });
  f.state.data[0].appointments[0].time = '10:00';
  let sent;
  f.actions.request = async (url, options) => {
    sent = { url, options };
    throw Object.assign(Error('Lost response'), { outcomeUnknown: true });
  };
  await assert.rejects(f.actions.save());
  assert.equal(sent.url, '/api/cabinet/appointments');
  assert.equal(sent.options.method, 'POST');
  assert.doesNotMatch(sent.options.body, /PRIVATE HISTORY|visits|patients|name/);
  const command = JSON.parse(sent.options.body);
  assert.equal(command.patientId, 'p1');
  assert.equal(command.changes[0].after.time, '10:00');
  f.actions.rollback();
  f.actions.request = async (url) => {
    if (url.startsWith('/api/cabinet/operation')) return { status: 'unknown' };
    assert.equal(url, '/api/cabinet/patient?id=p1');
    return {
      revision: 2,
      patients: [{ ...f.state.data[0], appointments: [command.changes[0].after] }],
    };
  };
  assert.equal((await f.actions.recoverCabinetSave()).status, 'saved');
  assert.equal(f.state.data[0].appointments[0].time, '10:00');
  assert.equal(f.state.data[0].visits[0].notes, 'PRIVATE HISTORY');
});

test('a visit completion remains one atomic card change even with appointment commands enabled', async () => {
  const f = fixture();
  f.state.data[0].appointments = [
    { id: 'appointment', date: '2030-01-02', time: '09:00', duration: 60 },
  ];
  f.actions.rememberCabinet({
    patients: f.state.data,
    services: [],
    partialWrites: true,
    appointmentWrites: true,
  });
  f.state.data[0].appointments[0].status = 'completed';
  f.state.data[0].visits.push({
    id: 'visit',
    date: '2030-01-02',
    appointmentId: 'appointment',
    photos: [],
  });
  await f.actions.save();
  assert.equal(f.calls[0].url, '/api/cabinet/changes');
  assert.equal(f.calls[0].body.patients[0].after.visits[0].id, 'visit');
});

async function uncertainAppointment() {
  const f = fixture();
  f.state.data[0].visits = [{ id: 'v', notes: 'Original history', photos: [] }];
  f.state.data[0].appointments = [
    { id: 'a', time: '09:00', duration: 30 },
    { id: 'b', time: '11:00', duration: 30 },
  ];
  const original = structuredClone(f.state.data[0]);
  f.actions.rememberCabinet({
    patients: f.state.data,
    services: [],
    partialWrites: true,
    idempotentWrites: true,
    appointmentWrites: true,
  });
  f.state.data[0].appointments[0].time = '10:00';
  let sent;
  f.actions.request = async (url, options) => {
    sent = { url, options };
    throw Object.assign(Error('Lost response'), { outcomeUnknown: true });
  };
  await assert.rejects(f.actions.save());
  f.actions.rollback();
  const concurrent = {
    ...original,
    name: 'Concurrent profile',
    visits: [...original.visits, { id: 'new-v', notes: 'Concurrent history', photos: [] }],
    appointments: [
      original.appointments[0],
      { ...original.appointments[1], notes: 'Concurrent other appointment' },
    ],
  };
  return { ...f, original, concurrent, sent };
}

test('appointment recovery ignores unrelated rebase edits and server decorations after a lost receipt', async () => {
  const f = await uncertainAppointment();
  f.concurrent.appointments[0] = {
    ...f.concurrent.appointments[0],
    time: '10:00',
    notificationConfirmedAt: 123,
  };
  f.actions.request = async (url) => {
    if (url.startsWith('/api/cabinet/operation'))
      throw Object.assign(Error('Superseded receipt'), { status: 409 });
    assert.equal(url, '/api/cabinet/patient?id=p1');
    return { revision: 5, patients: [f.concurrent] };
  };
  assert.equal((await f.actions.recoverCabinetSave()).status, 'saved');
  assert.deepEqual(f.state.data[0], f.concurrent);
  assert.equal(f.state.revision, 5);
  assert.equal(f.actions.cabinetSaveStatus(), null);
});

test('appointment recovery can retry unchanged targets despite other edits using the original immutable command', async () => {
  const f = await uncertainAppointment();
  let retries = 0;
  f.actions.request = async (url, options) => {
    if (url.startsWith('/api/cabinet/operation')) return { status: 'unknown' };
    if (!options) return { revision: 3, patients: [f.concurrent] };
    retries++;
    assert.equal(url, f.sent.url);
    assert.deepEqual(options, f.sent.options);
    const command = JSON.parse(options.body);
    return {
      revision: 4,
      patients: [
        { ...f.concurrent, appointments: [command.changes[0].after, f.concurrent.appointments[1]] },
      ],
      services: [],
    };
  };
  assert.equal((await f.actions.recoverCabinetSave()).status, 'retry');
  f.state.data[0].appointments[0].time = '18:00';
  f.state.data[0].name = 'Do not send this';
  assert.equal((await f.actions.recoverCabinetSave({ retry: true })).status, 'saved');
  assert.equal(retries, 1);
  assert.equal(f.state.data[0].appointments[0].time, '10:00');
  assert.equal(f.state.data[0].name, 'Concurrent profile');
  assert.equal(f.state.data[0].visits.length, 2);
});

test('appointment recovery keeps real target conflicts for review without a second write', async () => {
  const f = await uncertainAppointment();
  f.concurrent.appointments[0].time = '12:00';
  f.actions.request = async (url, options) => {
    assert.equal(options, undefined);
    return url.startsWith('/api/cabinet/operation')
      ? { status: 'unknown' }
      : { revision: 3, patients: [f.concurrent] };
  };
  assert.equal((await f.actions.recoverCabinetSave()).status, 'review');
  assert.equal(f.actions.cabinetSaveStatus(), 'review');
  assert.equal(f.state.data[0].appointments[0].time, '09:00');
  assert.equal((await f.actions.recoverCabinetSave({ retry: true })).status, 'review');
});

test('appointment recovery cannot infer a result from a missing patient', async () => {
  const f = await uncertainAppointment();
  f.actions.request = async (url) => {
    if (url.startsWith('/api/cabinet/operation')) return { status: 'unknown' };
    throw Object.assign(Error('No accessible patient'), { status: 404 });
  };
  assert.equal((await f.actions.recoverCabinetSave()).status, 'review');
  assert.equal(f.state.data.length, 2);
  assert.equal(f.actions.cabinetSaveStatus(), 'review');
});

test('151 appointment delta invalidates full history and baseline before the next edit', async () => {
  const f = fixture();
  f.state.lazyReads = true;
  f.state.directory = [];
  f.state.calendarRecords = [];
  f.state.data[0].visits = [{ id: 'kept-history' }];
  f.state.data[0].appointments = [{ id: 'a', notes: 'Before' }];
  let invalidated = 0;
  f.actions.invalidatePatientRead = (ids) => {
    invalidated++;
    f.state.data = f.state.data.filter((p) => !ids.includes(p.id));
  };
  f.actions.invalidateCalendarRead = () => {};
  f.actions.patientNameParts = () => ({ lastFirst: 'Synthetic' });
  f.actions.rememberCabinet({
    patients: f.state.data,
    services: [],
    partialWrites: true,
    appointmentWrites: true,
  });
  f.state.data[0].appointments[0].notes = 'After';
  f.actions.request = async (url, options) => {
    assert.equal(url, '/api/cabinet/appointments');
    assert.equal(options.headers['X-Cartoteca-Appointment-Response'], 'delta-v1');
    return {
      revision: 2,
      appointmentOnly: true,
      patients: [{ ...f.state.data[0], visits: [] }],
      services: [],
    };
  };
  await f.actions.save();
  assert.equal(invalidated, 1);
  assert.equal(
    f.state.data.some((p) => p.id === 'p1'),
    false,
  );
  f.actions.rollback();
  assert.equal(
    f.state.data.some((p) => p.id === 'p1'),
    false,
  );
  // No synthetic deletion appears because the full baseline was invalidated too.
  await f.actions.save();
  assert.equal(invalidated, 1);
  const full = {
    id: 'p1',
    name: 'One',
    visits: [{ id: 'kept-history' }],
    appointments: [{ id: 'a', notes: 'After' }],
  };
  f.state.data.push(full);
  f.actions.rememberLoadedPatient(full);
  await f.actions.save();
  assert.equal(invalidated, 1);
});
test('151 a late full read cannot repopulate an invalidated appointment snapshot', async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/client/core/cabinet-queries.js'),
    'utf8',
  );
  const create = vm.runInNewContext(source + ';createCabinetQueries', { Map, Set, JSON });
  let resolve;
  const state = { lazyReads: true, data: [], account: { id: 'owner', organizationId: 'org' } };
  const actions = {
    request: () => new Promise((yes) => (resolve = yes)),
    rememberLoadedPatient: () => assert.fail('stale baseline'),
  };
  const queries = create(state, actions),
    pending = queries.ensurePatient('p');
  queries.invalidatePatientRead(['p']);
  resolve({ revision: 1, patients: [{ id: 'p', visits: ['old'] }] });
  await pending;
  assert.equal(state.data.length, 0);
});

test('161 point appointment save does not read/clone full history and invalidates full baselines', async () => {
  const f = fixture(),
    before = { id: 'a', date: '2035-01-01', time: '10:00', staffId: 'owner' },
    after = { ...before, notes: 'Point change' };
  f.state.account = { id: 'owner', organizationId: 'org', role: 'owner' };
  f.state.lazyReads = true;
  f.state.pagedReads = true;
  f.state.directory = [];
  f.state.calendarRecords = [
    { ...before, patientId: 'p1' },
    { id: 'other', patientId: 'p1' },
  ];
  f.actions.rememberCabinet({
    patients: f.state.data,
    services: [],
    partialWrites: true,
    appointmentWrites: true,
    idempotentWrites: true,
  });
  Object.defineProperty(f.state.data[0], 'visits', {
    get() {
      throw Error('Full history must not be read');
    },
  });
  let sent;
  f.actions.request = async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return {
      revision: 2,
      appointmentEdit: true,
      patients: [{ id: 'p1', name: 'One', visits: [], appointments: [after] }],
      summaries: [],
    };
  };
  f.actions.patientNameParts = (p) => ({ lastFirst: p.name });
  f.actions.invalidatePatientRead = (ids) => {
    f.state.data = f.state.data.filter((p) => !ids.includes(p.id));
  };
  f.actions.invalidateCalendarRead = () => {};
  f.actions.invalidateDirectory = () => {};
  const edit = {
    patientId: 'p1',
    before,
    revision: 1,
    account: JSON.stringify(['owner', 'org', 'owner']),
  };
  await f.actions.saveAppointmentChange(edit, after);
  assert.equal(sent.url, '/api/cabinet/appointments');
  assert.equal(sent.options.headers['X-Cartoteca-Appointment-Response'], 'point-v1');
  assert.equal(sent.body.changes.length, 1);
  assert.equal('patients' in sent.body, false);
  assert.equal(
    f.state.data.some((p) => p.id === 'p1'),
    false,
  );
  assert.equal(f.state.calendarRecords.find((a) => a.id === 'a').notes, 'Point change');
  assert.equal(
    f.state.calendarRecords.some((a) => a.id === 'other'),
    true,
  );
  f.actions.rollback();
  assert.equal(
    f.state.data.some((p) => p.id === 'p1'),
    false,
    'incomplete DTO never becomes a full rollback baseline',
  );
  f.state.account = { id: 'other', organizationId: 'foreign', role: 'owner' };
  await assert.rejects(f.actions.saveAppointmentChange(edit, after), /Аккаунт/);
});

test('161 point save reconciles a lost acknowledgement through its immutable operation without replay', async () => {
  const f = fixture(),
    before = { id: 'a', date: '2035-01-01', time: '10:00', staffId: 'owner' },
    after = { ...before, notes: 'Committed' };
  f.state.account = { id: 'owner', organizationId: 'org', role: 'owner' };
  f.state.lazyReads = true;
  f.state.directory = [];
  f.state.calendarRecords = [];
  f.actions.rememberCabinet({
    patients: f.state.data,
    services: [],
    partialWrites: true,
    appointmentWrites: true,
    idempotentWrites: true,
  });
  f.actions.patientNameParts = (p) => ({ lastFirst: p.name });
  f.actions.invalidatePatientRead = () => {};
  f.actions.invalidateCalendarRead = () => {};
  let posts = 0;
  f.actions.request = async (url, options) => {
    if (options?.method === 'POST') {
      posts++;
      throw Object.assign(Error('Synthetic lost ACK'), { outcomeUnknown: true });
    }
    if (url.includes('statusOnly=1')) return { status: 'committed', revision: 2 };
    return {
      status: 'committed',
      result: {
        revision: 2,
        appointmentOnly: true,
        patients: [{ id: 'p1', name: 'One', visits: [], appointments: [after] }],
        services: [],
      },
    };
  };
  const edit = {
    patientId: 'p1',
    before,
    revision: 1,
    account: JSON.stringify(['owner', 'org', 'owner']),
  };
  await assert.rejects(f.actions.saveAppointmentChange(edit, after), /lost ACK/);
  assert.equal(f.actions.cabinetSaveStatus(), 'check');
  await assert.rejects(f.actions.saveAppointmentChange(edit, after), /предыдущего/);
  assert.equal((await f.actions.recoverCabinetSave()).status, 'saved');
  assert.equal(posts, 1);
  assert.equal(f.actions.cabinetSaveStatus(), null);
});

test('161 moving a point edit to another patient retains its original CAS after a fresh full read', () => {
  const f = fixture();
  f.state.account = { id: 'owner', organizationId: 'org', role: 'owner' };
  const before = { id: 'a', date: '2035-01-01', time: '10:00', staffId: 'owner' };
  const edit = {
    patientId: 'p1',
    before,
    revision: 1,
    account: JSON.stringify(['owner', 'org', 'owner']),
  };
  f.state.data[0].appointments = [{ ...before, manualConfirmedBy: 'decorative' }];
  assert.doesNotThrow(() => f.actions.assertAppointmentEdit(edit));
  f.state.data[0].appointments[0].time = '11:00';
  assert.throws(() => f.actions.assertAppointmentEdit(edit), /уже изменена/);
});
