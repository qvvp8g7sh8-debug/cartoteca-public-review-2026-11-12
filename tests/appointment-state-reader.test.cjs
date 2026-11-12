const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');
const { createTelegramStore } = require('../src/server/modules/notifications/telegram-store.cjs');
const {
  createAppointmentConfirmations,
} = require('../src/server/modules/cabinet/confirmations.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');
const {
  createAppointmentStateReader,
} = require('../src/server/modules/notifications/appointment-state-reader.cjs');
const {
  fingerprint,
  serviceFingerprint,
} = require('../src/server/modules/notifications/appointments.cjs');
const {
  appointmentRows,
  pairKey,
} = require('../src/server/modules/notifications/appointment-state-batch.cjs');

function measuredDatabase(db) {
  let reads = 0,
    prepares = 0;
  const plans = [],
    planned = new Set();
  return {
    db: {
      prepare(sql) {
        prepares++;
        const statement = db.prepare(sql);
        return new Proxy(statement, {
          get(target, name) {
            const value = target[name];
            if (typeof value !== 'function') return value;
            return (...args) => {
              if (['get', 'all', 'iterate'].includes(name)) reads++;
              if (name === 'all' && sql.startsWith('WITH request_scope') && !planned.has(sql)) {
                planned.add(sql);
                plans.push(
                  db
                    .prepare('EXPLAIN QUERY PLAN ' + sql)
                    .all(...args)
                    .map((row) => row.detail),
                );
              }
              return value.apply(target, args);
            };
          },
        });
      },
    },
    counters: () => ({ reads, prepares }),
    plans: () => plans,
    reset: () => {
      reads = 0;
      prepares = 0;
    },
  };
}

test('calendar batches match scalar receipts, keep tenant/stamp checks and bound SQL by chunks', (t) => {
  const f = maxFixture(t),
    zone = f.platform.organizationTimeZone('org');
  const { db, seal } = f.database;
  const patients = [
    { id: 'p', appointments: [] },
    { id: 'staff-p', appointments: [] },
  ];
  const link = db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?)');
  for (const p of patients) link.run('org', p.id, p.id, seal({ chatId: p.id, linkedAt: 1 }));
  const manual = db.prepare('INSERT INTO appointment_manual_confirmations VALUES(?,?,?,?)');
  const telegram = db.prepare('INSERT INTO telegram_confirmations VALUES(?,?,?,?,?)');
  for (let i = 0; i < 450; i++) {
    const p = patients[i % 2],
      a = {
        id: 'appointment-' + i,
        date: '2099-01-01',
        time: '10:00',
        duration: 15,
        staffId: 'owner',
        service: 'Synthetic',
        ...(i % 11 === 0 ? { status: 'completed' } : {}),
      };
    p.appointments.push(a);
    if (i % 3 === 0)
      manual.run(
        'org',
        p.id,
        a.id,
        seal({
          stamp: i % 9 === 0 ? 'obsolete' : f.platform.appointmentConfirmations.stamp(a, zone),
          actorId: i % 6 === 0 ? 'outsider' : 'owner',
          confirmedAt: 1000 + i,
        }),
      );
    if (i % 5 === 0) telegram.run('org', p.id, fingerprint(a, zone), p.id, 2000 + i);
  }
  const expected = patients.flatMap((p) =>
    p.appointments.map((a) => ({
      ...a,
      bookingSource: undefined,
      telegramConfirmedAt: f.platform.telegram.confirmed(
        'org',
        p.id,
        fingerprint(a, zone),
        serviceFingerprint(a),
      ),
      manualConfirmedAt: null,
      manualConfirmedBy: '',
      ...f.platform.appointmentConfirmations.read('org', p.id, a, zone),
      confirmationKey: crypto
        .createHash('sha256')
        .update(JSON.stringify([fingerprint(a, zone), serviceFingerprint(a), a.roomId || '']))
        .digest('hex'),
    })),
  );
  const measured = measuredDatabase(db),
    context = {
      ...f.database,
      db: measured.db,
      crypto,
      organizationTimeZone: () => zone,
    };
  const store = createTelegramStore(context),
    confirmations = createAppointmentConfirmations(context);
  const reader = createAppointmentStateReader({
    platform: { appointmentConfirmations: confirmations },
    store,
    tenantStore: () => ({ get: () => false }),
  });
  measured.reset();
  const result = reader({ patients }, 'org').patients.flatMap((p) => p.appointments);
  assert.deepEqual(result, expected);
  assert.ok(measured.counters().reads <= 10, JSON.stringify(measured.counters()));
  assert.ok(
    measured
      .plans()
      .every(
        (plan) =>
          plan.some((detail) =>
            /SEARCH c USING INDEX.*organization_id=\? AND patient_id=\?/.test(detail),
          ) ||
          (plan.some((detail) => /SEARCH a USING INDEX.*id=\?/.test(detail)) &&
            plan.some((detail) =>
              /SEARCH m USING.*organization_id=\? AND account_id=\?/.test(detail),
            )),
      ),
    JSON.stringify(measured.plans()),
  );
  measured.reset();
  assert.deepEqual(
    reader({ patients }, 'org').patients.flatMap((p) => p.appointments),
    expected,
  );
  assert.equal(
    measured.counters().prepares,
    0,
    'second response reuses statements, not stale values',
  );
  const foreign = reader({ patients }, 'other-org').patients.flatMap((p) => p.appointments);
  assert.ok(foreign.every((a) => a.telegramConfirmedAt === null && a.manualConfirmedAt === null));
  db.prepare('DELETE FROM telegram_links WHERE organization_id=?').run('org');
  assert.ok(
    reader({ patients }, 'org')
      .patients.flatMap((p) => p.appointments)
      .every((a) => a.telegramConfirmedAt === null),
  );
});

test('common batch equals fresh descriptions and never supplies cached authorization to delivery', async (t) => {
  const f = maxFixture(t);
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  const store = createNotificationStore(f.database),
    values = new Map();
  let selectedReads = 0;
  const tenantStore = (org) => ({
    ...f.tenantStore(org),
    get: (key) => values.get(key),
    transaction: (work) => work(),
    readSelected(ids) {
      selectedReads++;
      return f.tenantStore(org).readSelected(ids);
    },
  });
  for (let i = 0; i < 230; i++)
    f.patients[i % 2].appointments.push({
      id: 'a-' + i,
      date: '2099-01-01',
      time: '12:00',
      duration: 15,
      service: 'Synthetic',
      staffId: i % 7 === 0 ? 'outsider' : 'owner',
      ...(i % 13 === 0 ? { status: 'completed' } : {}),
    });
  for (const p of f.patients) {
    const issue = f.links.issue('org', p.id, 'owner', '123', () => {}, f.now);
    f.links.consume(issue.token, '123', p.id === 'p' ? '111' : '222', () => {}, f.now);
  }
  const sent = [],
    providers = {
      max: {
        status: () => ({ connected: true, configured: true, botId: '123' }),
        acquire: async () => true,
        send: async (job) => sent.push(job),
      },
    };
  const coordinator = createNotificationCoordinator({
    platform: f.platform,
    tenantStore,
    store,
    links: f.links,
    providers,
    clock: () => f.now,
  });
  const expected = new Map(
    f.patients.flatMap((p) =>
      p.appointments.map((a) => [pairKey(p.id, a.id), coordinator.describe('org', p.id, a)]),
    ),
  );
  selectedReads = 0;
  assert.deepEqual(coordinator.describeMany('org', f.patients), expected);
  assert.equal(selectedReads, 1, 'one tenant snapshot for the whole response');
  const p = f.patients[0],
    a = p.appointments.find((a) => a.staffId === 'owner' && !a.status);
  coordinator.remind('org', p.id, a.id, () => {});
  const rows = appointmentRows(
    [p],
    f.platform.organizationTimeZone('org'),
    f.platform.appointmentConfirmations,
  );
  const snapshot = store.readMany('org', rows);
  assert.equal(snapshot.jobs.get(pairKey(p.id, a.id)).length, 1);
  assert.equal(
    coordinator.describeMany('org', [p]).get(pairKey(p.id, a.id)).deliveryStatus,
    'pending',
  );
  f.database.db
    .prepare("UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?")
    .run('org', 'owner');
  await coordinator.tick();
  assert.equal(sent.length, 0, 'delivery checks current membership after prior read');
  assert.equal(store.readMany('org', rows).jobs.get(pairKey(p.id, a.id))[0].status, 'cancelled');
  assert.deepEqual(
    coordinator.describeMany('org', f.patients),
    new Map(
      f.patients.flatMap((p) =>
        p.appointments.map((a) => [pairKey(p.id, a.id), coordinator.describe('org', p.id, a)]),
      ),
    ),
  );
});

test('decoration shares visible identities while policy rereads edits and membership in each response', (t) => {
  const f = maxFixture(t);
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  const a = {
    id: 'shared-read',
    date: '2099-01-01',
    time: '12:00',
    duration: 30,
    serviceItems: [{ id: 'service', name: 'Synthetic' }],
    staffId: 'owner',
    roomId: 'room',
  };
  f.patients[0].appointments.push(a);
  const issue = f.links.issue('org', 'p', 'owner', '123', () => {}, f.now);
  f.links.consume(issue.token, '123', '111', () => {}, f.now);
  const confirmations = f.platform.appointmentConfirmations,
    zone = f.platform.organizationTimeZone('org');
  let identities = 0,
    scalarStamps = 0,
    freshReads = 0;
  const platform = {
    ...f.platform,
    appointmentConfirmations: {
      ...confirmations,
      identity(appointment, timeZone) {
        identities++;
        return confirmations.identity(appointment, timeZone);
      },
      stamp(appointment, timeZone) {
        scalarStamps++;
        return confirmations.stamp(appointment, timeZone);
      },
    },
  };
  const tenantStore = (org) => ({
    ...f.tenantStore(org),
    get: () => null,
    readSelected(ids) {
      freshReads++;
      return f.tenantStore(org).readSelected(ids);
    },
  });
  const store = createNotificationStore(f.database),
    coordinator = createNotificationCoordinator({
      platform,
      tenantStore,
      store,
      links: f.links,
      providers: {
        max: { status: () => ({ connected: true, configured: true, botId: '123' }) },
      },
      clock: () => f.now,
    }),
    reader = createAppointmentStateReader({
      platform,
      store: platform.telegram,
      tenantStore,
      coordinator,
    });
  f.database.db
    .prepare('INSERT INTO appointment_manual_confirmations VALUES(?,?,?,?)')
    .run(
      'org',
      'p',
      a.id,
      f.database.seal({ stamp: confirmations.stamp(a, zone), actorId: 'owner', confirmedAt: 10 }),
    );
  const read = () => {
    identities = scalarStamps = freshReads = 0;
    const result = reader({ patients: structuredClone(f.patients) }, 'org');
    assert.equal(identities, 2, 'one visible identity plus one fresh policy identity');
    assert.equal(scalarStamps, 0, 'batch identity does not repeat its component hashes');
    assert.equal(freshReads, 1, 'policy still obtains its own fresh tenant snapshot');
    return result.patients[0].appointments[0];
  };
  const first = read();
  assert.equal(first.manualConfirmedAt, 10);
  assert.deepEqual(first.deliveryChannels, ['max']);
  const scalar = coordinator.describe('org', 'p', a);
  for (const [key, value] of Object.entries(scalar)) assert.deepEqual(first[key], value);
  a.serviceItems[0].name = 'Changed synthetic service';
  const edited = read();
  assert.notEqual(edited.confirmationKey, first.confirmationKey);
  assert.equal(edited.manualConfirmedAt, null, 'a changed service invalidates the old receipt');
  f.database.db
    .prepare("UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?")
    .run('org', 'owner');
  assert.deepEqual(read().deliveryChannels, [], 'a later response sees membership revocation');
  const foreign = reader({ patients: structuredClone(f.patients) }, 'other-org');
  const appointment = foreign.patients[0].appointments[0];
  assert.equal(appointment.manualConfirmedAt, null);
  assert.equal(appointment.telegramConfirmedAt, null);
  assert.deepEqual(appointment.deliveryChannels, []);
});
