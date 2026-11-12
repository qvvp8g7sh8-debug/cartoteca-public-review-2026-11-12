const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarFixture163 } = require('./helpers/postgres-calendar163-fixture.cjs');
const {
  createAppointmentConfirmations,
} = require('../src/server/modules/cabinet/confirmations.cjs');
test(
  '163 early calendar tokens survive workers and isolate tenants while native background keeps legacy DTO and fresh ACL',
  { timeout: 120000 },
  async (t) => {
    const f = await calendarFixture163(t);
    try {
      const a = await f.kernel(),
        b = await f.kernel(),
        legacy = await f.kernel(false);
      const first = await f.run(a, f.url);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.ok(first.body.version.startsWith('c163.'));
      assert.equal(first.body.appointments.length, 2);
      for (const k of [a, b]) {
        k.trace.length = 0;
        const reply = await f.run(k, f.conditional(first.body));
        assert.deepEqual(reply, {
          status: 200,
          body: { revision: first.body.revision, unchanged: true },
        });
        assert.ok(
          !k.trace.some((sql) =>
            /string_agg|octet_length|cabinet_appointments|cabinet_summaries|telegram_jobs/.test(
              sql,
            ),
          ),
          k.trace.join('\n'),
        );
      }
      await f.admin.query(
        'UPDATE cartoteca_platform.organizations SET slug=slug WHERE _store_id=$1 AND id=$2',
        [f.platform.storeId, f.organizations[1]],
      );
      assert.equal((await f.run(b, f.conditional(first.body))).body.unchanged, true);
      const restarted = await f.kernel();
      assert.equal((await f.run(restarted, f.conditional(first.body))).body.unchanged, true);
      const staff = await f.run(b, f.conditional(first.body), f.actors[1]);
      assert.equal(staff.status, 200, JSON.stringify(staff.body));
      assert.equal(staff.body.unchanged, undefined);
      assert.equal(staff.body.appointments.length, 1);
      for (const actor of f.actors.slice(0, 3))
        for (const path of [
          '/api/cabinet/time-zone',
          '/api/work-schedules?staffId=' + actor.accountId + '&from=2035-01-01&to=2035-01-03',
        ]) {
          const before = await f.run(legacy, path, actor);
          const after = await f.run(a, path, actor);
          assert.equal(after.status, 200, JSON.stringify(after.body));
          assert.deepEqual(after.body, before.body);
        }
      assert.equal(a.kernel.stats().routes.schedules.rpcCalls, 0);
      assert.equal(a.kernel.stats().routes.timeZone.rpcCalls, 0);
      const denied = await f.run(
        a,
        '/api/work-schedules?staffId=' + f.actors[0].accountId + '&from=2035-01-01&to=2035-01-03',
        f.actors[1],
      );
      assert.equal(denied.status, 403);
      const changedRuntime = await f.run(a, f.conditional(first.body), f.actors[0], (m) => {
        m.runtime.providers.max.connected = true;
      });
      assert.equal(changedRuntime.body.unchanged, undefined);
      const same = await f.run(a, f.url);
      await f.admin.query('BEGIN');
      await f.admin.query(
        'UPDATE cartoteca_platform.organizations SET slug=slug WHERE _store_id=$1 AND id=$2',
        [f.platform.storeId, f.organizations[0]],
      );
      await f.admin.query('ROLLBACK');
      assert.equal((await f.run(b, f.conditional(same.body))).body.unchanged, true);
      const appointment = f.storage.read().patients[0].appointments[0];
      const confirmations = createAppointmentConfirmations({
        ...require('../src/server/infrastructure/platform-constants.cjs'),
        ...f.database,
      });
      f.a.p.exec('BEGIN IMMEDIATE');
      try {
        confirmations.set(
          f.organizations[0],
          'patient',
          appointment,
          'Europe/Moscow',
          f.actors[0].accountId,
          true,
          Date.now(),
        );
        f.a.p.exec('COMMIT');
      } catch (e) {
        f.a.p.exec('ROLLBACK');
        throw e;
      }
      const display = await f.run(b, f.conditional(same.body));
      assert.equal(display.status, 200, JSON.stringify(display.body));
      assert.equal(display.body.unchanged, undefined);
      assert.equal(
        display.body.appointments.find((x) => x.id === appointment.id).manualConfirmedBy,
        'Synthetic owner',
      );
      const refreshed = await f.run(a, f.url);
      f.setAfterCommit(() =>
        f.a.p
          .prepare(
            "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
          )
          .run(f.organizations[0], f.actors[0].accountId),
      );
      const revoked = await f.run(a, f.conditional(refreshed.body));
      assert.ok([401, 403, 428].includes(revoked.status), JSON.stringify(revoked));
    } finally {
      await f.close();
    }
  },
);
