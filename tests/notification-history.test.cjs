const test = require('node:test');
const assert = require('node:assert/strict');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');
const {
  createNotificationHistory,
} = require('../src/server/modules/notifications/notification-history.cjs');
const { routes } = require('../src/server/modules/notifications/history-routes.cjs');
function fixture(t) {
  const f = maxFixture(t);
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  const history = createNotificationHistory({ ...f.database, clock: () => f.now });
  return { ...f, history };
}
function insert(f, id, options = {}) {
  const {
    org = 'org',
    patient = 'p',
    appointment = 'a',
    channel = 'telegram',
    status = 'pending',
    value = {},
    lease = f.now + 120000,
  } = options;
  f.database.db
    .prepare(
      'INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      org,
      patient,
      appointment,
      'stamp-' + id,
      channel,
      'callback-' + org + '-' + id,
      f.database.seal({
        kind: 'reminder',
        recipient: { chatId: 'PRIVATE-CHAT', userId: 'PRIVATE-USER' },
        callback: 'PRIVATE-CALLBACK',
        service: 'PRIVATE-SERVICE',
        sourceStamp: 'PRIVATE-STAMP',
        ...value,
      }),
      status,
      f.now + 777,
      f.now + 86400000,
      lease,
    );
}
function legacy(f, id, appointment, confirmedAt = null) {
  f.database.db
    .prepare(
      'INSERT INTO telegram_jobs(id,organization_id,patient_id,fingerprint,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      'org',
      'p',
      'fingerprint-' + id,
      'callback-' + id,
      f.database.seal({
        appointmentId: appointment,
        chatId: 'PRIVATE-CHAT',
        callback: 'PRIVATE-CALLBACK',
      }),
      'sent',
      f.now + 12345,
      f.now + 86400000,
    );
  if (confirmedAt)
    f.database.db
      .prepare('INSERT INTO telegram_confirmations VALUES(?,?,?,?,?)')
      .run('org', 'p', 'fingerprint-' + id, 'PRIVATE-CHAT-HASH', confirmedAt);
}

test('history projects queue and confirmation facts without exposing recipients, content or invented dates', (t) => {
  const f = fixture(t);
  const expected = {
    pending: 'queued',
    reserved: 'queued',
    sending: 'sending',
    sent: 'accepted',
    uncertain: 'unknown',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  for (const [index, [status]] of Object.entries(expected).entries()) {
    insert(f, status, {
      status,
      channel: index % 2 ? 'max' : 'telegram',
      value:
        status === 'sent'
          ? {
              kind: 'moved',
              createdAt: f.now - 3000,
              updatedAt: f.now - 1000,
              acceptedAt: f.now - 1000,
              eventAt: f.now - 4000,
            }
          : {},
    });
  }
  insert(f, 'stale-sending', { status: 'sending', lease: f.now - 1 });
  insert(f, 'private-other-appointment', { appointment: 'other-appointment' });
  insert(f, 'private-other-patient', { patient: 'other-patient' });
  insert(f, 'private-other-org', { org: 'other-org' });
  f.database.db.prepare('INSERT INTO notification_confirmations VALUES(?,?,?,?,?)').run(
    'org',
    'p',
    'a',
    'receipt-stamp',
    f.database.seal({
      notificationConfirmedAt: f.now,
      notificationConfirmedChannel: 'max',
      recipient: 'PRIVATE',
    }),
  );
  legacy(f, 'legacy-match', 'a', f.now - 500);
  legacy(f, 'private-legacy-other-appointment', 'other-appointment');
  const saveManual = f.database.db.prepare(
    'INSERT INTO appointment_manual_confirmations VALUES(?,?,?,?)',
  );
  for (const [org, patient, appointment] of [
    ['org', 'p', 'a'],
    ['other-org', 'p', 'a'],
    ['org', 'other-patient', 'a'],
    ['org', 'p', 'other-appointment'],
  ])
    saveManual.run(
      org,
      patient,
      appointment,
      f.database.seal({
        confirmedAt: f.now - 250,
        actorId: 'PRIVATE-ACTOR',
        stamp: 'PRIVATE-STAMP',
      }),
    );
  const result = f.history.read('org', 'p', 'a');
  assert.equal(result.limited, false);
  for (const [status, projected] of Object.entries(expected))
    assert.equal(result.items.find((item) => item.id === 'channel:' + status).status, projected);
  assert.equal(result.items.find((item) => item.id === 'channel:stale-sending').status, 'unknown');
  assert.equal(result.items.filter((item) => item.status === 'client-confirmed').length, 2);
  const manualRows = result.items.filter((item) => item.status === 'staff-confirmed');
  assert.equal(manualRows.length, 1);
  assert.equal(manualRows[0].channel, 'manual');
  assert.equal(manualRows[0].confirmedAt, f.now - 250);
  assert.equal(manualRows[0].acceptedAt, null);
  const accepted = result.items.find((item) => item.id === 'channel:sent');
  assert.equal(accepted.kind, 'moved');
  assert.equal(accepted.acceptedAt, f.now - 1000);
  const old = result.items.find((item) => item.id === 'legacy:legacy-match');
  assert.equal(old.status, 'accepted');
  assert.equal(old.createdAt, null);
  assert.equal(old.updatedAt, null);
  assert.equal(old.acceptedAt, null, 'legacy next_at must never be presented as delivery time');
  const json = JSON.stringify(result);
  assert.doesNotMatch(
    json,
    /PRIVATE|private-|recipient|callback|chatId|userId|actorId|sourceStamp|delivered|readAt/,
  );
});

test('history bounds per-appointment and legacy patient selections and reports truncation', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 52; index++) insert(f, 'bounded-' + index);
  let result = f.history.read('org', 'p', 'a');
  assert.equal(result.items.length, 50);
  assert.equal(result.limited, true);
  for (let index = 0; index < 52; index++)
    legacy(f, 'legacy-bounded-' + index, 'other-appointment');
  result = f.history.read('org', 'p', 'missing');
  assert.deepEqual(result.items, []);
  assert.equal(
    result.limited,
    true,
    'encrypted legacy appointment IDs require an honest patient selection limit',
  );
});

function context(current, query = 'patientId=p&appointmentId=a') {
  let reads = 0,
    snapshots = 0,
    assertions = 0;
  const patients = [
    {
      id: 'p',
      createdBy: 'owner',
      visits: [],
      appointments: [
        { id: 'a', staffId: 'staff' },
        { id: 'colleague', staffId: 'owner' },
      ],
    },
  ];
  const c = {
    url: new URL('https://synthetic.test/api/notifications/history?' + query),
    assertCurrent: () => assertions++,
    requireCurrent: () => current,
    tenantStore: (org) => ({
      readSelected: (ids) => {
        assert.deepEqual(ids, ['p']);
        return { patients: org === 'org' ? patients : [] };
      },
    }),
    platform: {
      withReadSnapshot: (work) => {
        snapshots++;
        return work();
      },
      notificationHistory: {
        read: (org, patient, appointment) => {
          reads++;
          assert.deepEqual([org, patient, appointment], ['org', 'p', 'a']);
          return { items: [], limited: false };
        },
      },
    },
    json: (_, status, result) => ({ status, result }),
  };
  return { c, patients, counts: () => ({ reads, snapshots, assertions }) };
}

test('history route checks fresh appointment ACL before any delivery query, including shared cards and deletion', async () => {
  const route = routes[0];
  assert.equal(route.method, 'GET');
  assert.equal(route.access, 'organization');
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    const f = context({
      organizationId: 'org',
      accountId: role === 'cosmetologist' ? 'staff' : 'owner',
      role,
    });
    const response = await route.handle(f.c);
    assert.deepEqual(response, {
      status: 200,
      result: { patientId: 'p', appointmentId: 'a', items: [], limited: false },
    });
    assert.deepEqual(f.counts(), { reads: 1, snapshots: 1, assertions: 1 });
  }
  const staff = { organizationId: 'org', accountId: 'staff', role: 'cosmetologist' };
  for (const [current, query, status] of [
    [staff, 'patientId=p&appointmentId=colleague', 404],
    [staff, 'patientId=p&appointmentId=deleted', 404],
    [{ ...staff, organizationId: 'other-org' }, 'patientId=p&appointmentId=a', 404],
    [{ ...staff, role: 'global_admin' }, 'patientId=p&appointmentId=a', 403],
  ]) {
    const f = context(current, query);
    await assert.rejects(route.handle(f.c), { status });
    assert.equal(f.counts().reads, 0);
  }
  const deleted = context(staff);
  deleted.patients[0].appointments = [];
  await assert.rejects(route.handle(deleted.c), { status: 404 });
  assert.equal(deleted.counts().reads, 0);
});

test('history route rejects malformed, duplicate and extra parameters before reading stores', async () => {
  for (const query of [
    '',
    'patientId=p',
    'patientId=p&appointmentId=',
    'patientId=p&patientId=other&appointmentId=a',
    'patientId=p&appointmentId=a&limit=9999',
    'patientId=p&appointmentId=' + 'a'.repeat(121),
  ]) {
    const f = context({ organizationId: 'org', accountId: 'owner', role: 'owner' }, query);
    await assert.rejects(routes[0].handle(f.c), { status: 400 });
    assert.deepEqual(f.counts(), { reads: 0, snapshots: 0, assertions: 0 });
  }
});
