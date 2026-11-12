const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresBusinessFixture } = require('./helpers/postgres-business133-fixture.cjs');
const { createSessionMaintenance } = require('../src/server/modules/auth/session-maintenance.cjs');
const { createPushSchedule } = require('../src/server/modules/notifications/push-events.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
const { advisoryKey } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
test(
  'PostgreSQL bounds session housekeeping and keeps scoped Push claim and canonical read authority',
  { timeout: 180000 },
  async (t) => {
    const f = await postgresBusinessFixture(t),
      db = f.database.db,
      now = Date.now();
    const tokens = [];
    f.database.transaction(() => {
      for (let n = 0; n < 260; n++) {
        const hash = 'expired136-' + String(n).padStart(3, '0');
        tokens.push(hash);
        db.prepare(
          'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)',
        ).run(
          hash,
          randomUUID(),
          f.owner.accountId,
          f.org,
          f.database.seal({ createdAt: now - 10000 }),
          now - 1,
        );
      }
    });
    const liveBefore = db
      .prepare('SELECT * FROM platform_sessions WHERE token_hash=?')
      .get(f.database.tokenHash(f.token));
    const signedIn = await f.platform.login(
      'owner@classic.test',
      'Synthetic-classic-password-2026',
    );
    assert.equal(
      db.prepare('SELECT count(*) n FROM platform_sessions WHERE expires_at<=?').get(now).n,
      260,
      'login never performs global cleanup',
    );
    assert.equal(f.platform.session(signedIn.token).organizationId, f.org);
    let freshened = false;
    const maintenance = createSessionMaintenance(
      {
        ...f.database,
        asyncTransaction(callback, options) {
          if (!freshened) {
            freshened = true;
            f.database.transaction(() =>
              db
                .prepare('UPDATE platform_sessions SET expires_at=? WHERE token_hash=?')
                .run(now + 60000, tokens[0]),
            );
          }
          return f.database.asyncTransaction(callback, options);
        },
      },
      { clock: () => now },
    );
    t.after(() => maintenance.stop());
    for (let n = 0; n < 8; n++) {
      const result = await maintenance.tick({ canRun: () => true });
      assert.ok(result.examined <= 128);
      assert.ok(result.changed <= 128);
    }
    assert.equal(
      db.prepare('SELECT count(*) n FROM platform_sessions WHERE expires_at<=?').get(now).n,
      0,
    );
    assert.ok(
      db.prepare('SELECT 1 FROM platform_sessions WHERE token_hash=?').get(tokens[0]),
      'fresh expiry recheck preserves renewed token',
    );
    assert.deepEqual(
      db
        .prepare('SELECT * FROM platform_sessions WHERE token_hash=?')
        .get(f.database.tokenHash(f.token)),
      liveBefore,
    );
    f.database.transaction(() =>
      db
        .prepare("UPDATE memberships SET status='revoked' WHERE organization_id=? AND account_id=?")
        .run(f.org, f.owner.accountId),
    );
    assert.equal(
      f.platform.session(signedIn.token),
      null,
      'cleanup never caches account or membership authority',
    );
    f.database.transaction(() =>
      db
        .prepare("UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?")
        .run(f.org, f.owner.accountId),
    );
    assert.equal(f.platform.session(signedIn.token).accountId, f.owner.accountId);
    const store = f.platform.staffPush;
    store.setRuntimeAvailable(true);
    const jobId = randomUUID();
    f.database.transaction(() =>
      db
        .prepare(
          'INSERT INTO staff_push_jobs(id,organization_id,account_id,device_id,event_key,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          jobId,
          f.org,
          f.owner.accountId,
          'synthetic-device',
          jobId,
          f.database.seal({
            event: 'test',
            reference: {},
            bindingId: 'synthetic-push-binding',
            channelVersion: 'synthetic-push',
          }),
          'pending',
          now - 1,
          now + 60000,
        ),
    );
    const lock = advisoryKey(
      'cartoteca:platform-organization:v1:' + db.scope.storeId + ':' + f.org,
    );
    await f.admin.query('SELECT pg_advisory_lock($1::bigint)', [lock]);
    try {
      assert.deepEqual(store.claimManagedWithHead(now), { head: null, job: null });
      assert.equal(
        db.prepare('SELECT status FROM staff_push_jobs WHERE id=?').get(jobId).status,
        'pending',
      );
    } finally {
      await f.admin.query('SELECT pg_advisory_unlock($1::bigint)', [lock]);
    }
    const claimed = store.claimManagedWithHead(now);
    assert.equal(claimed.job.id, jobId);
    assert.equal(claimed.head.next_at, now - 1);
    assert.equal(db.isTransaction, false);
    assert.equal(
      store.finish({ ...claimed.job, lease_id: randomUUID() }, 'sent'),
      0,
      'wrong lease cannot settle',
    );
    assert.equal(store.finish(claimed.job, 'sent'), 1);
    assert.deepEqual(store.claimManagedWithHead(now), { head: null, job: null });
    const a = f.storage.readAppointment(
      'synthetic-0',
      f.storage.readSelected(['synthetic-0']).patients[0].appointments[0].id,
    );
    const schedule = createPushSchedule(
      f.platform,
      () => ({
        readAppointment: (patient, id) => f.storage.readAppointment(patient, id),
        readSelected: () => assert.fail('Push must not load patient history'),
      }),
      store,
    );
    const event = {
      organization_id: f.org,
      decoded: {
        event: 'change',
        staffId: a.staffId,
        reference: {
          kind: 'appointment',
          patientId: 'synthetic-0',
          id: a.id,
          stamp: fingerprint(a, f.platform.organizationTimeZone(f.org)),
        },
      },
    };
    assert.equal(
      f.platform.withCompoundMutation(() => schedule.current(event), {
        operation: 'cabinet',
        organizationId: f.org,
        cabinetStoreId: f.storage.db.scope.storeId,
      }),
      true,
    );
  },
);
