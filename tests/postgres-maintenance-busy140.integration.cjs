const test = require('node:test');
const assert = require('node:assert/strict');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const {
  createQueueMaintenance,
} = require('../src/server/modules/notifications/queue-maintenance.cjs');
const NOW = 1000000000,
  DAY = 86400000;
const owned = { canRun: () => true };

test(
  'actual PostgreSQL maintenance defers clean admission, preserves leases and retries its same cursor',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { components: { notificationMaintenance: true } });
    const { p } = f.a,
      sibling = await f.open();
    p.prepare('INSERT INTO notification_queue_maintenance_schema(id,version) VALUES(?,?)').run(
      1,
      1,
    );
    function legacy(work) {
      p.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        p.exec('COMMIT');
        return result;
      } catch (e) {
        if (p.isTransaction) p.exec('ROLLBACK');
        throw e;
      }
    }
    let callbacks = 0;
    function transaction(work, scope) {
      p.beginQueueOrganization(scope);
      try {
        callbacks++;
        const result = work();
        p.exec('COMMIT');
        return result;
      } catch (e) {
        if (p.isTransaction) p.exec('ROLLBACK');
        throw e;
      }
    }
    function entity(work, scope) {
      p.beginQueueEntity(scope);
      try {
        const result = work();
        p.exec('COMMIT');
        return result;
      } catch (e) {
        if (p.isTransaction) p.exec('ROLLBACK');
        throw e;
      }
    }
    const context = {
      db: p,
      notificationChannels: { enabled: () => true },
      organizationQueueTransaction: transaction,
      entityQueueTransaction: entity,
    };
    const runtime = createQueueMaintenance(context, {
      enabled: true,
      clock: () => NOW,
      monotonic: () => 0,
      rowLimit: 128,
    });
    t.after(() => runtime.stop());
    const row = (id) =>
      p
        .prepare(
          'SELECT id,organization_id,status,expires_at,lease_until,value FROM notification_channel_jobs WHERE id=?',
        )
        .get(id);
    function seed(id, organizationId, lease, status = 'reserved') {
      p.prepare(
        'INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        organizationId,
        'synthetic-patient',
        'synthetic-appointment-' + id,
        'synthetic-stamp',
        'telegram',
        'synthetic-callback-' + id,
        Buffer.from('synthetic-opaque-' + id),
        status,
        NOW,
        NOW + DAY,
        lease,
      );
    }
    await t.test(
      'held A stays byte-for-byte unchanged, B progresses, then the same runtime returns to A',
      async () => {
        legacy(() => {
          seed('held-a', f.organizations[0], NOW - 2);
          seed('writable-b', f.organizations[1], NOW - 1);
        });
        const beforeA = row('held-a'),
          beforeB = row('writable-b');
        sibling.p.beginQueueOrganization({
          queueDomain: 'client',
          organizationId: f.organizations[0],
        });
        try {
          await runtime.tick(owned);
          assert.equal(callbacks, 0, 'Failed BEGIN never invokes phase callback');
          assert.equal(runtime.stats().busyDeferrals, 1);
          assert.equal(runtime.stats().errors, 0);
          assert.equal(runtime.stats().busy, false);
          assert.equal(runtime.stats().lastFailure, null);
          assert.equal(p.isTransaction, false);
          assert.equal(sibling.p.isTransaction, true);
          assert.deepEqual(row('held-a'), beforeA);
          assert.deepEqual(row('writable-b'), beforeB);
          await runtime.tick(owned);
          assert.deepEqual(row('held-a'), beforeA);
          assert.equal(row('writable-b').status, 'pending');
          assert.equal(row('writable-b').lease_until, 0);
          assert.deepEqual(row('writable-b').value, beforeB.value);
        } finally {
          if (sibling.p.isTransaction) sibling.p.exec('ROLLBACK');
        }
        for (let n = 0; n < 3; n++) await runtime.tick(owned);
        assert.equal(row('held-a').status, 'pending');
        assert.equal(row('held-a').lease_until, 0);
        assert.deepEqual(row('held-a').value, beforeA.value);
        assert.equal(runtime.stats().busyDeferrals, 1);
        assert.equal(runtime.stats().errors, 0);
      },
    );
    await t.test(
      'actual SQL callback failure is fatal, rolls back and exposes only closed diagnostics',
      async () => {
        legacy(() => seed('trigger-fatal', f.organizations[0], NOW - 3));
        const before = row('trigger-fatal');
        await f.admin.query(
          "CREATE FUNCTION cartoteca_platform.synthetic_maintenance140_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic maintenance rollback'; RETURN NEW; END $$",
        );
        await f.admin.query(
          "CREATE TRIGGER synthetic_maintenance140_failure BEFORE UPDATE ON cartoteca_platform.notification_channel_jobs FOR EACH ROW WHEN (NEW.id='trigger-fatal' AND NEW.status='pending') EXECUTE FUNCTION cartoteca_platform.synthetic_maintenance140_failure()",
        );
        try {
          await assert.rejects(
            runtime.tick(owned),
            (e) => e && e.postgres === true && e.code === 'P0001',
          );
          assert.deepEqual(row('trigger-fatal'), before);
          assert.equal(p.isTransaction, false);
          assert.equal(runtime.stats().busyDeferrals, 1);
          assert.equal(runtime.stats().errors, 1);
          const failure = runtime.stats().lastFailure;
          assert.equal(failure.phase, 'callback');
          assert.equal(failure.callbackEntered, true);
          assert.equal(failure.code, 'UNCLASSIFIED');
          assert.equal(Object.hasOwn(failure, 'message'), false);
          assert.equal(Object.hasOwn(failure, 'stack'), false);
        } finally {
          await f.admin.query(
            'DROP TRIGGER synthetic_maintenance140_failure ON cartoteca_platform.notification_channel_jobs',
          );
          await f.admin.query(
            'DROP FUNCTION cartoteca_platform.synthetic_maintenance140_failure()',
          );
        }
        for (let n = 0; n < 3; n++) await runtime.tick(owned);
        assert.equal(row('trigger-fatal').status, 'pending');
        assert.equal(runtime.stats().errors, 1, 'Historical failure is retained after recovery');
      },
    );
    await t.test(
      'expired sending remains uncertain rather than being turned into a resend',
      async () => {
        legacy(() => seed('unknown-send', f.organizations[0], NOW, 'sending'));
        await runtime.tick(owned);
        assert.equal(row('unknown-send').status, 'uncertain');
        assert.equal(row('unknown-send').lease_until, 0);
        await runtime.tick(owned);
        assert.equal(row('unknown-send').status, 'uncertain');
        assert.equal(runtime.stats().errors, 1);
        assert.equal(p.isTransaction, false);
      },
    );
  },
);
