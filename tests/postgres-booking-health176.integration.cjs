const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  postgresBookingHealth176Fixture,
  BEFORE176,
  AFTER176,
} = require('./helpers/postgres-booking-health176-fixture.cjs');
const { privateBookingHealth } = require('../src/server/modules/booking/readiness.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const { readOperationStatus } = require('../src/server/infrastructure/mutation-receipts.cjs');

test(
  'health176 uses real encrypted tenants, physical SAVE and read-only publication state',
  { timeout: 120000 },
  async (t) => {
    const f = await postgresBookingHealth176Fixture(t);
    try {
      const { a, b } = f;
      await t.test(
        'unrelated SAVE retains COMPOUND while ordinary health finishes without writer conflict and commits one proof',
        async () => {
          const withoutLinks = f.snapshot(b);
          assert.deepEqual(withoutLinks.links, []);
          const expected = await privateBookingHealth(b.context, BEFORE176);
          const beforeB = f.snapshot(b);
          assert.deepEqual(
            beforeB.links.map((row) => row.staff_id).sort(),
            ['', b.actor.accountId].sort(),
          );
          assert.deepEqual(beforeB.organization, withoutLinks.organization);
          assert.deepEqual(beforeB.audit, withoutLinks.audit);
          assert.equal(expected.enabled, true);
          assert.match(expected.publication.path, /^\/b\/[a-z0-9]{8}$/);
          assert.ok(Object.keys(expected.publication.staffPaths).length);
          const before = a.storage.readSelected([a.actor.patientId]);
          const appointment = before.patients[0].appointments[0];
          const operation = randomUUID();
          a.context.req.headers['x-cartoteca-operation'] = operation;
          let response,
            written = 0,
            committed = 0;
          const saved = await saveMutation(
            a.context,
            {
              revision: before.revision,
              patientId: a.actor.patientId,
              changes: [
                {
                  id: appointment.id,
                  before: appointment,
                  after: { ...appointment, notes: 'Synthetic health176 SAVE' },
                },
              ],
            },
            {
              appointmentCommand: true,
              trustedCommit: {
                assert() {
                  assert.equal(a.database.db.transactionIntent, 'COMPOUND');
                },
                written() {
                  written++;
                  assert.equal(a.database.db.transactionIntent, 'COMPOUND');
                  response = privateBookingHealth(b.context, BEFORE176);
                  assert.equal(
                    typeof response?.then,
                    'undefined',
                    'stable health completes inside its read snapshot before this SAVE can finish',
                  );
                  assert.deepEqual(response, expected);
                },
                committed(storage) {
                  committed++;
                  assert.equal(storage, a.storage);
                  assert.equal(a.database.db.transactionIntent, 'COMPOUND');
                },
              },
            },
          );
          assert.equal(written, 1);
          assert.equal(committed, 1);
          assert.deepEqual(response, expected);
          assert.deepEqual(
            f.snapshot(b),
            beforeB,
            'unrelated health changed no publication, public link, audit or patient bytes',
          );
          assert.equal(
            a.storage.readSelected([a.actor.patientId]).patients[0].appointments[0].notes,
            'Synthetic health176 SAVE',
          );
          const proof = readOperationStatus(a.storage, a.context.current, operation);
          assert.equal(proof.status, 'committed');
          assert.equal(proof.revision, saved.revision);
          assert.equal(a.database.db.isTransaction, false);
          assert.equal(b.database.db.isTransaction, false);
        },
      );

      await t.test(
        'authority revoked after read snapshot denies a stale successful health result',
        async () => {
          const before = f.snapshot(b);
          const snapshot = b.platform.withReadOnlySnapshot;
          let revoked = false;
          b.platform.withReadOnlySnapshot = (read) => {
            const result = snapshot(read);
            if (!revoked) {
              revoked = true;
              a.database.transaction(() =>
                a.database.db
                  .prepare(
                    'UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?',
                  )
                  .run('suspended', b.actor.organizationId, b.actor.accountId),
              );
            }
            return result;
          };
          try {
            await assert.rejects(
              Promise.resolve().then(() => privateBookingHealth(b.context, BEFORE176)),
              { status: 403 },
            );
            assert.equal(revoked, true);
            assert.deepEqual(f.snapshot(b), before);
          } finally {
            b.platform.withReadOnlySnapshot = snapshot;
            await f.admin.query(
              "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
              [f.scope.storeId, b.actor.organizationId, b.actor.accountId],
            );
          }
        },
      );

      await t.test(
        'authority revoked while repair awaits admission cannot durably disable publication',
        async () => {
          const before = f.snapshot(b);
          const writer = b.platform.withAsyncWriteLock;
          let revoked = false;
          b.platform.withAsyncWriteLock = async (write, options) => {
            await f.admin.query(
              "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
              [f.scope.storeId, b.actor.organizationId, b.actor.accountId],
            );
            revoked = true;
            return writer(write, options);
          };
          try {
            await assert.rejects(
              Promise.resolve().then(() => privateBookingHealth(b.context, AFTER176)),
              { status: 403 },
            );
            assert.equal(revoked, true);
            assert.deepEqual(
              f.snapshot(b),
              before,
              'revocation preserved publication, links, audit, admin projection and cabinet bytes',
            );
          } finally {
            b.platform.withAsyncWriteLock = writer;
            await f.admin.query(
              "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
              [f.scope.storeId, b.actor.organizationId, b.actor.accountId],
            );
          }
        },
      );

      await t.test(
        'expiry GET commits auto-off and admin projection once; restoring graph before a background tick still requires manual activation',
        async () => {
          const count = () =>
            Number(
              b.database.db
                .prepare(
                  'SELECT count(*) AS n FROM platform_audit WHERE organization_id=? AND event=?',
                )
                .get(b.actor.organizationId, 'booking_publication_disabled_no_working_days').n,
            );
          const prior = count();
          const before = f.snapshot(b);
          const expired = await privateBookingHealth(b.context, AFTER176);
          assert.equal(expired.enabled, false);
          assert.deepEqual(
            expired.issues.map((v) => v.code),
            ['no_working_days'],
          );
          assert.equal(
            b.platform.organization(b.actor.organizationId).bookingPublication.enabled,
            false,
          );
          assert.equal(count(), prior + 1);
          const after = f.snapshot(b);
          assert.deepEqual(
            after.adminSource.source_value,
            after.organization.value,
            'actual audit observer retained the source projection',
          );
          assert.deepEqual(
            after.adminTerms,
            before.adminTerms,
            'publication changes no organization search terms',
          );
          assert.equal(after.adminVersion.revision, (before.adminVersion?.revision || 0) + 1);
          assert.equal((await privateBookingHealth(b.context, AFTER176)).enabled, false);
          assert.deepEqual(f.snapshot(b), after);
          b.platform.workSchedules.save(
            b.actor.token,
            {
              staffId: b.actor.accountId,
              dates: ['2040-01-02'],
              status: 'working',
              intervals: [['09:00', '10:00']],
              revision: 1,
              expectedTimeZone: 'Europe/Moscow',
            },
            b.storage,
          );
          const restored = await privateBookingHealth(b.context, AFTER176);
          assert.equal(restored.enabled, false);
          assert.deepEqual(
            restored.issues.map((v) => v.code),
            ['awaiting_activation'],
          );
          assert.equal(count(), prior + 1);
          b.platform.bookingPublication.save(b.actor.token, {
            enabled: true,
            revision: restored.publication.revision,
          });
          assert.equal((await privateBookingHealth(b.context, AFTER176)).enabled, true);
          assert.equal(count(), prior + 1);
        },
      );

      await t.test(
        'freshly revoked authority never reuses a prior permitted response or changes publication rows',
        async () => {
          assert.equal((await privateBookingHealth(b.context, BEFORE176)).canManage, true);
          const before = f.snapshot(b);
          await f.admin.query(
            "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
            [f.scope.storeId, b.actor.organizationId, b.actor.accountId],
          );
          try {
            await assert.rejects(
              Promise.resolve().then(() => privateBookingHealth(b.context, BEFORE176)),
              { status: 403 },
            );
            assert.deepEqual(f.snapshot(b), before);
          } finally {
            await f.admin.query(
              "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
              [f.scope.storeId, b.actor.organizationId, b.actor.accountId],
            );
          }
          assert.equal((await privateBookingHealth(b.context, BEFORE176)).canManage, true);
        },
      );
    } finally {
      await f.close();
    }
  },
);
