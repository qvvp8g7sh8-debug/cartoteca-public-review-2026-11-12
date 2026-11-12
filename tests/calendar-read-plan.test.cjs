const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { createStorage } = require('../storage.cjs');
const { createReadVersion } = require('../src/server/infrastructure/read-version.cjs');
const { calendarRead } = require('../src/server/modules/cabinet/calendar-read.cjs');
const { calendarPeriod } = require('../src/server/modules/cabinet/queries.cjs');

test('day/week/list read only visible detail; load month includes midnight boundary', () => {
  const ctx = vm.createContext({ Date });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/client/core/cabinet-queries.js'), 'utf8'),
    ctx,
  );
  const state = { calendarAnchorDate: new Date(2030, 0, 31), calendarMode: 'day' };
  const isoDate = (d) =>
    [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  const actions = {
    isoDate,
    weekStart(d) {
      const x = new Date(d);
      x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
      return x;
    },
  };
  const q = ctx.createCabinetQueries(state, actions);
  assert.equal(
    JSON.stringify(q.calendarReadRange()),
    JSON.stringify({ from: '2030-01-31', to: '2030-01-31' }),
  );
  state.calendarMode = 'week';
  assert.equal(q.calendarReadRange().to, '2030-02-06');
  state.calendarMode = 'list';
  assert.equal(q.calendarReadRange().from, q.calendarReadRange().to);
  state.calendarMode = 'load';
  state.calendarLoadPeriod = 'month';
  assert.equal(q.calendarReadRange().from, '2029-12-31');
  assert.equal(q.calendarReadRange().to, '2030-01-31');
});

test('read versions cover own commits, other connections and reopened workers', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-version-'));
  const a = new DatabaseSync(path.join(dir, 'synthetic.sqlite'));
  a.exec('CREATE TABLE example(n INTEGER)');
  const b = new DatabaseSync(path.join(dir, 'synthetic.sqlite'));
  t.after(() => {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const stamp = createReadVersion(a),
    other = createReadVersion(b);
  const initial = stamp();
  assert.deepEqual(initial, stamp());
  assert.notDeepEqual(initial, other());
  a.exec('INSERT INTO example VALUES(1)');
  const own = stamp();
  assert.notDeepEqual(initial, own);
  b.exec('INSERT INTO example VALUES(2)');
  assert.notDeepEqual(own, stamp());
});

test('compact month counts share budget and contain no client identifiers or history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-calendar-plan-'));
  const storage = createStorage(dir);
  t.after(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const appointment = (id, staffId, time = '09:00') => ({
    id,
    staffId,
    date: '2030-01-02',
    time,
    duration: 60,
    roomId: 'room',
    notes: 'PRIVATE NOTE',
    service: 'SECRET SERVICE',
  });
  storage.write({
    revision: 0,
    services: [],
    patients: [
      {
        id: 'secret-person',
        name: 'PRIVATE NAME',
        phone: 'PRIVATE PHONE',
        visits: [],
        appointments: [
          appointment('one', 'staff'),
          appointment('two', 'other'),
          { ...appointment('cancelled', 'staff'), status: 'cancelled' },
        ],
      },
    ],
  });
  const options = {
    projection: 'overview',
    overview: { from: '2030-01-01', to: '2030-02-11' },
    staffId: 'staff',
  };
  const result = storage.calendarSnapshot('2030-01-01', '2030-02-11', options);
  assert.deepEqual(result.appointments, []);
  assert.deepEqual(result.overview, [
    { date: '2030-01-02', staffId: 'staff', roomId: 'room', count: 1 },
  ]);
  assert.ok(Object.isFrozen(result.overview));
  assert.ok(Object.isFrozen(result.overview[0]));
  assert.throws(() => result.overview.push({ count: 99 }), TypeError);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|secret-person|cancelled/);
  const original = storage.indexes.appointments;
  let calls = 0;
  storage.indexes.appointments = (...args) => {
    calls++;
    return original(...args);
  };
  storage.calendarSnapshot('2030-01-01', '2030-02-11', options);
  assert.equal(calls, 0);
  const own = storage.readSelected(['secret-person']).patients[0];
  own.appointments.push(appointment('three', 'staff', '12:00'));
  storage.write(
    { revision: 1, services: [], patients: [own] },
    { changedIds: { patients: [own.id], services: [] } },
  );
  assert.equal(storage.calendarSnapshot('2030-01-01', '2030-02-11', options).overview[0].count, 2);
  assert.equal(calls, 1);
});

test('full calendar keeps live details and personal events without conditional-only reads', () => {
  const unused = () => assert.fail('A full calendar does not need conditional version state');
  const appointments = [
    { id: 'one', patientId: 'p-one', staffId: 'staff', date: '2030-01-01', time: '09:00' },
    { id: 'two', patientId: 'p-two', staffId: 'other', date: '2030-01-01', time: '10:00' },
  ];
  for (const role of ['owner', 'cosmetologist']) {
    let reads = 0,
      decorations = 0,
      personalReads = 0;
    const current = { organizationId: 'org', accountId: 'staff', role, sessionId: 'session' };
    const personalEvents = [{ id: 'personal', date: '2030-01-01', title: 'Synthetic event' }];
    const c = {
      url: new URL('http://localhost/api/cabinet/calendar?from=2030-01-01&to=2030-01-01'),
      current,
      tenantStore(org) {
        assert.equal(org, 'org');
        return {
          get: unused,
          readVersion: unused,
          calendarSnapshot(from, to, options) {
            reads++;
            assert.equal(from, '2030-01-01');
            assert.equal(to, from);
            assert.deepEqual(options, { staffId: role === 'cosmetologist' ? 'staff' : '' });
            return { revision: 17, appointments };
          },
        };
      },
      platform: {
        organizationTimeZone: unused,
        readVersion: unused,
        subscription: unused,
        personalEvents: {
          overview: unused,
          view(actor, from, to, options) {
            personalReads++;
            assert.equal(actor, current);
            assert.equal(from, '2030-01-01');
            assert.equal(to, from);
            assert.deepEqual(options, { projection: 'details' });
            return { personalEvents, personalRevision: 3 };
          },
        },
      },
      telegram: { status: unused },
      appointmentState: {
        decorate(cabinet, org) {
          decorations++;
          assert.equal(org, 'org');
          return {
            ...cabinet,
            patients: cabinet.patients.map((patient) => ({
              ...patient,
              appointments: patient.appointments.map((a) => ({ ...a, telegramConfirmedAt: 100 })),
            })),
          };
        },
      },
      json(res, status, value) {
        assert.equal(status, 200);
        return value;
      },
    };
    const expected = role === 'cosmetologist' ? appointments.slice(0, 1) : appointments;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = calendarRead(c, calendarPeriod);
      assert.deepEqual(result, {
        revision: 17,
        appointments: expected.map((a) => ({ ...a, telegramConfirmedAt: 100 })),
        personalEvents,
        personalRevision: 3,
      });
      assert.equal(reads, attempt);
      assert.equal(decorations, attempt);
      assert.equal(personalReads, attempt);
    }
  }
});

test('conditional calendar skips snapshot/decorations, invalidates on scope, provider, data or deadline', () => {
  let revision = 1,
    platformVersion = 1,
    connected = false,
    reads = 0,
    decorate = 0;
  const storage = {
    get: () => revision,
    calendarSnapshot() {
      reads++;
      return { revision, appointments: [], overview: [] };
    },
  };
  const c = {
    url: new URL(
      'http://localhost/api/cabinet/calendar?from=2030-01-01&to=2030-01-01&compact=1&monthFrom=2030-01-01&monthTo=2030-02-11',
    ),
    current: { organizationId: 'org', accountId: 'owner', role: 'owner', sessionId: 'session' },
    tenantStore: () => storage,
    platform: {
      organizationTimeZone: () => 'Europe/Moscow',
      subscription: () => ({ status: 'active' }),
      readVersion: () => platformVersion,
    },
    telegram: { status: () => ({ connected }) },
    appointmentState: {
      decorate(value) {
        decorate++;
        return value;
      },
    },
    json: (res, status, value) => value,
  };
  const first = calendarRead(c, calendarPeriod);
  assert.equal(reads, 1);
  assert.equal(decorate, 1);
  c.url.searchParams.set('version', first.version);
  c.url.searchParams.set('until', first.validUntil);
  assert.equal(calendarRead(c, calendarPeriod).unchanged, true);
  assert.equal(reads, 1);
  assert.equal(decorate, 1);
  connected = true;
  assert.equal(calendarRead(c, calendarPeriod).unchanged, undefined);
  connected = false;
  revision++;
  assert.equal(calendarRead(c, calendarPeriod).unchanged, undefined);
  revision--;
  platformVersion++;
  assert.equal(calendarRead(c, calendarPeriod).unchanged, undefined);
  platformVersion--;
  c.current.organizationId = 'other';
  assert.equal(calendarRead(c, calendarPeriod).unchanged, undefined);
  c.current.organizationId = 'org';
  c.url.searchParams.set('until', '1');
  assert.equal(calendarRead(c, calendarPeriod).unchanged, undefined);
  c.url.searchParams.set('monthTo', '2035-01-01');
  assert.throws(
    () => calendarRead(c, calendarPeriod),
    (e) => e.status === 400,
  );
});

test('a start crossed while decorating expires the response instead of caching stale channels', (t) => {
  const start = Date.parse('2030-01-01T09:00:00Z');
  let now = start - 1,
    reads = 0;
  t.mock.method(Date, 'now', () => now);
  const c = {
    url: new URL(
      'http://localhost/api/cabinet/calendar?from=2030-01-01&to=2030-01-01&compact=1&monthFrom=2030-01-01&monthTo=2030-02-11',
    ),
    current: { organizationId: 'org', accountId: 'owner', role: 'owner', sessionId: 'session' },
    tenantStore: () => ({
      get: () => 1,
      readVersion: () => 1,
      calendarSnapshot() {
        reads++;
        return {
          revision: 1,
          overview: [],
          appointments: [
            { id: 'a', patientId: 'p', date: '2030-01-01', time: '09:00', duration: 30 },
          ],
        };
      },
    }),
    platform: {
      organizationTimeZone: () => 'UTC',
      subscription: () => ({ status: 'active' }),
      readVersion: () => 1,
    },
    telegram: { status: () => ({}) },
    appointmentState: {
      decorate(value) {
        now = start + 1;
        return value;
      },
    },
    json: (res, status, value) => value,
  };
  const first = calendarRead(c, calendarPeriod);
  assert.equal(first.validUntil, start);
  c.url.searchParams.set('version', first.version);
  c.url.searchParams.set('until', first.validUntil);
  assert.equal(calendarRead(c, calendarPeriod).unchanged, undefined);
  assert.equal(reads, 2);
});

test('client keeps month summaries separate and reuses the conditional token only for its loaded scope', async () => {
  const ctx = vm.createContext({ Date, document: {} });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/client/core/cabinet-queries.js'), 'utf8'),
    ctx,
  );
  const state = {
    account: { id: 'owner', organizationId: 'org' },
    lazyReads: true,
    calendarAnchorDate: new Date(2030, 0, 31),
    calendarMode: 'day',
    currentView: 'calendar',
  };
  const urls = [],
    summaries = [{ date: '2030-01-02', staffId: 'owner', roomId: 'main', count: 2 }];
  let renders = 0,
    conditional = false;
  const actions = {
    isoDate: (d) =>
      [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ].join('-'),
    weekStart(d) {
      const day = new Date(d);
      day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
      return day;
    },
    async readBackground(url) {
      urls.push(url);
      return conditional
        ? { unchanged: true, revision: 1 }
        : {
            revision: 1,
            appointments: [],
            overview: summaries,
            version: 'opaque',
            validUntil: 123,
          };
    },
    $: () => null,
    setView() {
      renders++;
    },
    updateCurrentTime() {},
    toast(message) {
      assert.fail(message);
    },
  };
  const queries = ctx.createCabinetQueries(state, actions);
  await queries.loadCalendarRecords();
  assert.equal(state.calendarOverview, summaries);
  assert.equal(state.calendarRecords.length, 0);
  assert.equal(renders, 1);
  conditional = true;
  await queries.loadCalendarRecords({ force: true });
  assert.match(urls[1], /version=opaque&until=123/);
  assert.equal(renders, 1);
  assert.equal(state.calendarOverview, summaries);
  conditional = false;
  state.calendarMode = 'month';
  await queries.loadCalendarRecords();
  assert.match(urls[2], /projection=overview/);
  assert.doesNotMatch(urls[2], /version=/);
  queries.invalidateCalendarRead();
  assert.equal(state.calendarOverview, null);
  await queries.loadCalendarRecords();
  assert.doesNotMatch(urls[3], /version=/);
});
