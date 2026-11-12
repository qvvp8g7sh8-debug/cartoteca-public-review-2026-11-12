const test = require('node:test');
const assert = require('node:assert/strict');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const events = require('../src/server/modules/notifications/staff-appointment-events.cjs');
const journal = require('../src/server/modules/notifications/appointment-event-journal.cjs');
const {
  createStaffEventReplay,
} = require('../src/server/modules/notifications/staff-event-replay.cjs');
const {
  staffBookingMessage,
  staffNotificationTarget,
} = require('../src/server/modules/notifications/staff-booking-message.cjs');
const {
  createStaffTelegramRuntime,
} = require('../src/server/modules/notifications/staff-runtime.cjs');
const {
  createStaffMaxRuntime,
} = require('../src/server/modules/notifications/staff-max-runtime.cjs');
const types = [
  'created',
  'moved',
  'cancelled',
  'completed',
  'no_show',
  'restored',
  'removed',
  'updated',
  'confirmation',
];
// Privacy is a metadata shape/value contract, not a digit substring in opaque hashes.
function assertPrivateStaffMetadata(entries, privateValues = []) {
  const privateStrings = privateValues.filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  const object = (value, allowed) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.ok(Object.keys(value).every((key) => allowed.includes(key)), 'Only staff metadata fields');
  };
  const scalar = (value) => {
    assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
    assert.ok(
      typeof value !== 'string' || !privateStrings.some((privateValue) => value.includes(privateValue)),
      'Client or clinical value must not be copied, including inside metadata text',
    );
  };
  const flat = (value, allowed) => {
    object(value, allowed);
    Object.values(value).forEach(scalar);
  };
  assert.ok(Array.isArray(entries));
  for (const entry of entries) {
    object(entry, ['kind', 'staffId', 'beforeStaffId', 'recipients', 'channelVersions', 'reference']);
    for (const key of ['kind', 'staffId', 'beforeStaffId']) scalar(entry[key]);
    flat(entry.channelVersions, ['telegram', 'max']);
    object(entry.recipients, ['telegram', 'max']);
    for (const recipients of Object.values(entry.recipients)) {
      assert.ok(Array.isArray(recipients));
      for (const recipient of recipients)
        flat(recipient, ['accountId', 'bindingId', 'eventVersion']);
    }
    const ref = entry.reference;
    object(ref, ['patientId', 'id', 'stamp', 'contentStamp', 'notice', 'status', 'revision', 'snapshot', 'removed']);
    for (const [key, value] of Object.entries(ref)) if (key !== 'snapshot') scalar(value);
    flat(ref.snapshot, ['date', 'time', 'duration', 'staffId', 'status']);
  }
}
async function fixture(t) {
  const f = await bookingFixture({ notificationSchema: 18, patients: 1, appointments: 1 });
  t.after(f.close);
  f.now = Date.now();
  const telegram = f.platform.staffNotifications.issue(f.token, f.now);
  f.platform.staffNotifications.consume(telegram.token, '100001', f.now);
  const max = f.platform.staffMaxNotifications.issue(f.token, '123', f.now);
  f.platform.staffMaxNotifications.consume(max.token, '123', '100002', f.now, f.now);
  const stores = [f.platform.staffNotifications, f.platform.staffMaxNotifications];
  const select = (index, selected = types, enabled = true) =>
    stores[index].update(
      f.token,
      { bindingId: stores[index].status(f.token, '123').bindingId, events: selected, enabled },
      false,
      '123',
    );
  return { ...f, stores, select };
}
function stageMove(f) {
  const before = f.storage.read(),
    next = structuredClone(before);
  next.patients[0].appointments[0].time = '14:00';
  return f.storage.transaction(() => {
    const saved = f.storage.write(next, { insideTransaction: true });
    return events.recordStaffAppointmentEvents(
      f.platform,
      f.org,
      f.storage,
      before,
      { ...next, revision: saved.revision },
      f.now,
    );
  });
}
test('appointment changes are captured only after explicit opt-in and classify every supported lifecycle event', async (t) => {
  const f = await fixture(t),
    before = f.storage.read(),
    original = before.patients[0].appointments[0];
  const moved = structuredClone(before);
  moved.patients[0].appointments[0].time = '14:00';
  assert.deepEqual(events.staffAppointmentEntries(f.platform, f.org, before, moved), []);
  f.select(0);
  f.select(1);
  const legacyStatus = structuredClone(before);
  delete legacyStatus.patients[0].appointments[0].status;
  assert.deepEqual(events.staffAppointmentEntries(f.platform, f.org, legacyStatus, before), []);
  const cases = [
    ['created', { ...original, id: 'new-synthetic-appointment' }, []],
    ['moved', { ...original, time: '14:00' }, [original]],
    ['cancelled', { ...original, status: 'cancelled' }, [original]],
    ['completed', { ...original, status: 'completed' }, [original]],
    ['no_show', { ...original, status: 'no_show' }, [original]],
    ['restored', { ...original, status: 'scheduled' }, [{ ...original, status: 'cancelled' }]],
    ['updated', { ...original, duration: 45 }, [original]],
  ];
  for (const [kind, appointment, previous] of cases) {
    const old = { ...before, patients: [{ ...before.patients[0], appointments: previous }] };
    const next = {
      ...before,
      revision: 10,
      patients: [{ ...before.patients[0], appointments: [appointment] }],
    };
    const captured = events.staffAppointmentEntries(f.platform, f.org, old, next);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].kind, kind);
    assert.equal(captured[0].recipients.telegram[0].accountId, f.owner.accountId);
    assert.equal(captured[0].recipients.max[0].accountId, f.owner.accountId);
    assertPrivateStaffMetadata(captured, [
      before.patients[0].firstName,
      before.patients[0].lastName,
      before.patients[0].name,
      before.patients[0].phone,
      original.service,
    ]);
  }
  const removed = events.staffAppointmentEntries(f.platform, f.org, before, {
    ...before,
    patients: [{ ...before.patients[0], appointments: [] }],
  });
  assert.equal(removed[0].kind, 'removed');
  assert.equal(removed[0].reference.removed, true);
});
test('cabinet journal survives platform rollback and replay deduplicates until post-commit acknowledgement', async (t) => {
  const f = await fixture(t);
  f.select(0);
  f.select(1);
  assert.throws(
    () =>
      f.platform.withWriteLock(() => {
        stageMove(f);
        assert.equal(
          events.replayStaffAppointmentEvents(f.platform, f.org, f.storage, f.now).length,
          1,
        );
        throw Error('Synthetic platform rollback after cabinet commit');
      }),
    /Synthetic platform rollback/,
  );
  assert.equal(f.storage.read().patients[0].appointments[0].time, '14:00');
  assert.equal(journal.pending(f.storage, f.now, 'staff').length, 1);
  for (const store of f.stores) assert.equal(store.claim(f.now), null);
  const ids = f.platform.withWriteLock(() =>
    events.replayStaffAppointmentEvents(f.platform, f.org, f.storage, f.now),
  );
  assert.deepEqual(
    f.platform.withWriteLock(() =>
      events.replayStaffAppointmentEvents(f.platform, f.org, f.storage, f.now),
    ),
    ids,
  );
  for (const store of f.stores) {
    const job = store.claim(f.now);
    assert.equal(job.decoded.event, 'moved');
    const resolve = (value) => events.resolveStaffAppointment(f.platform, () => f.storage, value);
    assert.equal(store.valid(job, f.now, resolve).time, '14:00');
    assert.equal(store.finish(job, 'sent'), true);
    assert.equal(store.claim(f.now), null);
  }
  f.storage.transaction(() => journal.retire(f.storage, ids, f.now));
  assert.equal(journal.pending(f.storage, f.now, 'staff').length, 0);
});
for (const master of [false, true])
  test(
    'captured events are not revived by ' + (master ? 'master' : 'type') + ' off/on before replay',
    async (t) => {
      const f = await fixture(t);
      f.select(0);
      f.select(1);
      f.platform.withWriteLock(() => stageMove(f));
      if (master) {
        f.select(0, types, false);
        f.select(0, types, true);
      } else {
        f.select(0, []);
        f.select(0, types);
      }
      f.platform.withWriteLock(() =>
        events.replayStaffAppointmentEvents(f.platform, f.org, f.storage, f.now),
      );
      assert.equal(f.stores[0].claim(f.now), null);
      assert.equal(f.stores[1].claim(f.now).decoded.event, 'moved');
    },
  );
test('freshness rechecks rescheduling and withdrawn manual confirmation before sending', async (t) => {
  const f = await fixture(t);
  f.select(0);
  f.platform.withWriteLock(() => stageMove(f));
  f.platform.withWriteLock(() =>
    events.replayStaffAppointmentEvents(f.platform, f.org, f.storage, f.now),
  );
  const movedJob = f.stores[0].claim(f.now),
    resolve = (job) => events.resolveStaffAppointment(f.platform, () => f.storage, job);
  assert.ok(f.stores[0].valid(movedJob, f.now, resolve));
  f.stores[0].finish(movedJob, 'sent');
  const cabinet = f.storage.read(),
    patient = cabinet.patients[0],
    a = patient.appointments[0],
    zone = f.platform.organizationTimeZone(f.org);
  f.platform.withWriteLock(() => {
    f.platform.appointmentConfirmations.set(
      f.org,
      patient.id,
      a,
      zone,
      f.owner.accountId,
      true,
      f.now,
    );
    events.staffConfirmation(f.platform, f.org, patient.id, a, f.now);
  });
  const confirmation = f.stores[0].claim(Date.now());
  assert.equal(confirmation.decoded.event, 'confirmation');
  assert.ok(f.stores[0].valid(confirmation, Date.now(), resolve));
  f.platform.withWriteLock(() =>
    f.platform.appointmentConfirmations.set(
      f.org,
      patient.id,
      a,
      zone,
      f.owner.accountId,
      false,
      f.now,
    ),
  );
  assert.equal(f.stores[0].valid(confirmation, Date.now(), resolve), null);
  cabinet.patients[0].appointments[0].time = '15:00';
  f.storage.write(cabinet);
  assert.equal(
    events.resolveStaffAppointment(f.platform, () => f.storage, movedJob),
    null,
  );
});
test('staff messages and protected links carry appointment identity without client contact or clinical copy', () => {
  const job = {
    organization_id: 'synthetic-org',
    decoded: {
      kind: 'appointment',
      event: 'moved',
      reference: { patientId: 'synthetic-patient', id: 'synthetic-appointment' },
    },
  };
  const record = {
    date: '2030-01-01',
    time: '10:00',
    duration: 30,
    name: 'PRIVATE NAME',
    phone: 'PRIVATE PHONE',
    services: [{ name: 'PRIVATE SERVICE' }],
  };
  const platform = { organization: () => ({ name: 'Synthetic organization' }) };
  const text = staffBookingMessage(platform, job, record, 'max', 'https://synthetic.test');
  assert.match(text, /Запись перенесена/);
  assert.match(text, /01\.01\.2030.*10:00.*30 мин/);
  assert.doesNotMatch(text, /PRIVATE/);
  const target = staffNotificationTarget(job, 'https://synthetic.test');
  assert.equal(target.text, 'Открыть запись');
  const values = new URLSearchParams(new URL(target.url).hash.slice(1));
  assert.deepEqual(JSON.parse(values.get('staff-push')), {
    organizationId: 'synthetic-org',
    kind: 'appointment',
    patientId: 'synthetic-patient',
    id: 'synthetic-appointment',
  });
  job.decoded = { kind: 'test', event: 'test' };
  assert.match(staffBookingMessage(platform, job, {}), /Проверочное уведомление/);
});
test('a failed tenant leaves its journal for retry without blocking another tenant or acknowledgement', async (t) => {
  const f = await fixture(t);
  f.select(0);
  f.platform.withWriteLock(() => stageMove(f));
  let failed = true;
  const replay = createStaffEventReplay({
    platform: f.platform,
    clock: () => f.now,
    store: {
      organizationPage: () => ({ organizations: ['synthetic-unavailable', f.org], cursor: '' }),
      inTransaction: () => false,
    },
    tenantStore(org) {
      if (org === 'synthetic-unavailable' && failed) throw Error('Synthetic unavailable cabinet');
      return f.storage;
    },
  });
  replay(undefined, () => true);
  assert.match(replay.status().error, /Не удалось/);
  assert.equal(journal.pending(f.storage, f.now, 'staff').length, 0);
  assert.equal(f.stores[0].claim(f.now).decoded.event, 'moved');
  failed = false;
  f.now += 15001;
  replay(undefined, () => true);
  assert.equal(replay.status().error, '');
});
for (const channel of ['telegram', 'max']) {
  test(
    channel +
      ' worker replays committed cabinet events, acknowledges after queue commit and sends once',
    async (t) => {
      const f = await fixture(t);
      f.select(0);
      f.select(1);
      f.platform.withWriteLock(() => stageMove(f));
      const sent = [],
        options = {
          platform: f.platform,
          tenantStore: () => f.storage,
          store: f.stores[1],
          identity: { botId: '123' },
          origin: 'https://synthetic.test',
          clock: () => f.now,
          pacing: { acquire: async () => true, remaining: () => 0, pause() {} },
          bot: {
            async send(...args) {
              sent.push(args);
            },
          },
        };
      const runtime =
        channel === 'max' ? createStaffMaxRuntime(options) : createStaffTelegramRuntime(options);
      await runtime.tick(undefined, () => true);
      await runtime.tick(undefined, () => true);
      assert.equal(sent.length, 1);
      assert.equal(journal.pending(f.storage, f.now, 'staff').length, 0);
      const message = channel === 'max' ? sent[0][0].text : sent[0][1];
      assert.match(message, /Запись перенесена/);
      assert.doesNotMatch(message, /7999|Клиент0|visits|photos/);
      if (channel === 'max') assert.equal(sent[0][0].link.text, 'Открыть запись');
      else assert.equal(sent[0][2].inline_keyboard[0][0].text, 'Открыть запись');
    },
  );
  test(
    channel + ' rechecks an appointment subscription after pacing before invoking its provider',
    async (t) => {
      const f = await fixture(t),
        index = channel === 'max' ? 1 : 0;
      f.select(index);
      f.platform.withWriteLock(() => stageMove(f));
      let sends = 0;
      const options = {
        platform: f.platform,
        tenantStore: () => f.storage,
        store: f.stores[1],
        identity: { botId: '123' },
        clock: () => f.now,
        pacing: {
          acquire: async () => {
            f.select(index, []);
            return true;
          },
          remaining: () => 0,
          pause() {},
        },
        bot: {
          async send() {
            sends++;
          },
        },
      };
      const runtime =
        channel === 'max' ? createStaffMaxRuntime(options) : createStaffTelegramRuntime(options);
      await runtime.tick(undefined, () => true);
      assert.equal(sends, 0);
      assert.equal(f.stores[index].claim(f.now), null);
    },
  );
}

test('privacy metadata allows opaque 7999 identifiers but rejects personal fields and values', () => {
  const account = '00007999-0000-4000-8000-000000000001';
  const privateName = 'Синтетическое конфиденциальное имя';
  const privatePhone = '+79990000000';
  const privateService = 'Синтетическая конфиденциальная услуга';
  const legal = [{
    kind: 'no_show',
    staffId: account,
    beforeStaffId: account,
    recipients: { telegram: [{
      accountId: account,
      bindingId: '00007999-0000-4000-8000-000000000002',
      eventVersion: '00007999-0000-4000-8000-000000000003',
    }] },
    channelVersions: { telegram: '' },
    reference: {
      patientId: 'synthetic-7999-patient',
      id: 'synthetic-7999-appointment',
      stamp: '7999' + 'a'.repeat(60),
      contentStamp: '670d20df247a799910843519ab5bc5c1888c6159c8cf4ab07af23b2ec7a61bb0',
      notice: 'no_show',
      status: 'no_show',
      revision: 10,
      snapshot: { date: '2030-01-01', time: '13:00', duration: 30, staffId: account, status: 'no_show' },
    },
  }];
  const privateValues = [privateName, privatePhone, privateService];
  assertPrivateStaffMetadata(legal, privateValues);
  for (const leak of [
    (entry) => { entry.reference.snapshot.phone = privatePhone; },
    (entry) => { entry.recipients.telegram[0].name = privateName; },
    (entry) => { entry.reference.id = privatePhone; },
    (entry) => { entry.reference.snapshot.staffId = privateName; },
  ]) {
    const leaked = structuredClone(legal);
    leak(leaked[0]);
    assert.throws(() => assertPrivateStaffMetadata(leaked, privateValues), { code: 'ERR_ASSERTION' });
  }
  // Full sensitive strings must not hide in prefixes/suffixes of otherwise allowed scalar slots.
  for (const privateValue of privateValues)
    for (const decorated of [
      'metadata-prefix:' + privateValue,
      privateValue + ':metadata-suffix',
      'metadata-prefix:' + privateValue + ':metadata-suffix',
    ]) {
      const leaked = structuredClone(legal);
      leaked[0].reference.id = decorated;
      assert.throws(() => assertPrivateStaffMetadata(leaked, privateValues), { code: 'ERR_ASSERTION' });
    }
});
