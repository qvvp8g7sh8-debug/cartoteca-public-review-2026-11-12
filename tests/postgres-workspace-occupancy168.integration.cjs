// Proposal only; requires actual synthetic PG execution by root before acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHmac } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { createStorage } = require('../storage.cjs');
const {
  createCabinetIndexReads,
} = require('../src/server/infrastructure/cabinet-index-reads145.cjs');
const { createWorkspace } = require('../src/server/modules/workspace/service.cjs');

test(
  'actual PG protected-room validation reads occupancy without unrelated active summaries',
  { timeout: 180000 },
  async (t) => {
    const f = await queueFixture(t),
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-occupancy168-')),
      syntheticKey = randomBytes(32);
    let storage;
    try {
      fs.writeFileSync(
        path.join(dir, 'postgresql-runtime.json'),
        JSON.stringify(f.identity.lineage),
        { flag: 'wx' },
      );
      fs.writeFileSync(path.join(dir, 'encryption.key'), syntheticKey, { flag: 'wx', mode: 0o600 });
      storage = createStorage(dir, {
        cabinetSchema: 2,
        databaseOwner: f.a.owner,
        databaseRoot: dir,
        photoOrganizationId: f.organizations[0],
      });
      const appointment = (id, date, time, staffId = 'two') => ({
        id,
        date,
        time,
        staffId,
        roomId: 'r1',
        duration: 30,
        status: 'scheduled',
        service: 'Synthetic occupancy',
      });
      const nextAppointment = appointment('changed-a', '2035-01-02', '14:00', 'one');
      const neighbors = Array.from({ length: 4 }, (_, n) => ({
        id: 'neighbor-' + n,
        name: 'Synthetic Neighbor ' + n,
        phone: 'Synthetic Phone ' + n,
        createdBy: 'two',
        visits: [],
        appointments: [
          appointment('focus-' + n, '2035-01-02', String(10 + n) + ':00'),
          ...Array.from({ length: 120 }, (_, i) => {
            const date = new Date(Date.UTC(2035, 0, 5 + i)).toISOString().slice(0, 10);
            return appointment('off-window-' + n + '-' + i, date, String(10 + n) + ':00');
          }),
        ],
      }));
      storage.write({
        revision: 0,
        services: [],
        patients: [
          {
            id: 'changed',
            name: 'Synthetic Changed',
            createdBy: 'one',
            visits: [],
            appointments: [nextAppointment],
          },
          ...neighbors,
        ],
      });
      const workspace = createWorkspace({
        organization: () => ({
          workspace: {
            revision: 0,
            enabled: true,
            staffRules: [{ staffId: 'one', preventOverlap: true }],
            rooms: [
              {
                id: 'r1',
                name: 'Synthetic Room',
                active: true,
                staffIds: ['one', 'two'],
                preventOverlap: true,
              },
            ],
          },
        }),
        organizationTimeZone: () => 'Europe/Moscow',
      });
      const identities = [
        { accountId: 'one', role: 'owner', status: 'active' },
        { accountId: 'two', role: 'cosmetologist', status: 'active' },
      ];
      function run(legacy, next) {
        const metrics = {
          sqlReads: 0,
          summaryReads: 0,
          summaryCipherBytes: 0,
          appointmentCipherBytes: 0,
          decoded: 0,
        };
        const reads = createCabinetIndexReads({
          db: storage.db,
          hash: (value) => createHmac('sha256', syntheticKey).update(value).digest('hex'),
          decode(value) {
            metrics.decoded++;
            return storage.decode(value);
          },
          prepare(sql) {
            const statement = storage.db.prepare(sql);
            return {
              all(...args) {
                const rows = statement.all(...args),
                  summary = /FROM cabinet_summaries/.test(sql);
                metrics.sqlReads++;
                if (summary) metrics.summaryReads++;
                for (const row of rows)
                  metrics[summary ? 'summaryCipherBytes' : 'appointmentCipherBytes'] +=
                    row.value.byteLength;
                return rows;
              },
            };
          },
        });
        let outcome;
        try {
          storage.readOnlySnapshot(() =>
            workspace.assertWorkspaceSelection(
              f.organizations[0],
              { patients: [{ id: 'changed', appointments: [next] }] },
              {
                indexes: {
                  appointmentOccupancy: legacy ? reads.appointments : reads.appointmentOccupancy,
                },
              },
              identities,
            ),
          );
          outcome = { status: 200 };
        } catch (error) {
          outcome = { status: error.status, message: error.message };
        }
        return { metrics, outcome };
      }
      const evidence = [];
      for (const [label, next, expected] of [
        ['allowed', nextAppointment, 200],
        ['room conflict', { ...nextAppointment, time: '10:15' }, 409],
      ]) {
        const before = run(true, next),
          after = run(false, next);
        assert.deepEqual(after.outcome, before.outcome, label);
        assert.equal(after.outcome.status, expected, label);
        assert.ok(before.metrics.summaryCipherBytes > 0);
        assert.equal(after.metrics.summaryCipherBytes, 0);
        assert.equal(after.metrics.summaryReads, 0);
        assert.equal(after.metrics.appointmentCipherBytes, before.metrics.appointmentCipherBytes);
        assert.ok(before.metrics.summaryCipherBytes > after.metrics.appointmentCipherBytes * 10);
        assert.ok(after.metrics.decoded < before.metrics.decoded);
        assert.equal(before.metrics.sqlReads - after.metrics.sqlReads, 1);
        evidence.push({ label, before: before.metrics, after: after.metrics });
      }
      const canonical = storage.db
        .prepare('SELECT patient_id,value FROM cabinet_appointments')
        .all();
      assert.ok(canonical.every((row) => storage.decode(row.value).patientId === row.patient_id));
      t.diagnostic(
        '168 returned ciphertext bytes, not full wire framing: ' + JSON.stringify(evidence),
      );
    } finally {
      storage?.close();
      assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
      assert.match(path.basename(dir), /^cartoteca-occupancy168-/);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
