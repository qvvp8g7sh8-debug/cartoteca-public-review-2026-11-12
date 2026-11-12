const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarAdminFixture } = require('./helpers/calendar-admin-fixture.cjs');
const { createCalendarFeedCache } = require('../src/server/modules/calendar/feed-cache.cjs');
const { routes } = require('../src/server/modules/calendar/subscription-routes.cjs');

const now = Date.parse('2026-10-19T12:00:00Z');
const selected = (...staffIds) => ({ mode: 'selected', staffIds });
const unfold = (body) => body.replace(/\r\n[ \t]/g, '');
const eventCount = (body) => (body.match(/^BEGIN:VEVENT\r?$/gm) || []).length;
function fixture(t) {
  const f = calendarAdminFixture(t);
  const state = {
    versions: { a: 'a-1', b: 'b-1', owner: 'owner-1' }, snapshots: [], personalReads: [],
    appointments: ['a', 'b', 'owner', 'foreign', 'admin', 'blocked-account', 'blocked-member'].map((staffId) => ({
      id: 'appointment-' + staffId, staffId, date: '2026-10-20', time: '12:00', duration: 30,
      patientName: 'Клиент ' + staffId, patientPhone: '+79990001122', phone: '+79990003344',
      notes: 'CLINICAL_SECRET', diagnosis: 'DIAGNOSIS_SECRET', services: ['SERVICE_SECRET'],
    })),
    personalEvents: ['a', 'b', 'owner', 'foreign', 'admin'].map((staffId) => ({
      id: 'personal-' + staffId, staffId, date: '2026-10-21', time: '10:00', duration: 60,
      notes: 'PERSONAL_NOTE_SECRET', patientName: 'PERSONAL_NAME_SECRET',
    })),
  };
  const storage = {
    calendarOccupancyVersion: (staffId) => state.versions[staffId] || '',
    calendarSnapshot(from, to, options) {
      assert.equal(options.projection, 'subscription');
      assert.ok((Date.parse(to) - Date.parse(from)) / 86400000 < 45);
      state.snapshots.push({ from, to, ...options });
      state.onSnapshot?.();
      // Include an untrusted extra staff row, as the existing personal-feed test does.
      return { appointments: state.appointments.filter((event) => event.date >= from && event.date <= to) };
    },
  };
  const platform = {
    calendarSubscription: f.service,
    organizationTimeZone: () => 'Europe/Moscow',
    personalEvents: {
      view(actor, from, to, options) {
        assert.equal(options.projection, 'occupancy');
        state.personalReads.push(actor.accountId);
        return { personalEvents: state.personalEvents.filter((event) => event.date >= from && event.date <= to) };
      },
    },
  };
  const credentials = Object.fromEntries(['apple', 'google'].map((provider) => [
    provider, f.service.connect('admin', f.guard, provider).credential,
  ]));
  const cache = createCalendarFeedCache();
  const read = (provider = 'apple', options = {}) => cache.read({
    current: f.service.resolve(credentials[provider]), storage, platform, now, ...options,
  });
  return { ...f, state, storage, platform, credentials, cache, read };
}

test('admin all exports only active specialist appointments and private occupancy with specialist names', (t) => {
  const f = fixture(t), first = f.read(), body = unfold(first.body);
  assert.equal(eventCount(body), 6);
  for (const [id, displayName] of [['a', 'Анна'], ['b', 'Борис'], ['owner', 'Владелец']]) {
    assert.ok(body.includes(`SUMMARY:Клиент ${id} — приём — ${displayName}\r\n`));
    assert.ok(body.includes(`SUMMARY:Личная занятость — ${displayName}\r\n`));
  }
  assert.match(body, /DTSTART:20261020T090000Z\r\nDTEND:20261020T093000Z/);
  for (const hidden of [
    '+79990001122', '+79990003344', 'CLINICAL_SECRET', 'DIAGNOSIS_SECRET', 'SERVICE_SECRET',
    'PERSONAL_NOTE_SECRET', 'PERSONAL_NAME_SECRET', 'Клиент foreign', 'Клиент admin',
    'Клиент blocked-account', 'Клиент blocked-member',
  ]) assert.ok(!body.includes(hidden), hidden);
  assert.deepEqual(f.state.snapshots.map((value) => value.staffId).sort(), ['a', 'b', 'owner']);
  assert.deepEqual(f.state.personalReads, ['admin']);
  assert.deepEqual(f.read(), first);
  assert.equal(f.state.snapshots.length, 3);
  const conditional = f.read('apple', { ifNoneMatch: first.etag });
  assert.equal(conditional.unchanged, true);
  assert.equal(conditional.body, undefined);
  assert.equal(f.state.snapshots.length, 3);
});

test('independent provider scopes use separate cached content and validators', (t) => {
  const f = fixture(t);
  f.select('apple', selected('a'));
  f.select('google', selected('b'));
  const apple = f.read(), google = f.read('google');
  assert.equal(eventCount(apple.body), 2);
  assert.equal(eventCount(google.body), 2);
  assert.notEqual(apple.etag, google.etag);
  assert.ok(unfold(apple.body).includes('Клиент a — приём — Анна'));
  assert.ok(!unfold(apple.body).includes('Клиент b'));
  assert.ok(unfold(google.body).includes('Клиент b — приём — Борис'));
  assert.ok(!unfold(google.body).includes('Клиент a'));
  assert.deepEqual(f.read(), apple);
  assert.deepEqual(f.read('google'), google);
  const updated = f.select('apple', selected('owner'));
  assert.equal(updated.credential, f.credentials.apple);
  const revised = f.read('apple', { ifNoneMatch: apple.etag });
  assert.equal(revised.unchanged, false);
  assert.notEqual(revised.etag, apple.etag);
  assert.ok(unfold(revised.body).includes('Клиент owner — приём — Владелец'));
  assert.ok(!unfold(revised.body).includes('Клиент a'));
  assert.deepEqual(f.read('google'), google);
});

test('selected-staff occupancy changes invalidate the admin feed while unselected occupancy does not', (t) => {
  const f = fixture(t);
  f.select('apple', selected('a'));
  const first = f.read();
  f.state.versions.b = 'b-2';
  f.state.appointments.find((event) => event.staffId === 'b').time = '15:00';
  let profile = f.profile();
  profile.calendarPersonalVersions.b = 'personal-b-2';
  f.writeProfile(profile);
  assert.equal(f.read('apple', { ifNoneMatch: first.etag }).unchanged, true);
  assert.equal(f.state.snapshots.length, 1);
  f.state.versions.a = 'a-2';
  f.state.appointments.find((event) => event.staffId === 'a').time = '14:00';
  const moved = f.read('apple', { ifNoneMatch: first.etag });
  assert.equal(moved.unchanged, false);
  assert.notEqual(moved.etag, first.etag);
  assert.match(moved.body, /DTSTART:20261020T110000Z/);
  profile = f.profile();
  profile.calendarPersonalVersions.a = 'personal-a-2';
  f.writeProfile(profile);
  f.state.personalEvents.find((event) => event.staffId === 'a').duration = 90;
  const personal = f.read('apple', { ifNoneMatch: moved.etag });
  assert.equal(personal.unchanged, false);
  assert.notEqual(personal.etag, moved.etag);
  assert.match(personal.body, /DTEND:20261021T083000Z/);
});

test('all follows new staff; roster suspension and display-name edits cannot return the old 304', (t) => {
  const f = fixture(t), first = f.read();
  f.addSpecialist('c', 'Вера');
  f.state.appointments.push({ id: 'appointment-c', staffId: 'c', patientName: 'Клиент c', date: '2026-10-20', time: '16:00', duration: 30 });
  const added = f.read('apple', { ifNoneMatch: first.etag });
  assert.equal(added.unchanged, false);
  assert.notEqual(added.etag, first.etag);
  assert.ok(unfold(added.body).includes('Клиент c — приём — Вера'));
  f.writeAccount('a', { ...f.account('a'), displayName: 'Анна Новая' });
  const renamed = f.read('apple', { ifNoneMatch: added.etag });
  assert.equal(renamed.unchanged, false);
  assert.notEqual(renamed.etag, added.etag);
  assert.ok(unfold(renamed.body).includes('Клиент a — приём — Анна Новая'));
  f.db.exec("UPDATE memberships SET status='suspended' WHERE account_id='a' AND organization_id='org'");
  const removed = f.read('apple', { ifNoneMatch: renamed.etag });
  assert.equal(removed.unchanged, false);
  assert.notEqual(removed.etag, renamed.etag);
  assert.ok(!unfold(removed.body).includes('Клиент a'));
  assert.ok(!unfold(removed.body).includes('Анна Новая'));
});

test('selected exclusions survive roster additions and removal of the last selected staff yields an empty calendar', (t) => {
  const f = fixture(t);
  f.select('apple', selected('a'));
  const first = f.read();
  f.addSpecialist('c', 'Вера');
  assert.equal(eventCount(f.read().body), 2);
  f.db.exec("UPDATE memberships SET status='suspended' WHERE account_id='a' AND organization_id='org'");
  const removed = f.read('apple', { ifNoneMatch: first.etag });
  assert.equal(removed.unchanged, false);
  assert.equal(eventCount(removed.body), 0);
  assert.deepEqual(f.status().selection, selected());
});

test('independent workers share an admin validator and never reuse a personal employee validator', (t) => {
  const f = fixture(t), admin = f.read();
  const cold = createCalendarFeedCache().read({
    current: f.service.resolve(f.credentials.apple), storage: f.storage, platform: f.platform,
    now: now + 600000, ifNoneMatch: admin.etag,
  });
  assert.deepEqual(cold, { etag: admin.etag, unchanged: true });
  const ownCredential = f.service.connect('a', f.guard).credential;
  const personal = f.cache.read({
    current: f.service.resolve(ownCredential), storage: f.storage, platform: f.platform,
    now, ifNoneMatch: admin.etag,
  });
  assert.equal(personal.unchanged, false);
  assert.notEqual(personal.etag, admin.etag);
  assert.equal(eventCount(personal.body), 2);
  assert.ok(!unfold(personal.body).includes('Клиент b'));
});

test('feed route emits no stale 200 or 304 if scope, roster or access changes after cache read', (t) => {
  const f = fixture(t), route = routes.find((value) => value.path === '/api/calendar/feed.ics');
  for (const unchanged of [false, true]) {
    for (const change of ['selection', 'name', 'membership', 'access']) {
      f.select('apple', { mode: 'all', staffIds: [] });
      f.db.exec("UPDATE memberships SET status='active' WHERE account_id IN ('a','admin') AND organization_id='org'");
      const first = f.read();
      let emitted = 0, reads = 0;
      const context = {
        url: new URL('https://synthetic.test/api/calendar/feed.ics?subscription=' + f.credentials.apple),
        req: { headers: unchanged ? { 'if-none-match': first.etag } : {} },
        platform: f.platform,
        tenantStore: (organizationId) => { assert.equal(organizationId, 'org'); return f.storage; },
        calendarFeeds: {
          read(options) {
            reads++;
            const result = f.cache.read({ ...options, now });
            assert.equal(result.unchanged, unchanged);
            if (change === 'selection') f.select('apple', selected('b'));
            if (change === 'name') f.writeAccount('a', { ...f.account('a'), displayName: 'Анна ' + f.status().selectionRevision });
            if (change === 'membership') f.db.exec("UPDATE memberships SET status='suspended' WHERE account_id='a' AND organization_id='org'");
            if (change === 'access') f.db.exec("UPDATE memberships SET status='suspended' WHERE account_id='admin' AND organization_id='org'");
            return result;
          },
        },
        res: {
          setHeader() { emitted++; }, writeHead() { emitted++; }, end() { emitted++; },
        },
      };
      assert.throws(() => route.handle(context), (error) => change === 'access'
        ? error.status === 404 : error.status === 503 && error.retryAfter === 1);
      assert.equal(reads, 1);
      assert.equal(emitted, 0);
      f.db.exec("UPDATE memberships SET status='active' WHERE account_id IN ('a','admin') AND organization_id='org'");
    }
  }
});
