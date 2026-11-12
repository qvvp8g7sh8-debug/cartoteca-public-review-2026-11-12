const test = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
const { createPushQueue } = require('../src/server/modules/notifications/push-queue.cjs');
function queue(f, state = { available: true, events: true, tests: true }, transaction) {
  return createPushQueue(
    { ...f.c, ...(transaction ? { transaction, queueTransaction: transaction } : {}) },
    {
      runtimeAvailable: () => state.available,
      hasEnabledEvents: () => state.events,
      hasPendingTests: () => state.tests,
    },
  );
}
function put(f, id, device = id, options) {
  f.staff('push', id, options);
  f.c.db.prepare('UPDATE staff_push_jobs SET device_id=? WHERE id=?').run(device, id);
}
for (const enabled of [false, true]) {
  test(`managed Push claim preserves due order/CAS/lease boundary and excludes live devices, Q1=${enabled}`, async (t) => {
    const f = await maintenanceFixture(t, { enabled }),
      q = queue(f),
      now = f.clock();
    put(f, 'a-first', 'one', { due: now - 20 });
    put(f, 'b-same-device', 'one', { due: now - 10 });
    put(f, 'c-other-device', 'two');
    assert.equal(q.peekManaged(now).next_at, now - 20);
    const first = q.claimManaged(now);
    assert.equal(first.id, 'a-first');
    assert.equal(first.attempts, 1);
    assert.equal(first.lease_until, now + 60000);
    assert.equal(
      q.claimManaged(now).id,
      'c-other-device',
      'same-device live lease must block another external send',
    );
    assert.equal(q.peekManaged(now), null);
    assert.equal(q.claimManaged(now), null);
    assert.equal(q.finish(first, 'sent'), 1);
    assert.equal(q.claimManaged(now).id, 'b-same-device');
    f.c.db.exec('DELETE FROM staff_push_jobs');
    put(f, 'future-retry', 'same', { due: now + 3600000 });
    put(f, 'fresh-cancellation', 'same', { due: now });
    assert.equal(
      q.claimManaged(now).id,
      'fresh-cancellation',
      'a future retry must not create a new HOL barrier',
    );
    f.c.db.exec('DELETE FROM staff_push_jobs');
    for (const id of ['я', '😀', 'aa', 'a', 'é', 'Z'])
      put(f, id, id, {
        due: now,
        status: id === 'a' ? 'sending' : 'pending',
        lease: id === 'a' ? now : 0,
      });
    const expected = f.c.db
      .prepare('SELECT id FROM staff_push_jobs ORDER BY next_at,id')
      .all()
      .map((r) => r.id);
    const actual = [];
    for (const id of expected) {
      const job = q.claimManaged(now);
      actual.push(job.id);
      assert.equal(job.id, id);
      assert.equal(q.finish(job, 'sent'), 1);
      assert.equal(q.finish(job, 'failed'), 0, 'stale completion cannot overwrite terminal state');
    }
    assert.deepEqual(
      actual,
      expected,
      'SQLite BINARY order, not JS UTF16 comparison, breaks equal-time ties',
    );
    assert.equal(q.peekManaged(now), null);
    f.c.db.exec('DELETE FROM staff_push_jobs');
    put(f, 'expired-lease', 'device', { status: 'sending', lease: now });
    const recovered = q.claimManaged(now);
    assert.equal(recovered.id, 'expired-lease');
    assert.notEqual(recovered.lease_id, 'prior-lease');
    assert.equal(
      q.claimManaged(now + 60000, { excludeDevices: ['device'] }),
      null,
      'local unresolved send remains excluded after its durable lease expires',
    );
    assert.equal(q.peekManaged(now + 60000, { excludeDevices: ['device'] }), null);
    assert.equal(q.claimManaged(now, { excludeOrganizations: [f.owner.organizationId] }), null);
    assert.equal(q.peekManaged(now, { excludeOrganizations: [f.owner.organizationId] }), null);
    assert.throws(
      () => q.peekManaged(now, { excludeDevices: ['1', '2', '3', '4', '5'] }),
      /exclusions/,
    );
  });
  test(`managed Push reselects under transaction, keeps self-test/channel and cleanup semantics, Q1=${enabled}`, async (t) => {
    const f = await maintenanceFixture(t, { enabled }),
      now = f.clock();
    put(f, 'candidate');
    let mutate = true;
    const q = queue(f, undefined, (work) =>
      f.c.transaction(() => {
        if (mutate) {
          mutate = false;
          f.c.db
            .prepare(
              "UPDATE staff_push_jobs SET status='sending',lease_id='other-owner',lease_until=? WHERE id='candidate'",
            )
            .run(now + 60000);
        }
        return work();
      }),
    );
    assert.equal(
      q.claimManaged(now),
      null,
      'pretransaction hint cannot overwrite a freshly acquired live lease',
    );
    f.c.db.exec('DELETE FROM staff_push_jobs');
    put(f, 'ordinary', 'ordinary', { due: now - 1 });
    f.c.db
      .prepare(
        "UPDATE staff_push_jobs SET event_key='staff-push-event:synthetic' WHERE id='ordinary'",
      )
      .run();
    put(f, 'test');
    const state = { available: true, events: false, tests: true },
      probes = queue(f, state);
    assert.equal(probes.claimManaged(now).id, 'test');
    assert.equal(probes.peekManaged(now), null);
    assert.equal(
      f.c.db.prepare("SELECT status FROM staff_push_jobs WHERE id='ordinary'").get().status,
      'pending',
    );
    state.available = false;
    assert.equal(probes.claimManaged(now), null);
    assert.equal(probes.peekManaged(now), null);
    state.available = true;
    state.tests = false;
    assert.equal(probes.claimManaged(now), null);
    f.c.db.exec('DELETE FROM staff_push_jobs');
    put(f, 'expired', 'expired', { expires: now });
    put(f, 'live');
    assert.equal(queue(f).claimManaged(now).id, 'live');
    assert.equal(
      f.c.db.prepare("SELECT status FROM staff_push_jobs WHERE id='expired'").get().status,
      enabled ? 'pending' : 'cancelled',
    );
  });
}
for (const enabled of [false, true])
  test(`managed native SQL heads/probes use indexes; large equal-time limitations are recorded Q1=${enabled}`, async (t) => {
    const f = await maintenanceFixture(t, { enabled }),
      now = f.clock();
    f.c.transaction(() => {
      for (let n = 0; n < 1500; n++) put(f, 'large-' + String(n).padStart(4, '0'));
    });
    const traces = [];
    const native = f.c.db;
    const db = new Proxy(native, {
      get(target, key) {
        if (key === 'prepare')
          return (sql) => {
            const statement = target.prepare(sql);
            if (!sql.includes('NOT EXISTS(SELECT 1 FROM staff_push_jobs live')) return statement;
            return new Proxy(statement, {
              get(stmt, method) {
                if (method === 'get')
                  return (...args) => {
                    traces.push({
                      sql,
                      plan: target
                        .prepare('EXPLAIN QUERY PLAN ' + sql)
                        .all(...args)
                        .map((row) => row.detail),
                    });
                    return stmt.get(...args);
                  };
                const value = stmt[method];
                return typeof value === 'function' ? value.bind(stmt) : value;
              },
            });
          };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const q = createPushQueue(
      { ...f.c, db },
      { runtimeAvailable: () => true, hasEnabledEvents: () => true },
    );
    assert.equal(q.peekManaged(now).next_at, now);
    assert.equal(q.claimManaged(now).id, 'large-0000');
    const probes = traces.filter((row) => row.sql.startsWith('SELECT j.next_at'));
    assert.equal(probes.length, 2);
    for (const row of probes) {
      assert.ok(row.plan.some((detail) => /staff_push_due|nqm_v1_push_ready/.test(detail)));
      assert.ok(
        !row.plan.some((detail) => /TEMP B-TREE/.test(detail)),
        'peek must not sort the ready cohort',
      );
    }
    const heads = traces.filter((row) => row.sql.startsWith('SELECT * FROM ('));
    assert.ok(heads.length >= 2, 'outside hint and locked fresh reselect use identical SQL');
    if (!enabled)
      assert.ok(
        heads.every((row) => row.plan.some((detail) => /TEMP B-TREE/.test(detail))),
        'legacy equal-next_at id ties are not falsely claimed solved without a covering index',
      );
    else {
      assert.ok(
        heads.every((row) => row.plan.some((detail) => detail.includes('nqm_v1_push_ready'))),
        'validated Q1 pending head must use the prepared covering order index',
      );
      assert.ok(
        heads.every((row) =>
          row.plan.some((detail) => /SEARCH j USING INDEX staff_push_due \(status=/.test(detail)),
        ),
        'the sending head seeks status, rather than scanning the whole pending cohort to find zero sending jobs',
      );
      assert.ok(
        heads.every(
          (row) => !row.sql.split(' UNION ALL ')[1].includes('INDEXED BY nqm_v1_push_ready'),
        ),
      );
    }
    t.diagnostic(
      JSON.stringify({
        q1: enabled,
        rows: 1500,
        peekPlans: probes.map((row) => row.plan),
        candidatePlan: heads[0].plan,
      }),
    );
    assert.equal(
      f.c.db.prepare("SELECT count(*) n FROM staff_push_jobs WHERE status='sending'").get().n,
      1,
      'no upfront leases of an entire batch',
    );
  });
