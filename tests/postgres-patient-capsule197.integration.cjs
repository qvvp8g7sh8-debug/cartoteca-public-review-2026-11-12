const test = require('node:test');
const assert = require('node:assert/strict');
const { patientCapsulePGFixture197 } = require('./helpers/postgres-patient-capsule197-fixture.cjs');
const { FUNCTION } = require('../src/server/infrastructure/postgres/patient-capsule-sql197.cjs');

test(
  '197 complete patient routes use one bounded RR capsule and retain canonical/notification/authority contracts',
  { timeout: 180000 },
  async (t) => {
    const f = await patientCapsulePGFixture197(t);
    try {
      await f.prepare({ capsule: false });
      const ordinary = await f.kernel(true),
        legacy = await f.kernel(false);
      const empty = '/api/cabinet/patient?id=empty&view=card';
      ordinary.trace.length = 0;
      const old = await f.response(ordinary, empty);
      assert.equal(old.status, 200);
      assert.equal(ordinary.trace.length, 10, 'baseline fixed same-RR patient route');
      await f.prepare();
      const native = await f.kernel(true);
      const capsuleCalls = (trace) =>
        trace.filter((sql) => sql.includes(FUNCTION.split('.').pop()));

      await t.test(
        'cold and repeated first-page reads both keep their own six-call RR/ACK/fresh-tail lifecycle',
        async () => {
          for (let i = 0; i < 2; i++) {
            native.trace.length = 0;
            const next = await f.response(native, empty);
            assert.equal(next.status, 200);
            assert.deepEqual(f.normalize(next.body), f.normalize(old.body));
            assert.equal(native.trace.length, 6);
            assert.equal(capsuleCalls(native.trace).length, 1);
            assert.equal(native.trace.filter((sql) => sql === 'COMMIT').length, 1);
          }
        },
      );

      await t.test(
        'owner/admin/staff and nonempty upcoming keep canonical DTO and fresh manual notification decoration',
        async () => {
          for (const actor of f.actors) {
            const path = '/api/cabinet/patient?id=live&view=card';
            const expected = await f.response(legacy, path, actor);
            native.trace.length = 0;
            const next = await f.response(native, path, actor);
            assert.equal(next.status, 200);
            assert.equal(capsuleCalls(native.trace).length, 1);
            assert.deepEqual(f.normalize(next.body), f.normalize(expected.body));
            assert.ok(next.body.upcoming.entries.length > 0);
            if (actor.role === 'owner') {
              assert.equal(next.body.upcoming.entries[0].manualConfirmedBy, 'Synthetic owner');
              assert.ok(next.body.upcoming.entries[0].confirmationKey);
            }
          }
          f.a.p.prepare('UPDATE accounts SET value=? WHERE id=?').run(
            f.database.seal({
              displayName: 'Synthetic changed owner',
              email: 'synthetic@invalid.test',
            }),
            f.actors[0].accountId,
          );
          const changed = await f.response(native, '/api/cabinet/patient?id=live&view=card');
          assert.equal(changed.status, 200);
          assert.equal(
            changed.body.upcoming.entries[0].manualConfirmedBy,
            'Synthetic changed owner',
          );
        },
      );

      await t.test(
        'history cursors preserve identity/mode/current-revision rejection',
        async () => {
          const first = await f.response(native, empty);
          assert.ok(first.body.history.nextCursor);
          const url =
            '/api/cabinet/patient/history?id=empty&cursor=' +
            encodeURIComponent(first.body.history.nextCursor);
          const next = await f.response(native, url);
          assert.equal(next.status, 200);
          assert.deepEqual(
            f.normalize(next.body),
            f.normalize((await f.response(legacy, url)).body),
          );
          const foreign = await f.response(native, url, f.actors[1]);
          assert.equal(foreign.status, 400);
          const wrongMode = await f.response(native, url.replace('/history?', '/upcoming?'));
          assert.equal(wrongMode.status, 400);
        },
      );

      await t.test(
        'plain point SAVE preview remains exact profile/appointment/revision with one capsule',
        async () => {
          const route =
            '/api/cabinet/patient?id=live&view=appointment&appointmentId=live-appointment-0';
          const expected = await f.response(legacy, route);
          native.trace.length = 0;
          const next = await f.response(native, route);
          assert.equal(next.status, 200);
          assert.deepEqual(next.body, expected.body);
          assert.equal(next.body.kind, 'appointment-edit-v1');
          assert.equal(native.trace.length, 6);
          assert.equal(capsuleCalls(native.trace).length, 1);
        },
      );

      await t.test(
        'current canonical bytes are re-proved even after a successful cached page',
        async () => {
          assert.equal((await f.response(native, empty)).status, 200);
          const record = f.a.c[0]
            .prepare("SELECT value FROM cabinet_patient_records WHERE kind='visit' AND id=?")
            .get('empty-visit-0');
          assert.ok(record);
          const value = f.storage.decode(record.value);
          try {
            f.a.c[0]
              .prepare("UPDATE cabinet_patient_records SET value=? WHERE kind='visit' AND id=?")
              .run(
                f.storage.encode({ ...value, procedure: 'Synthetic inconsistent record' }),
                'empty-visit-0',
              );
            const denied = await f.response(native, empty);
            assert.equal(denied.status, 503);
            assert.equal(denied.body.patient, undefined);
          } finally {
            f.a.c[0]
              .prepare("UPDATE cabinet_patient_records SET value=? WHERE kind='visit' AND id=?")
              .run(record.value, 'empty-visit-0');
          }
        },
      );

      await t.test(
        'post-COMMIT membership revoke prevents a clinical response and cache publication',
        async () => {
          const fresh = await f.kernel(true);
          f.setAfterCommit(() =>
            f.a.p
              .prepare(
                "UPDATE memberships SET status='revoked' WHERE organization_id=? AND account_id=?",
              )
              .run(f.actors[0].organizationId, f.actors[0].accountId),
          );
          try {
            const denied = await f.response(fresh, empty);
            assert.ok([401, 403].includes(denied.status));
            assert.equal(denied.body.patient, undefined);
            assert.equal(fresh.operations.viewStats().entries, 0);
          } finally {
            f.a.p
              .prepare(
                "UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?",
              )
              .run(f.actors[0].organizationId, f.actors[0].accountId);
          }
        },
      );

      await t.test(
        'lost COMMIT acknowledgement yields no body/cache and the next request executes fresh RR',
        async () => {
          const fresh = await f.kernel(true);
          f.setAfterCommit(() => {
            throw Error('Synthetic lost read COMMIT acknowledgement');
          });
          const failed = await f.response(fresh, empty);
          assert.ok([500, 503].includes(failed.status));
          assert.equal(failed.body.patient, undefined);
          assert.equal(fresh.operations.viewStats().entries, 0);
          fresh.trace.length = 0;
          const next = await f.response(fresh, empty);
          assert.equal(next.status, 200);
          assert.equal(capsuleCalls(fresh.trace).length, 1);
          assert.equal(fresh.operations.viewStats().entries, 1);
        },
      );

      await t.test(
        'oversized capsule declines before its cipher packet and keeps existing bounded legacy route',
        async () => {
          const whole = f.storage.read();
          const patient = whole.patients.find((row) => row.id === 'empty');
          const visitNotes = 'Synthetic '.repeat(800);
          patient.visits = patient.visits.map((visit) => ({ ...visit, notes: visitNotes }));
          f.storage.write(whole);
          const expected = await f.response(legacy, empty);
          native.trace.length = 0;
          const next = await f.response(native, empty);
          assert.equal(next.status, 200);
          assert.equal(next.body.patient.notes, patient.notes);
          const visits = next.body.history.entries.filter((entry) => entry.kind === 'visit');
          assert.ok(visits.length > 0);
          assert.ok(visits.every((entry) => entry.record.notes.length === visitNotes.length));
          assert.deepEqual(f.normalize(next.body), f.normalize(expected.body));
          assert.equal(capsuleCalls(native.trace).length, 1);
          assert.ok(native.trace.some((sql) => /WITH selected_entries AS MATERIALIZED/.test(sql)));
          assert.equal(
            native.trace.filter(
              (sql) =>
                /count\(\*\)::bigint rows/.test(sql) &&
                /"cartoteca_cabinet"\."(?:patients|cabinet_patient_records|cabinet_history_entries|cabinet_history_manifests)"/.test(
                  sql,
                ),
            ).length,
            0,
            'the declining capsule reuses its own current clinical bounds instead of rescanning the five sources',
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
