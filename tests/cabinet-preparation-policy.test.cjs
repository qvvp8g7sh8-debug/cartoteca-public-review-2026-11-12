const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');

async function fixture(t, sharedCabinetWrites = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-preparation-policy-'));
  let platform, storage;
  t.after(() => {
    storage?.close();
    platform?.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.match(path.basename(target), /^cartoteca-preparation-policy-/);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  platform = createPlatformStore(path.join(directory, 'platform'), { sharedCabinetWrites });
  const owner = await platform.registerOwner({
    email: 'prepare@example.test',
    password: 'Synthetic-prepare-password',
    displayName: 'Synthetic',
    organizationName: 'Synthetic',
  });
  platform.verifyEmail(owner.verificationToken);
  const token = (await platform.login('prepare@example.test', 'Synthetic-prepare-password')).token;
  const current = platform.session(token);
  storage = createStorage(path.join(directory, 'tenant'));
  storage.write({
    revision: 0,
    patients: ['first', 'second'].map((id) => ({
      id,
      name: 'Synthetic ' + id,
      createdBy: owner.accountId,
      visits: [],
      appointments: [],
    })),
    services: [],
  });
  const context = {
    current,
    platform,
    token,
    req: { headers: { 'x-cartoteca-operation': 'synthetic-prepared-operation' } },
    tenantStore: (org) => {
      assert.equal(org, owner.organizationId);
      return storage;
    },
    assertCurrent: () => {
      const fresh = platform.session(token);
      if (!fresh || fresh.organizationId !== current.organizationId)
        throw Object.assign(Error('Synthetic authorization failed'), { status: 401 });
      return fresh;
    },
  };
  const patch = (after) => {
    const before = storage.read().patients[0];
    return {
      revision: storage.get('revision'),
      patients: [{ id: before.id, before, after: after(before) }],
      services: [],
    };
  };
  return { directory, platform, owner, token, current, storage, context, patch };
}

for (const shared of [false, true]) {
  test(`shared=${shared}: commit uses the freshly guarded session without a second authority read`, async (t) => {
    const f = await fixture(t, shared),
      originalSession = f.platform.session,
      expectedStage = shared ? 'save-shared-revalidation' : 'save-revalidation';
    let stage = '',
      commitReads = 0;
    f.context.recordStage = (value) => {
      stage = value;
    };
    f.platform.session = (...args) => {
      if (stage === expectedStage) commitReads++;
      return originalSession(...args);
    };
    const result = await saveMutation(
      f.context,
      f.patch((p) => ({ ...p, notes: 'Fresh authority' })),
      { partial: true },
    );
    assert.equal(result.revision, 2);
    assert.equal(commitReads, 1);
    assert.equal(f.storage.read().patients[0].notes, 'Fresh authority');
  });

  test(`shared=${shared}: preparation runs outside locks and cannot authorize a revoked session`, async (t) => {
    const f = await fixture(t, shared),
      original = f.storage.prepareWrite;
    let prepared = 0,
      discarded = 0;
    f.storage.prepareWrite = (...args) => {
      assert.equal(f.storage.db.isTransaction, false);
      const token = original(...args);
      assert.ok(token);
      prepared++;
      f.platform.logout(f.token);
      return token;
    };
    const discard = f.storage.discardPreparedWrite;
    f.storage.discardPreparedWrite = (token) => {
      discarded++;
      discard(token);
    };
    const body = f.patch((p) => ({ ...p, notes: 'Must not save' }));
    await assert.rejects(
      saveMutation(f.context, body, { partial: true }),
      (error) => error.status === 401,
    );
    assert.equal(prepared, 1);
    assert.equal(discarded, 1);
    assert.equal(f.storage.get('revision'), 1);
    assert.equal(f.storage.read().patients[0].notes, undefined);
    assert.equal(f.storage.readCacheBudget.stats().entries, 0);
  });

  test(`shared=${shared}: session revoked while queued is rechecked after lock acquisition and cannot commit`, async (t) => {
    const f = await fixture(t, shared);
    const {
      createPlatformDatabase,
    } = require('../src/server/infrastructure/platform-database.cjs');
    const other = createPlatformDatabase(path.join(f.directory, 'platform'), {
      sharedCabinetWrites: shared,
    });
    const blocker = other.db;
    blocker.exec('BEGIN IMMEDIATE');
    let reached = false;
    f.context.recordStage = (stage) => {
      if (stage === (shared ? 'save-shared-lock' : 'save-platform-lock')) reached = true;
    };
    try {
      const save = saveMutation(
        f.context,
        f.patch((p) => ({ ...p, notes: 'Must not commit' })),
        { partial: true },
      );
      const rejected = assert.rejects(save, (e) => e.status === 401);
      for (let n = 0; !reached && n < 100; n++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(reached, true);
      // Revocation happens in another platform transaction before the queued callback.
      blocker.exec('COMMIT');
      f.platform.logout(f.token);
      await rejected;
      assert.equal(f.storage.get('revision'), 1);
      assert.equal(f.storage.read().patients[0].notes, undefined);
    } finally {
      if (blocker.isTransaction) blocker.exec('ROLLBACK');
      other.closeWriter();
      blocker.close();
    }
  });

  test(`shared=${shared}: unrelated concurrent card changes invalidate preparation but retain PATCH rebase semantics`, async (t) => {
    const f = await fixture(t, shared),
      original = f.storage.prepareWrite;
    f.storage.prepareWrite = (...args) => {
      const token = original(...args);
      assert.ok(token);
      const other = f.storage.readSelected(['second']);
      other.patients[0].notes = 'Concurrent other card';
      f.storage.write(other, { changedIds: { patients: ['second'], services: [] } });
      return token;
    };
    const saved = await saveMutation(
      f.context,
      f.patch((p) => ({ ...p, notes: 'My change' })),
      { partial: true },
    );
    assert.equal(saved.revision, 3);
    assert.deepEqual(
      f.storage.read().patients.map((p) => p.notes),
      ['My change', 'Concurrent other card'],
    );
    assert.equal(f.storage.readCacheBudget.stats().entries, 0);
  });

  test(`shared=${shared}: new overlapping appointment after preparation is rechecked under commit locks`, async (t) => {
    const f = await fixture(t, shared),
      date = '2035-01-01';
    f.platform.workSchedules.save(
      f.token,
      {
        dates: [date],
        staffId: f.owner.accountId,
        status: 'working',
        intervals: [['00:00', '24:00']],
        revision: 0,
        expectedTimeZone: 'Europe/Moscow',
      },
      f.storage,
    );
    const appointment = {
      id: 'ours',
      date,
      time: '10:00',
      duration: 60,
      staffId: f.owner.accountId,
      roomId: 'main',
      status: 'scheduled',
    };
    const body = f.patch((p) => ({ ...p, appointments: [appointment] })),
      original = f.storage.prepareWrite;
    f.storage.prepareWrite = (...args) => {
      const token = original(...args);
      assert.ok(token);
      const other = f.storage.readSelected(['second']);
      other.patients[0].appointments.push({ ...appointment, id: 'concurrent', time: '10:30' });
      f.storage.write(other, { changedIds: { patients: ['second'], services: [] } });
      return token;
    };
    await assert.rejects(
      saveMutation(f.context, body, { partial: true }),
      (error) => error.status === 409 && /занят/.test(error.message),
    );
    assert.equal(f.storage.read().patients[0].appointments.length, 0);
    assert.equal(f.storage.read().patients[1].appointments[0].id, 'concurrent');
    assert.equal(f.storage.get('revision'), 2);
  });

  test(`shared=${shared}: durable-intent boundary is outside platform lock and expiry before cabinet commit rolls back`, async (t) => {
    const f = await fixture(t, shared),
      events = [],
      originalLock = f.platform.withAsyncWriteLock;
    let locked = false,
      guards = 0;
    f.platform.withAsyncWriteLock = (callback, options) =>
      originalLock(() => {
        locked = true;
        try {
          return callback();
        } finally {
          locked = false;
        }
      }, options);
    f.platform.notificationSchedule = {
      enabled: true,
      beginIntent(org, operation) {
        assert.equal(locked, false);
        assert.equal(f.storage.db.isTransaction, false);
        assert.equal(org, f.owner.organizationId);
        assert.equal(operation, 'synthetic-prepared-operation');
        events.push('durable-intent');
        return { id: 'synthetic-intent' };
      },
      assertIntent() {
        assert.equal(locked, true);
        assert.equal(f.storage.db.isTransaction, true);
        events.push('guard');
        guards++;
        if (guards === 3) throw Object.assign(Error('Synthetic intent expired'), { status: 409 });
      },
      markDirty() {
        assert.equal(locked, true);
        events.push('dirty');
      },
      ackIntent() {
        events.push('ack');
      },
    };
    await assert.rejects(
      saveMutation(
        f.context,
        f.patch((p) => ({ ...p, notes: 'Expired change' })),
        { partial: true },
      ),
      (error) => error.status === 409,
    );
    assert.deepEqual(events, ['durable-intent', 'guard', 'guard', 'dirty', 'guard']);
    assert.equal(f.storage.get('revision'), 1);
    assert.equal(f.storage.read().patients[0].notes, undefined);
    assert.equal(f.storage.get('mutation-operation-index', []).length, 0);
  });

  test(`shared=${shared}: intent acknowledgement follows cabinet commit and preparation is released on receipt replay`, async (t) => {
    const f = await fixture(t, shared),
      events = [];
    f.platform.notificationSchedule = {
      enabled: true,
      beginIntent() {
        events.push('begin');
        return { id: 'synthetic-intent' };
      },
      assertIntent() {
        events.push('guard');
      },
      markDirty(org, kind, id) {
        assert.equal(org, f.owner.organizationId);
        assert.equal(kind, 'client');
        assert.equal(id, 'first');
        events.push('dirty');
      },
      ackIntent() {
        assert.equal(f.storage.db.isTransaction, false);
        assert.equal(f.storage.get('revision'), 2);
        events.push('ack');
      },
    };
    const body = f.patch((p) => ({ ...p, notes: 'Saved' }));
    const result = await saveMutation(f.context, body, { partial: true });
    assert.deepEqual(events, ['begin', 'guard', 'guard', 'dirty', 'guard', 'ack']);
    assert.deepEqual(await saveMutation(f.context, body, { partial: true }), result);
    assert.equal(f.storage.get('revision'), 2);
    assert.equal(events.filter((event) => event === 'begin').length, 1);
    assert.equal(f.storage.readCacheBudget.stats().entries, 0);
  });
}

test('shared protocol cannot be reopened silently with uncoordinated current code', async (t) => {
  const f = await fixture(t, true);
  assert.throws(() => createPlatformStore(path.join(f.directory, 'platform')), /all processes/);
});

test('shared cabinet phase runs no platform writer and fails closed on an unexpected side effect', async (t) => {
  const f = await fixture(t, true),
    stages = [];
  f.context.recordStage = (stage) => stages.push(stage);
  const saved = await saveMutation(
    f.context,
    f.patch((p) => ({ ...p, notes: 'Shared note' })),
    { partial: true },
  );
  assert.equal(saved.revision, 2);
  assert.ok(stages.includes('save-shared-commit'));
  assert.equal(stages.includes('save-platform-lock'), false);
  f.context.req.headers['x-cartoteca-operation'] = 'synthetic-second-operation';
  f.platform.appointmentConfirmations.invalidateChanges = () => f.platform.logout(f.token);
  await assert.rejects(
    saveMutation(
      f.context,
      f.patch((p) => ({ ...p, notes: 'Must roll back' })),
      { partial: true },
    ),
    /Platform write attempted/,
  );
  assert.equal(f.storage.get('revision'), 2);
  assert.equal(f.storage.read().patients[0].notes, 'Shared note');
  assert.ok(f.platform.session(f.token));
});

test('shared query-only notes edit preserves an older staff journal until the normal replay', async (t) => {
  const f = await fixture(t, true),
    now = Date.now(),
    org = f.owner.organizationId,
    staff = f.platform.staffNotifications,
    journal = require('../src/server/modules/notifications/appointment-event-journal.cjs'),
    {
      recordStaffAppointmentEvents,
    } = require('../src/server/modules/notifications/staff-appointment-events.cjs'),
    {
      createStaffEventReplay,
    } = require('../src/server/modules/notifications/staff-event-replay.cjs');
  const invitation = staff.issue(f.token, now);
  staff.consume(invitation.token, '100001', now);
  staff.update(f.token, {
    bindingId: staff.status(f.token).bindingId,
    events: ['moved'],
    enabled: true,
  });
  const seed = f.storage.read();
  seed.patients[0].appointments.push({
    id: 'synthetic-pending-staff-appointment',
    date: '2099-01-01',
    time: '10:00',
    duration: 30,
    staffId: f.owner.accountId,
    status: 'scheduled',
  });
  f.storage.write(seed);
  const before = f.storage.read(),
    moved = structuredClone(before);
  moved.patients[0].appointments[0].time = '11:00';
  f.platform.withWriteLock(() =>
    f.storage.transaction(() => {
      const saved = f.storage.write(moved, { insideTransaction: true });
      recordStaffAppointmentEvents(
        f.platform,
        org,
        f.storage,
        before,
        { ...moved, revision: saved.revision },
        now,
      );
    }),
  );
  const pending = journal.pending(f.storage, now, 'staff');
  assert.equal(pending.length, 1);
  let projections = 0;
  const enqueue = staff.enqueueAppointment;
  staff.enqueueAppointment = (...args) => {
    projections++;
    return enqueue(...args);
  };
  const stages = [];
  f.context.recordStage = (stage) => stages.push(stage);
  const saved = await saveMutation(
    f.context,
    f.patch((p) => ({ ...p, notes: 'Synthetic shared note with pending staff event' })),
    { partial: true },
  );
  assert.equal(saved.revision, before.revision + 2);
  assert.ok(stages.includes('save-shared-commit'));
  assert.equal(stages.includes('save-platform-lock'), false);
  assert.equal(
    f.storage.read().patients[0].notes,
    'Synthetic shared note with pending staff event',
  );
  assert.equal(
    projections,
    0,
    'query-only cabinet edits must never project an older platform outbox',
  );
  assert.deepEqual(journal.pending(f.storage, now, 'staff'), pending);
  assert.equal(staff.claim(now), null);
  const replay = createStaffEventReplay({
    platform: f.platform,
    tenantStore: () => f.storage,
    store: staff,
    clock: () => now,
  });
  replay(undefined, () => true);
  assert.equal(replay.status().error, '');
  assert.equal(projections, 1);
  assert.equal(journal.pending(f.storage, now, 'staff').length, 0);
  assert.equal(staff.claim(now).decoded.event, 'moved');
});

test('disabled schedule leaves ordinary shared notes query-only, idempotent and guarded after revocation', async (t) => {
  const f = await fixture(t, true),
    stages = [];
  f.platform.notificationSchedule = {
    enabled: false,
    markDirty() {
      throw Error('Disabled scheduler entered a platform write during shared notes');
    },
  };
  f.context.recordStage = (stage) => stages.push(stage);
  const body = f.patch((p) => ({ ...p, notes: 'Synthetic disabled-scheduler note' }));
  const saved = await saveMutation(f.context, body, { partial: true });
  assert.equal(saved.revision, 2);
  assert.ok(stages.includes('save-shared-commit'));
  assert.equal(stages.includes('save-platform-lock'), false);
  assert.equal(f.storage.read().patients[0].notes, 'Synthetic disabled-scheduler note');
  assert.deepEqual(await saveMutation(f.context, body, { partial: true }), saved);
  assert.equal(f.storage.get('revision'), 2);
  f.platform.logout(f.token);
  f.context.req.headers['x-cartoteca-operation'] = 'synthetic-disabled-scheduler-revoked';
  await assert.rejects(
    saveMutation(
      f.context,
      f.patch((p) => ({ ...p, notes: 'Must not save' })),
      { partial: true },
    ),
    (e) => e.status === 401,
  );
  assert.equal(f.storage.get('revision'), 2);
  assert.equal(f.storage.read().patients[0].notes, 'Synthetic disabled-scheduler note');
});
