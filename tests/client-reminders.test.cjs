const test = require('node:test'),
  assert = require('node:assert/strict');
const { maxFixture } = require('./max-fixture.cjs');
const { routes } = require('../src/server/modules/notifications/client-reminder-routes.cjs');
test('old switch is ignored without rewriting stored settings on a read', (t) => {
  const f = maxFixture(t),
    { db, seal, open } = f.database;
  db.prepare('INSERT INTO telegram_settings VALUES(?,?)').run(
    'org',
    seal({ enabled: false, leadMinutes: 45, showServices: false }),
  );
  assert.equal(f.platform.telegram.settings('org').enabled, true);
  assert.equal(f.platform.telegram.settings('org').showServices, false);
  assert.equal(
    open(db.prepare('SELECT value FROM telegram_settings WHERE organization_id=?').get('org').value)
      .enabled,
    false,
  );
});
test('common period is compare-and-set and preserves timezone and service visibility', (t) => {
  const f = maxFixture(t),
    store = f.platform.telegram;
  const before = store.settings('org');
  const saved = store.saveReminderPeriod('org', 'owner', {
    leadMinutes: 45,
    expectedLeadMinutes: before.leadMinutes,
  });
  assert.equal(saved.leadMinutes, 45);
  assert.equal(saved.timeZone, before.timeZone);
  assert.equal(saved.showServices, before.showServices);
  assert.throws(
    () =>
      store.saveReminderPeriod('org', 'owner', {
        leadMinutes: 60,
        expectedLeadMinutes: before.leadMinutes,
      }),
    (e) => e.status === 409,
  );
  assert.throws(
    () => store.saveReminderPeriod('org', 'owner', { leadMinutes: 1, expectedLeadMinutes: 45 }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      store.saveReminderPeriod('org', 'owner', {
        leadMinutes: 60,
        expectedLeadMinutes: 45,
        timeZone: 'UTC',
      }),
    (e) => e.status === 400,
  );
  assert.equal(store.settings('org').leadMinutes, 45);
  assert.equal(store.settings('other-org').leadMinutes, before.leadMinutes);
});
test('common route rejects staff, global roles and stale access before mutation', async (t) => {
  const f = maxFixture(t),
    route = routes.find((r) => r.method === 'POST');
  for (const role of ['cosmetologist', 'global_admin'])
    await assert.rejects(route.handle({ current: { role } }), (e) => e.status === 403);
  const before = f.platform.telegram.settings('org').leadMinutes;
  await assert.rejects(
    route.handle({
      current: { role: 'owner', organizationId: 'org', accountId: 'owner' },
      platform: f.platform,
      readBody: async () => ({ leadMinutes: 45, expectedLeadMinutes: before }),
      assertCurrent() {
        throw Error('Access changed');
      },
    }),
    /Access changed/,
  );
  assert.equal(f.platform.telegram.settings('org').leadMinutes, before);
});

test('common reminders accept fourteen days but reject larger and non-integer periods', (t) => {
  const f = maxFixture(t),
    store = f.platform.telegram,
    before = store.settings('org');
  const saved = store.saveReminderPeriod('org', 'owner', {
    leadMinutes: 20160,
    expectedLeadMinutes: before.leadMinutes,
  });
  assert.equal(saved.leadMinutes, 20160);
  assert.equal(store.settings('org').leadMinutes, 20160);
  assert.equal(saved.timeZone, before.timeZone);
  assert.equal(saved.showServices, before.showServices);
  for (const leadMinutes of [20161, 43200, 20159.5, 0, '20160', null])
    assert.throws(
      () => store.saveReminderPeriod('org', 'owner', { leadMinutes, expectedLeadMinutes: 20160 }),
      (e) => e.status === 400,
    );
  assert.throws(
    () =>
      store.saveReminderPeriod('org', 'owner', {
        leadMinutes: 10080,
        expectedLeadMinutes: before.leadMinutes,
      }),
    (e) => e.status === 409,
  );
  assert.equal(store.settings('org').leadMinutes, 20160);
});

test('recovery pause survives ordinary saves and resumes only by explicit manager command', (t) => {
  const f = maxFixture(t),
    { db, seal } = f.database,
    store = f.platform.telegram;
  db.prepare('INSERT INTO telegram_settings VALUES(?,?)').run(
    'org',
    seal({ enabled: false, restoredPaused: true, leadMinutes: 45, showServices: false }),
  );
  assert.equal(store.settings('org').enabled, false);
  store.saveReminderPeriod('org', 'owner', { leadMinutes: 60, expectedLeadMinutes: 45 });
  assert.equal(store.settings('org').enabled, false);
  assert.equal(store.settings('org').restoredPaused, true);
  assert.throws(
    () =>
      store.saveReminderPeriod('org', 'owner', {
        leadMinutes: 60,
        expectedLeadMinutes: 60,
        resumeRestored: false,
      }),
    (e) => e.status === 400,
  );
  store.saveReminderPeriod('org', 'owner', {
    leadMinutes: 60,
    expectedLeadMinutes: 60,
    resumeRestored: true,
  });
  assert.equal(store.settings('org').enabled, true);
  assert.notEqual(store.settings('org').restoredPaused, true);
  assert.equal(store.settings('org').showServices, false);
});
