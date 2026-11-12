const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { Client } = require('pg');
const { calendarFixture163 } = require('./helpers/postgres-calendar163-fixture.cjs');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const {
  directoryQuery164,
  directorySources164,
} = require('../src/server/infrastructure/postgres/directory-queries164.cjs');
const { sourceProbe } = require('../src/server/infrastructure/postgres/read-source-probe152.cjs');
const {
  prepareDirectory164,
} = require('../src/server/infrastructure/postgres/directory-component164.cjs');
const {
  projectionKey,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  createAppointmentMutation,
} = require('../src/server/modules/cabinet/appointment-commands.cjs');

test(
  '164 directory reads only compact cohort plus selected summaries, keeps DTO/ACL and observes raw DML and both writers',
  { timeout: 180000 },
  async (t) => {
    const observations = [];
    const original = Client.prototype.query;
    t.mock.method(Client.prototype, 'query', function (input, ...args) {
      const text = typeof input === 'string' ? input : input.text;
      let kind = null;
      if (text.startsWith('SELECT s.patient_id AS id,s.audience,CASE')) kind = 'compact';
      if (text.startsWith('SELECT patient_id AS id,value FROM cartoteca_cabinet.cabinet_summaries'))
        kind = 'full';
      if (kind && typeof input.on === 'function') {
        const entry = {
          kind,
          rows: 0,
          bytes: 0,
          rawRows: 0,
          rawBytes: 0,
          ids: kind === 'full' ? input.values[2].length : 0,
        };
        observations.push(entry);
        input.on('row', (row) => {
          if (kind === 'compact' && row[2] === 'meta') return;
          const bytes = Buffer.isBuffer(row[kind === 'full' ? 1 : 3])
            ? row[kind === 'full' ? 1 : 3].length
            : 0;
          entry.rows++;
          entry.bytes += bytes;
          if (kind === 'compact' && row[2] === 'raw') {
            entry.rawRows++;
            entry.rawBytes += bytes;
          }
        });
      }
      return original.call(this, input, ...args);
    });
    const f = await calendarFixture163(t);
    let fresh;
    try {
      const owner = f.actors[0],
        staff = f.actors[1],
        admin = f.actors[2],
        base = f.storage.read().patients[0];
      const huge = {
        id: 'huge',
        name: 'Яна Большая',
        firstName: 'Яна',
        lastName: 'Большая',
        phone: '89001112233',
        createdBy: owner.accountId,
        visits: [],
        appointments: Array.from({ length: 520 }, (_, i) => ({
          id: 'large-' + i,
          date: '2035-01-02',
          time: '10:00',
          duration: 60,
          staffId: owner.accountId,
          service: 'PRIVATE APPOINTMENT '.repeat(70),
        })),
      };
      const other = {
        id: 'other',
        name: 'Юлия Сергеевна Яковлева',
        firstName: 'Юлия',
        lastName: 'Яковлева',
        middleName: 'Сергеевна',
        phone: '+7 (900) 123-45-67',
        createdBy: owner.accountId,
        visits: [],
        appointments: [],
      };
      const phone = {
        id: 'phone',
        name: '',
        phone: '+374 99 123456',
        createdBy: staff.accountId,
        visits: [],
        appointments: [],
      };
      f.storage.write({
        revision: f.storage.get('revision'),
        patients: [base, huge, other, phone],
        services: [],
      });
      const key = fs.readFileSync(path.join(f.dir, 'encryption.key'));
      const ciphers = {
        encode: f.storage.encode,
        decode: f.storage.decode,
        hash: (value) => createHmac('sha256', key).update(value).digest('hex'),
      };
      await f.admin.query('BEGIN');
      const prepared = await prepareDirectory164(f.admin, f.runtime.application.user, {
        stores: [{ storeId: f.cabinets[0].storeId, ciphers }],
      });
      await f.admin.query('COMMIT');
      assert.ok(prepared.summaries >= 4);
      const n = await f.kernel(),
        legacy = await f.kernel(false);
      const url = (params) =>
        '/api/cabinet/directory?today=2035-01-03&' + new URLSearchParams(params);
      const normalize = (reply) => ({
        ...reply.body,
        nextCursor: reply.body.nextCursor
          ? f.storage.decode(Buffer.from(reply.body.nextCursor, 'base64url'))
          : null,
      });
      const totalBytes = Number(
        (
          await f.admin.query(
            "SELECT sum(octet_length(value))::text n FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND audience='*'",
            [f.cabinets[0].storeId],
          )
        ).rows[0].n,
      );
      observations.length = 0;
      const picker = await f.run(n, url({ picker: '1' }));
      assert.equal(picker.status, 200, JSON.stringify(picker.body));
      assert.equal(picker.body.patients.length, 4);
      const compact = observations.filter((row) => row.kind === 'compact');
      assert.equal(compact.length, 1);
      assert.equal(compact[0].rows, 4);
      assert.equal(compact[0].rawRows, 0);
      assert.ok(
        compact[0].bytes < totalBytes / 20,
        JSON.stringify({ compact: compact[0], totalBytes }),
      );
      assert.equal(observations.filter((row) => row.kind === 'full').length, 0);
      const compactBytes = compact[0].bytes;
      observations.length = 0;
      const page = await f.run(n, url({ limit: '1' }));
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.body.directory.length, 1);
      const selected = observations.filter((row) => row.kind === 'full');
      assert.equal(selected.length, 1);
      assert.equal(selected[0].ids, 1);
      assert.equal(selected[0].rows, 1);
      assert.ok(selected[0].bytes < totalBytes / 20);
      for (const actor of [owner, staff, admin])
        for (const params of [
          { limit: '1', sort: 'first' },
          { limit: '2', sort: 'last', q: 'яков' },
          { limit: '2', q: '+7 (900) 123-45-67' },
          { limit: '2', filter: 'recent' },
          { limit: '2', filter: 'inactive' },
          { limit: '2', filter: 'appointment' },
        ]) {
          const before = await f.run(legacy, url(params), actor),
            after = await f.run(n, url(params), actor);
          assert.equal(after.status, 200, JSON.stringify(after.body));
          assert.equal(before.status, 200, JSON.stringify(before.body));
          assert.deepEqual(normalize(after), normalize(before));
        }
      const cursor = page.body.nextCursor;
      assert.ok(cursor);
      const continued = await f.run(n, url({ limit: '1', cursor })),
        expected = await f.run(legacy, url({ limit: '1', cursor }));
      assert.equal(continued.status, 200);
      assert.deepEqual(normalize(continued), normalize(expected));
      const source = f.storage.db
        .prepare("SELECT value FROM cabinet_summaries WHERE patient_id='other' AND audience='*'")
        .get().value;
      const changed = { ...f.storage.decode(source), visitCount: 123 };
      const changedCipher = f.storage.encode(changed);
      f.storage.db
        .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id='other' AND audience='*'")
        .run(changedCipher);
      observations.length = 0;
      const raw = await f.run(n, url({ picker: '1' }));
      assert.equal(raw.status, 200, JSON.stringify(raw.body));
      const missing = observations.filter((row) => row.kind === 'compact');
      assert.equal(missing.length, 1);
      assert.equal(missing[0].rawRows, 1);
      assert.equal(missing[0].rawBytes, changedCipher.length);
      const rawPage = await f.run(n, url({ q: 'яков', limit: '1' }));
      assert.equal(rawPage.body.directory[0].visitCount, 123);
      f.storage.db.exec('BEGIN IMMEDIATE');
      f.storage.db
        .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id='other' AND audience='*'")
        .run(f.storage.encode({ ...changed, visitCount: 999 }));
      f.storage.db.exec('ROLLBACK');
      assert.equal(
        (await f.run(n, url({ q: 'яков', limit: '1' }))).body.directory[0].visitCount,
        123,
      );
      f.storage.db
        .prepare("DELETE FROM cabinet_summaries WHERE patient_id='other' AND audience='*'")
        .run();
      assert.equal((await f.run(n, url({ q: 'яков', limit: '1' }))).body.matched, 0);
      f.storage.db
        .prepare('INSERT INTO cabinet_summaries(patient_id,audience,value)VALUES(?,?,?)')
        .run('other', '*', source);
      const opened = await f.open();
      fresh = createStorage(f.dir, {
        cabinetSchema: 2,
        databaseOwner: opened.owner,
        databaseRoot: f.dir,
        photoOrganizationId: owner.organizationId,
      });
      assert.equal(fresh.indexes.directoryProjection164.ready, true);
      const current = fresh.readSelected(['patient']).patients[0];
      current.phone = '+79005556677';
      fresh.write(
        { revision: fresh.get('revision'), patients: [current], services: [] },
        { changedIds: { patients: ['patient'], services: [] } },
      );
      const sidecar = () =>
        fresh.db.prepare('SELECT value FROM meta WHERE key=?').get(projectionKey('patient', '*'))
          ?.value;
      assert.ok(sidecar(), 'ordinary full writer recreates sidecar in same TX');
      const command = createAppointmentMutation({
        revision: fresh.get('revision'),
        patientId: 'patient',
        changes: [
          {
            id: current.appointments[0].id,
            before: current.appointments[0],
            after: { ...current.appointments[0], notes: 'Synthetic164 point' },
          },
        ],
      });
      fresh.transaction(() => {
        const before = fresh.readAppointmentMutation(command.appointmentRead, owner);
        assert.ok(before);
        command.acceptCompact(before);
        fresh.write(command.build(owner, before), {
          insideTransaction: true,
          changedIds: command.changedIds,
          preparedBefore: before,
          appointmentOnly: true,
        });
      });
      const finalSummary = fresh.db
        .prepare("SELECT value FROM cabinet_summaries WHERE patient_id='patient' AND audience='*'")
        .get().value;
      assert.ok(sidecar(), 'point writer recreates sidecar in same TX');
      assert.equal(ciphers.decode(sidecar()).sourceHash, ciphers.hash(finalSummary));
      const afterWrite = await f.run(n, url({ q: '79005556677', limit: '1' }));
      assert.equal(afterWrite.status, 200, JSON.stringify(afterWrite.body));
      assert.equal(afterWrite.body.matched, 1);
      const ready = fresh.db
        .prepare('SELECT value FROM meta WHERE key=?')
        .get('directory164-ready').value;
      fresh.db
        .prepare('UPDATE meta SET value=? WHERE key=?')
        .run(fresh.encode(false), 'directory164-ready');
      const corrupted = await f.run(n, url({ picker: '1' }));
      assert.equal(corrupted.status, 503, JSON.stringify(corrupted.body));
      fresh.db.prepare('UPDATE meta SET value=? WHERE key=?').run(ready, 'directory164-ready');
      assert.equal((await f.run(n, url({ picker: '1' }))).status, 200);
      t.diagnostic(
        JSON.stringify({
          sourceOwnerSummaryCipherBytes: totalBytes,
          compactOwnerCipherBytes: compactBytes,
          cohortRows: 4,
          largestPatientAppointments: 520,
          coldPickerFullSummaryRows: 0,
          pageFullSummaryRows: 1,
          dirtyFallbackRows: 1,
          dirtyFallbackCipherBytes: changedCipher.length,
        }),
      );
    } finally {
      fresh?.close();
      await f.close();
    }
  },
);

test(
  '164 directory point lookups preserve large-cohort source bounds, raw fallback, audiences and RLS',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 2 });
    const client = new Client(f.runtime.application);
    const scope = f.cabinets[0],
      other = f.cabinets[1],
      staff = 'a'.repeat(64),
      full = Buffer.from('synthetic full summary'),
      compact = Buffer.from('synthetic compact projection');
    await client.connect();
    try {
      await f.admin.query(
        `INSERT INTO cartoteca_cabinet.cabinet_summaries(_store_id,patient_id,audience,value)
         SELECT $1,'entry-'||i,a.audience,$3::bytea FROM generate_series(1,1250) i
         CROSS JOIN unnest($2::text[]) a(audience)`,
        [scope.storeId, ['*', staff], full],
      );
      await f.admin.query(
        `INSERT INTO cartoteca_cabinet.meta(_store_id,key,value)
         SELECT _store_id,'directory164:'||encode(sha256(convert_to(patient_id,'UTF8')),'hex')||':'||audience,$2::bytea
         FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1`,
        [scope.storeId, compact],
      );
      await f.admin.query(
        `INSERT INTO cartoteca_cabinet.meta(_store_id,key,value)
         SELECT $1,k,$3::bytea FROM unnest($2::text[]) k`,
        [scope.storeId, ['directory164-ready', 'revision', 'initialized', 'unrelated'], compact],
      );
      await f.admin.query(
        'INSERT INTO cartoteca_cabinet.cabinet_summaries(_store_id,patient_id,audience,value)VALUES($1,$2,$3,$4)',
        [scope.storeId, 'raw-only', '*', full],
      );
      for (const [storeId, audience] of [
        [other.storeId, '*'],
        [scope.storeId, staff],
      ])
        await f.admin.query(
          'INSERT INTO cartoteca_cabinet.meta(_store_id,key,value)VALUES($1,$2,$3)',
          [storeId, projectionKey('raw-only', audience), Buffer.from('synthetic other scope')],
        );
      await assert.rejects(
        f.admin.query('INSERT INTO cartoteca_cabinet.meta(_store_id,key,value)VALUES($1,NULL,$2)', [
          scope.storeId,
          compact,
        ]),
        { code: '23502' },
      );
      const operation = { scope, cabinetCatalog: f.cabinetCatalog };
      const rawSource = directorySources164(operation, '*')[1];
      const probe = sourceProbe(rawSource, 0, 0, { witness: true });
      const index = directoryQuery164(scope, 'index', { audience: '*' });
      const selectScope = (storeId) =>
        client.query(
          "SELECT set_config('cartoteca.kind','cabinet',true),set_config('cartoteca.store_id',$1,true)",
          [storeId],
        );
      await client.query('BEGIN READ ONLY');
      await selectScope(scope.storeId);
      const measured = (await client.query(probe, [scope.storeId, '*'])).rows[0];
      assert.equal(Number(measured.rows), 1);
      assert.equal(
        Number(measured.bytes),
        64 + 2 * Buffer.byteLength('raw-only') + 2 * Buffer.byteLength('*') + full.byteLength,
      );
      assert.match(measured.witness, /^[a-f0-9]{64}$/);
      const rows = (await client.query(index.text, index.values)).rows;
      assert.equal(rows.filter((row) => row.kind === 'projection').length, 1250);
      assert.ok(
        rows.filter((row) => row.kind === 'projection').every((row) => row.value.equals(compact)),
      );
      const raw = rows.filter((row) => row.kind === 'raw');
      assert.equal(raw.length, 1);
      assert.equal(raw[0].id, 'raw-only');
      assert.deepEqual(raw[0].value, full);
      const staffIndex = directoryQuery164(scope, 'index', { audience: staff });
      const staffRows = (await client.query(staffIndex.text, staffIndex.values)).rows;
      assert.equal(staffRows.filter((row) => row.kind === 'projection').length, 1250);
      assert.equal(staffRows.filter((row) => row.kind === 'raw').length, 0);
      await selectScope(other.storeId);
      assert.equal((await client.query(index.text, index.values)).rows.length, 0);
      assert.equal(Number((await client.query(probe, [scope.storeId, '*'])).rows[0].rows), 0);
      await client.query('COMMIT');
      await f.admin.query('DELETE FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key=$2', [
        scope.storeId,
        'directory164-ready',
      ]);
      await client.query('BEGIN READ ONLY');
      await selectScope(scope.storeId);
      assert.ok(
        (await client.query(index.text, index.values)).rows.every((row) => row.kind === 'meta'),
      );
      assert.equal(Number((await client.query(probe, [scope.storeId, '*'])).rows[0].rows), 0);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  },
);
