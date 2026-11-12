const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarAdminFixture } = require('./helpers/calendar-admin-fixture.cjs');
const { routes } = require('../src/server/modules/calendar/subscription-routes.cjs');

const providers = ['apple', 'google'];
const all = () => ({ mode: 'all', staffIds: [] });
const selected = (...staffIds) => ({ mode: 'selected', staffIds });
const expectedRoster = [
  { id: 'a', displayName: 'Анна' }, { id: 'b', displayName: 'Борис' },
  { id: 'owner', displayName: 'Владелец' },
];
const byId = (values) => [...values].sort((a, b) => a.id.localeCompare(b.id));

test('an administrator defaults to all active specialists in this organization without connecting or writing', (t) => {
  const f = calendarAdminFixture(t), before = f.account();
  for (const provider of providers) {
    const current = f.status(provider);
    assert.equal(current.connected, false);
    assert.equal(current.credential, null);
    assert.deepEqual(current.selection, all());
    assert.deepEqual(byId(current.specialists), expectedRoster);
    assert.equal(typeof current.selectionRevision, 'string');
    assert.ok(current.selectionRevision.length > 0);
    assert.equal(f.status(provider).selectionRevision, current.selectionRevision);
  }
  assert.deepEqual(f.account(), before);
  assert.equal(f.audits.length, 0);
});

test('provider selections persist independently while off and survive disconnect and reconnect', (t) => {
  const f = calendarAdminFixture(t);
  const apple = f.select('apple', selected('a'));
  assert.equal(apple.connected, false);
  assert.equal(apple.credential, null);
  assert.deepEqual(apple.selection, selected('a'));
  assert.notEqual(apple.selectionRevision, f.status('google').selectionRevision);
  assert.deepEqual(f.status('google').selection, all());
  f.select('google', selected('b', 'owner'));
  for (const provider of providers) {
    const preference = f.status(provider);
    const connected = f.service.connect('admin', f.guard, provider);
    const firstCredential = connected.credential;
    assert.ok(firstCredential);
    assert.deepEqual(connected.selection, preference.selection);
    assert.equal(connected.selectionRevision, preference.selectionRevision);
    const resolved = f.service.resolve(firstCredential);
    assert.equal(resolved.role, 'salon_admin');
    assert.deepEqual(resolved.selection, preference.selection);
    assert.deepEqual(resolved.specialists.map((staff) => staff.id).sort(), preference.selection.staffIds.slice().sort());
    const off = f.service.disconnect('admin', f.guard, provider);
    assert.equal(off.connected, false);
    assert.equal(off.credential, null);
    assert.deepEqual(off.selection, preference.selection);
    assert.equal(off.selectionRevision, preference.selectionRevision);
    assert.throws(() => f.service.resolve(firstCredential), { status: 404 });
    const reconnected = f.service.connect('admin', f.guard, provider);
    assert.notEqual(reconnected.credential, firstCredential);
    assert.deepEqual(reconnected.selection, preference.selection);
  }
  assert.equal(f.account().untouchedSetting, 'synthetic-admin');
  assert.deepEqual(f.service.status('other', 'google').selection, all());
  assert.deepEqual(f.service.status('peer', 'google').selection, all());
  assert.equal(f.service.status('other', 'google').connected, false);
  assert.equal(f.service.status('peer', 'google').connected, false);
});

test('changing a connected selection preserves its URL and does not connect another provider', (t) => {
  const f = calendarAdminFixture(t);
  const connected = f.service.connect('admin', f.guard, 'apple');
  const revised = f.select('apple', selected('b'));
  assert.equal(revised.connected, true);
  assert.equal(revised.credential, connected.credential);
  assert.deepEqual(f.service.resolve(connected.credential).specialists, [{ id: 'b', displayName: 'Борис' }]);
  assert.equal(f.status('google').connected, false);
  f.select('apple', all());
  assert.deepEqual(byId(f.service.resolve(connected.credential).specialists), expectedRoster);
});

test('invalid selection, non-specialists, foreign members and stale revisions perform no writes', (t) => {
  const f = calendarAdminFixture(t);
  for (const selection of [
    null, {}, { mode: 'unknown', staffIds: [] }, selected(), selected('foreign'),
    selected('admin'), selected('peer'), selected('global'), selected('blocked-account'),
    selected('blocked-member'), { mode: 'selected', staffIds: 'a' },
  ]) {
    const before = f.account(), audits = f.audits.length;
    assert.throws(() => f.select('apple', selection), { status: 400 });
    assert.deepEqual(f.account(), before);
    assert.equal(f.audits.length, audits);
  }
  const originalRevision = f.status().selectionRevision;
  f.select('apple', selected('a'));
  const before = f.account(), audits = f.audits.length;
  assert.throws(() => f.select('apple', selected('b'), originalRevision), { status: 409 });
  assert.throws(() => f.service.updateSelection('admin', f.guard, 'apple', { selection: all() }), { status: 400 });
  const staleSession = Object.assign(Error('Synthetic stale session'), { status: 403 });
  assert.throws(() => f.service.updateSelection('admin', () => { throw staleSession; }, 'apple', {
    selection: all(), expectedSelectionRevision: f.status().selectionRevision,
  }), (error) => error === staleSession);
  assert.deepEqual(f.account(), before);
  assert.equal(f.audits.length, audits);
});

test('roster changes advance the revision; all follows new staff and selected never broadens', (t) => {
  const f = calendarAdminFixture(t);
  f.select('google', selected('a', 'b'));
  const apple = f.service.connect('admin', f.guard, 'apple').credential;
  const google = f.service.connect('admin', f.guard, 'google').credential;
  const before = f.status('apple').selectionRevision;
  f.addSpecialist('c', 'Вера');
  assert.notEqual(f.status('apple').selectionRevision, before);
  assert.throws(() => f.select('apple', selected('c'), before), { status: 409 });
  assert.ok(f.service.resolve(apple).specialists.some((staff) => staff.id === 'c'));
  assert.deepEqual(f.service.resolve(google).specialists.map((staff) => staff.id).sort(), ['a', 'b']);
  f.db.exec("UPDATE memberships SET status='suspended' WHERE account_id='b' AND organization_id='org'");
  assert.deepEqual(f.status('google').selection, selected('a'));
  assert.deepEqual(f.service.resolve(google).specialists, [{ id: 'a', displayName: 'Анна' }]);
  f.db.exec("UPDATE accounts SET status='suspended' WHERE id='a'");
  assert.deepEqual(f.service.resolve(google).specialists, []);
  assert.deepEqual(f.status('google').selection, selected());
});

test('personal subscriptions and organization subscriptions cannot widen when a role changes', (t) => {
  const f = calendarAdminFixture(t);
  for (const provider of providers) {
    const personal = f.service.connect('a', f.guard, provider);
    assert.deepEqual(f.service.status('a', provider), personal);
    assert.deepEqual(Object.keys(personal).sort(), ['connected', 'credential']);
    f.db.exec("UPDATE memberships SET role='salon_admin' WHERE account_id='a' AND organization_id='org'");
    assert.equal(f.service.status('a', provider).connected, false);
    assert.throws(() => f.service.resolve(personal.credential), { status: 404 });
    const organization = f.service.connect('a', f.guard, provider);
    assert.notEqual(organization.credential, personal.credential);
    assert.equal(f.service.resolve(organization.credential).role, 'salon_admin');
    f.db.exec("UPDATE memberships SET role='cosmetologist' WHERE account_id='a' AND organization_id='org'");
    assert.throws(() => f.service.resolve(organization.credential), { status: 404 });
    assert.deepEqual(f.service.status('a', provider), personal);
    assert.deepEqual(f.service.resolve(personal.credential), { accountId: 'a', organizationId: 'org', role: 'cosmetologist' });
  }
  for (const token of ['a', 'owner', 'global'])
    assert.throws(() => f.service.updateSelection(token, f.guard, 'apple', {
      selection: selected('b'), expectedSelectionRevision: f.status().selectionRevision,
    }), { status: 403 });
  assert.throws(() => f.service.status('global'), { status: 403 });
});

test('admin credentials recheck account, organization, membership and plan access', (t) => {
  const f = calendarAdminFixture(t);
  for (const provider of providers) {
    const { credential } = f.service.connect('admin', f.guard, provider);
    for (const [table, condition] of [
      ['accounts', "id='admin'"], ['organizations', "id='org'"],
      ['memberships', "account_id='admin' AND organization_id='org'"],
    ]) {
      f.db.exec(`UPDATE ${table} SET status='suspended' WHERE ${condition}`);
      assert.throws(() => f.service.resolve(credential), { status: 404 });
      assert.throws(() => f.status(provider), { status: 403 });
      f.db.exec(`UPDATE ${table} SET status='active' WHERE ${condition}`);
    }
  }
  const { credential } = f.service.connect('admin', f.guard);
  f.suspendPlan();
  assert.throws(() => f.service.resolve(credential), { status: 404 });
  assert.throws(() => f.status(), { status: 403 });
});

test('PUT dispatches provider selection through the actual subscription service without enabling it', async (t) => {
  const f = calendarAdminFixture(t), route = routes.find((value) =>
    value.method === 'PUT' && value.path === '/api/calendar/subscription');
  assert.ok(route);
  assert.equal(route.access, 'organization');
  for (const provider of providers) {
    let guarded = 0, read = 0, response;
    const body = { selection: selected(provider === 'apple' ? 'a' : 'b'), expectedSelectionRevision: f.status(provider).selectionRevision };
    const context = {
      url: new URL('https://synthetic.test/api/calendar/subscription?provider=' + provider),
      req: {}, res: {}, token: 'admin', platform: { calendarSubscription: f.service },
      assertCurrent: () => { guarded++; },
      readBody: async () => { read++; return body; },
      json: (_res, code, value) => { assert.equal(code, 200); response = value; return value; },
    };
    await route.handle(context);
    assert.equal(guarded, 1);
    assert.equal(read, 1);
    assert.equal(response.connected, false);
    assert.equal(response.credential, null);
    assert.deepEqual(response.selection, body.selection);
    assert.deepEqual(f.status(provider).selection, body.selection);
  }
});
