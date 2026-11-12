const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { createReadVersion } = require('../src/server/infrastructure/read-version.cjs');

test(
  'actual PostgreSQL READ140 keeps canonical projections and fixed MVCC lifetimes',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 2 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-query140-'));
    const stores = [],
      measurements = {};
    t.after(() => {
      for (const storage of stores) storage.close();
      if (
        path.dirname(root) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith('cartoteca-query140-')
      )
        throw Error('Unexpected synthetic query140 assets.');
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(
      path.join(root, 'postgresql-runtime.json'),
      JSON.stringify(f.identity.lineage),
      { flag: 'wx' },
    );
    fs.writeFileSync(path.join(root, 'encryption.key'), randomBytes(32), { flag: 'wx' });
    const openStorage = (owner, observeOpen) => {
      const storage = createStorage(root, {
        cabinetSchema: 2,
        databaseOwner: owner,
        databaseRoot: root,
        photoOrganizationId: f.organizations[0],
        observeOpen,
      });
      stores.push(storage);
      return storage;
    };
    const storage = openStorage(f.a.owner);
    const appointment = (id, status) => ({
      id,
      date: '2035-01-02',
      time: '10:00',
      duration: 30,
      service: 'Synthetic',
      staffId: 'owner',
      ...(status ? { status } : {}),
      appointmentServices: [{ id: 'service', name: 'Synthetic service', duration: 30, price: 100 }],
    });
    const patient = (id, withAppointments = true) => ({
      id,
      name: 'Synthetic ' + id,
      notes: 'Synthetic profile',
      createdBy: 'owner',
      visits: Array.from({ length: 200 }, (_, n) => ({
        id: id + '-v' + n,
        date: '2020-01-01',
        procedure: 'x'.repeat(1024),
        photos: [],
      })),
      appointments: withAppointments
        ? [appointment(id + '-a'), appointment(id + '-b', 'cancelled')]
        : [],
    });
    storage.write({ revision: 0, patients: [patient('one'), patient('two', false)], services: [] });

    await t.test(
      'one READONLY root reuses exactly one snapshot RPC; unframed and write intents never reuse it',
      async () => {
        const p = f.a.p,
          c = storage.db,
          read = createReadVersion(p);
        p.exec('BEGIN READONLY');
        const at = f.a.owner.stats().calls,
          version = read();
        for (let n = 0; n < 100; n++) assert.deepEqual(read(), version);
        assert.equal(f.a.owner.stats().calls - at, 1);
        const b = await f.open();
        b.p
          .prepare('INSERT INTO telegram_runtime(key,value) VALUES(?,?)')
          .run('query140-concurrent', Buffer.from('synthetic'));
        assert.deepEqual(read(), version);
        c.exec('BEGIN READONLY');
        assert.equal(
          c.snapshotVersion(),
          version[1],
          'nested cabinet shares the owning physical snapshot',
        );
        c.exec('ROLLBACK');
        const afterRollback = f.a.owner.stats().calls;
        assert.equal(read()[1], version[1]);
        assert.equal(
          f.a.owner.stats().calls - afterRollback,
          1,
          'nested rollback invalidates the local memo',
        );
        p.exec('COMMIT');
        assert.notEqual(
          read()[1],
          version[1],
          'next physical snapshot observes the concurrent commit',
        );
        const outside = f.a.owner.stats().calls;
        read();
        read();
        assert.equal(f.a.owner.stats().calls - outside, 2);
        p.exec('BEGIN IMMEDIATE');
        const before = read(),
          writing = f.a.owner.stats().calls;
        read();
        read();
        assert.equal(
          f.a.owner.stats().calls - writing,
          2,
          'READ COMMITTED writer cannot reuse a token',
        );
        p.prepare('INSERT INTO telegram_runtime(key,value) VALUES(?,?)').run(
          'query140-own',
          Buffer.from('synthetic'),
        );
        assert.ok(read()[2] > before[2]);
        p.exec('ROLLBACK');
        assert.equal(
          p.prepare('SELECT value FROM telegram_runtime WHERE key=?').get('query140-own'),
          undefined,
        );
        measurements.snapshot = {
          repeatedReads: 101,
          priorRpcCalls: 101,
          currentRpcCalls: 1,
          owningReadOnlyRoot: true,
        };
      },
    );

    await t.test(
      'canonical appointment batch retains order/status/duplicates and avoids profile and visit materialization',
      async () => {
        const ids = ['two', 'absent', 'one', 'one'];
        const at = f.a.owner.stats().calls,
          started = performance.now();
        const full = storage
          .readSelected(ids)
          .patients.map(({ id, appointments }) => ({ id, appointments }));
        const fullMs = performance.now() - started,
          fullCalls = f.a.owner.stats().calls - at;
        const narrowAt = f.a.owner.stats().calls,
          narrowStarted = performance.now();
        const selected = storage.readSelectedAppointments(ids);
        const narrowMs = performance.now() - narrowStarted,
          narrowCalls = f.a.owner.stats().calls - narrowAt;
        assert.deepEqual(selected, full);
        assert.deepEqual(
          selected.map((p) => p.id),
          ['two', 'one', 'one'],
        );
        assert.equal(selected[1].appointments[1].status, 'cancelled');
        selected[1].appointments[0].duration = 5;
        assert.equal(selected[2].appointments[0].duration, 30);
        assert.deepEqual(storage.readSelectedAppointments(['foreign']), []);
        const bytes = (
          await f.admin.query(
            "SELECT coalesce(sum(octet_length(value)),0)::text AS full, coalesce(sum(octet_length(value))FILTER(WHERE kind='appointment'),0)::text AS narrow FROM cartoteca_cabinet.cabinet_patient_records WHERE _store_id=$1",
            [f.cabinets[0].storeId],
          )
        ).rows[0];
        assert.ok(Number(bytes.full) > Number(bytes.narrow) * 100);
        measurements.canonicalProjection = {
          fullRpcCalls: fullCalls,
          narrowRpcCalls: narrowCalls,
          fullMs,
          narrowMs,
          canonicalRecordCiphertextBytes: Number(bytes.full),
          appointmentCiphertextBytes: Number(bytes.narrow),
          exactProjectionEqual: true,
          timingsAreOneSyntheticObservation: true,
        };
        const b = await f.open(),
          other = openStorage(b.owner);
        storage.readOnlySnapshot(() => {
          const before = storage.readSelectedAppointments(['one']);
          const edit = other.readSelected(['one']);
          edit.patients[0].appointments[0].time = '11:00';
          other.write(edit, { changedIds: { patients: ['one'], services: [] } });
          assert.deepEqual(storage.readSelectedAppointments(['one']), before);
        });
        assert.equal(storage.readSelectedAppointments(['one'])[0].appointments[0].time, '11:00');
      },
    );

    await t.test(
      'malformed canonical ordering fails closed while unrelated profile/history are never decoded',
      () => {
        storage.db
          .prepare("UPDATE cabinet_patient_records SET value=? WHERE kind='visit'")
          .run(Buffer.from('corrupt synthetic history'));
        storage.db
          .prepare('UPDATE patients SET value=? WHERE id=?')
          .run(Buffer.from('corrupt synthetic profile'), 'one');
        assert.equal(storage.readSelectedAppointments(['one'])[0].appointments.length, 2);
        assert.throws(() => storage.readSelected(['one']));
        storage.db
          .prepare(
            "UPDATE cabinet_patient_records SET position=5 WHERE kind='appointment' AND id=?",
          )
          .run('one-b');
        assert.throws(
          () => storage.readSelectedAppointments(['one']),
          /Invalid cabinet record order/,
        );
        storage.db
          .prepare(
            "UPDATE cabinet_patient_records SET position=1 WHERE kind='appointment' AND id=?",
          )
          .run('one-b');
        storage.db
          .prepare("UPDATE cabinet_patient_records SET value=? WHERE kind='appointment' AND id=?")
          .run(storage.encode(appointment('wrong-id')), 'one-b');
        assert.throws(
          () => storage.readSelectedAppointments(['one']),
          /Invalid canonical cabinet record/,
        );
      },
    );

    await t.test(
      'cold prepared open emits phase observations and skips an absent legacy metadata probe',
      () => {
        const phases = [],
          before = f.a.owner.stats().calls;
        const cold = openStorage(f.a.owner, (name, milliseconds, failed) =>
          phases.push({ name, milliseconds, failed }),
        );
        const calls = f.a.owner.stats().calls - before;
        assert.equal(calls, 2, 'fresh inspect plus schema2 LIMIT0; no migrated metadata SELECT');
        assert.deepEqual(
          phases.map((p) => p.name),
          ['key', 'configuration', 'schema', 'indexes'],
        );
        assert.ok(phases.every((p) => p.failed === false && Number.isFinite(p.milliseconds)));
        const probe = f.a.owner.stats().calls;
        cold.get('migrated');
        assert.equal(
          f.a.owner.stats().calls - probe,
          1,
          'historical unconditional probe was one extra RPC per cold tenant',
        );
        measurements.coldPreparedOpen = {
          currentRpcCalls: calls,
          priorRpcCalls: calls + 1,
          phaseNames: phases.map((p) => p.name),
        };
      },
    );
    t.diagnostic('READ140 measurements ' + JSON.stringify(measurements));
  },
);

test(
  'actual PostgreSQL legacy empty appointment selection uses no RPC and aborted readonly snapshots fail closed',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-query140-legacy-pg-'));
    let storage;
    t.after(() => {
      storage?.close();
      if (
        path.dirname(root) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith('cartoteca-query140-legacy-pg-')
      )
        throw Error('Unexpected legacy synthetic assets.');
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(
      path.join(root, 'postgresql-runtime.json'),
      JSON.stringify(f.identity.lineage),
      { flag: 'wx' },
    );
    fs.writeFileSync(path.join(root, 'encryption.key'), randomBytes(32), { flag: 'wx' });
    storage = createStorage(root, {
      cabinetSchema: 1,
      databaseOwner: f.a.owner,
      databaseRoot: root,
      photoOrganizationId: f.organizations[0],
    });
    storage.write({
      revision: 0,
      services: [],
      patients: [
        {
          id: 'one',
          name: 'Synthetic',
          visits: [],
          appointments: [
            { id: 'a', date: '2035-01-01', time: '10:00', duration: 30, service: 'Synthetic' },
          ],
        },
      ],
    });
    const at = f.a.owner.stats().calls;
    assert.deepEqual(storage.readSelectedAppointments([]), []);
    assert.equal(
      f.a.owner.stats().calls,
      at,
      'schema1 empty policy projections need no transaction or SQL RPC',
    );
    assert.deepEqual(
      storage.readSelectedAppointments(['one']),
      storage.readSelected(['one']).patients.map(({ id, appointments }) => ({ id, appointments })),
    );
    const p = f.a.p;
    p.exec('BEGIN READONLY');
    try {
      p.snapshotVersion();
      assert.throws(() => p.prepare('SELECT 1/0 AS value').get(), { code: '22012' });
      assert.throws(
        () => p.snapshotVersion(),
        { code: '25P02' },
        'a cached token cannot conceal an aborted owning snapshot',
      );
    } finally {
      p.exec('ROLLBACK');
    }
    p.exec('BEGIN READONLY');
    try {
      assert.match(p.snapshotVersion(), /^[0-9]+:[0-9]+:/);
    } finally {
      p.exec('ROLLBACK');
    }
  },
);

test(
  'actual PostgreSQL response prefetch is bounded and owned by one physical READONLY root',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 2 });
    const p = f.a.p,
      org = f.organizations[0];
    const value = Buffer.from('synthetic-readbatch-before');
    p.prepare('INSERT INTO telegram_settings(organization_id,value) VALUES(?,?)').run(org, value);
    p.prepare(
      'INSERT INTO appointment_manual_confirmations(organization_id,patient_id,appointment_id,value) VALUES(?,?,?,?)',
    ).run(org, 'synthetic-p', 'synthetic-a', Buffer.from('manual'));
    const settings = p.prepare('SELECT value FROM telegram_settings WHERE organization_id=?');
    const families = [
      'telegram_settings',
      'appointment_manual_confirmations',
      'notification_confirmations',
      'notification_channel_jobs',
      'telegram_links',
      'max_client_links',
      'memberships',
    ].map((table) => p.prepare('SELECT * FROM ' + table + ' WHERE organization_id=?'));
    const args = [org];
    await t.test(
      'seven original families execute in one native command and preserve ordinary rows/byte decoders',
      () => {
        assert.equal(p.canPrefetchReads, false);
        const baseline = families.map((q) => q.all(...args));
        p.exec('BEGIN READONLY');
        try {
          assert.equal(p.canPrefetchReads, true);
          const tokens = families.map((q) => q.readRequest('all', args));
          const before = f.a.owner.stats().calls;
          assert.equal(p.prefetchReads(tokens), true);
          assert.equal(f.a.owner.stats().calls - before, 1);
          assert.deepEqual(
            families.map((q) => q.all(...args)),
            baseline,
          );
          assert.equal(f.a.owner.stats().calls - before, 1);
          const changed = families[0].all(...args);
          changed[0].value[0] ^= 1;
          assert.deepEqual(
            families[0].all(...args),
            baseline[0],
            'no mutable byte alias reaches another consumer',
          );
          assert.equal(p.prefetchReads([...tokens, tokens[0]]), true);
          assert.equal(
            f.a.owner.stats().calls - before,
            1,
            'incoming duplicates and repeated cached keys do no RPC',
          );
          assert.throws(
            () =>
              p
                .prepare('SELECT * FROM platform_sessions WHERE id=?')
                .readRequest('all', ['synthetic']),
            { code: 'POSTGRES_READ_BATCH_AUTHORITY' },
          );
        } finally {
          p.exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'one thousand inactive cabinet evictions preserve the owning response cache without reviving closed handles',
      () => {
        p.exec('BEGIN READONLY');
        try {
          const token = settings.readRequest('get', args);
          assert.equal(p.prefetchReads([token]), true);
          const before = f.a.owner.stats().calls;
          let closed, oldStatement;
          for (let i = 0; i < 1000; i++) {
            closed = f.a.owner.open(f.cabinets[i % f.cabinets.length]);
            oldStatement = closed.prepare('SELECT key,value FROM meta WHERE key=?');
            closed.close();
          }
          assert.equal(
            f.a.owner.stats().calls - before,
            1000,
            'each new logical handle still performs its ordinary metadata attestation',
          );
          const afterEviction = f.a.owner.stats().calls;
          assert.deepEqual(settings.get(...args).value, value);
          assert.equal(p.prefetchReads([token]), true);
          assert.equal(
            f.a.owner.stats().calls - afterEviction,
            0,
            "LRU close must not discard another handle's RR cache",
          );
          assert.throws(() => oldStatement.get('revision'), { code: 'POSTGRES_CLOSED' });
          assert.throws(() => oldStatement.readRequest('get', ['revision']), {
            code: 'POSTGRES_CLOSED',
          });
          assert.throws(() => closed.prefetchReads([]), { code: 'POSTGRES_CLOSED' });
          const activeCabinet = f.a.owner.open(f.cabinets[0]);
          activeCabinet.exec('BEGIN READONLY');
          activeCabinet.close();
          assert.throws(() => p.prefetchReads([token]), { code: 'POSTGRES_READ_BATCH_TOKEN' });
          const invalidated = f.a.owner.stats().calls;
          settings.get(...args);
          assert.equal(
            f.a.owner.stats().calls - invalidated,
            1,
            'active close still rolls back and clears every cached response row',
          );
        } finally {
          p.exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'same root stays at its MVCC snapshot and the next root observes a concurrent commit',
      async () => {
        const writer = await f.open();
        p.exec('BEGIN READONLY');
        try {
          assert.equal(p.prefetchReads([settings.readRequest('get', args)]), true);
          writer.p
            .prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?')
            .run(Buffer.from('synthetic-readbatch-after'), org);
          assert.deepEqual(settings.get(...args).value, value);
        } finally {
          p.exec('COMMIT');
        }
        p.exec('BEGIN READONLY');
        try {
          assert.deepEqual(settings.get(...args).value, Buffer.from('synthetic-readbatch-after'));
        } finally {
          p.exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'native SQL failure clears every prefetched entry and preserves 25P02 until ROLLBACK',
      () => {
        p.exec('BEGIN READONLY');
        try {
          p.prefetchReads([settings.readRequest('get', args)]);
          assert.throws(() => p.prepare('SELECT 1/0 AS value').get(), { code: '22012' });
          assert.throws(
            () => settings.get(...args),
            { code: '25P02' },
            'the prior prefetched value must not hide aborted SQL',
          );
        } finally {
          p.exec('ROLLBACK');
        }
        assert.equal(p.canPrefetchReads, false);
      },
    );
    await t.test(
      'a batch validates all descriptors first and publishes no successful prefix on SQL failure',
      () => {
        p.exec('BEGIN READONLY');
        try {
          const okay = settings.readRequest('get', args),
            bad = p.prepare('SELECT 1/0 AS value').readRequest('get', []);
          assert.throws(() => p.prefetchReads([okay, bad]), { code: '22012' });
          assert.throws(() => settings.get(...args), { code: '25P02' });
        } finally {
          p.exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'root lifetime and nested rollback reject old tokens and cannot retain cached cabinet/platform values',
      () => {
        p.exec('BEGIN READONLY');
        const old = settings.readRequest('get', args);
        p.prefetchReads([old]);
        const c = f.a.c[0];
        c.exec('BEGIN READONLY');
        try {
          assert.equal(
            p.canPrefetchReads,
            false,
            'only the current matching logical scope can prefetch',
          );
          const meta = c.prepare('SELECT key,value FROM meta WHERE key=?');
          assert.equal(c.prefetchReads([meta.readRequest('all', ['revision'])]), true);
          assert.throws(() => c.prefetchReads([old]), { code: 'POSTGRES_READ_BATCH_TOKEN' });
        } finally {
          c.exec('ROLLBACK');
        }
        const before = f.a.owner.stats().calls;
        settings.get(...args);
        assert.equal(
          f.a.owner.stats().calls - before,
          1,
          'rollback invalidates prior platform cache',
        );
        assert.throws(() => p.prefetchReads([old]), { code: 'POSTGRES_READ_BATCH_TOKEN' });
        p.exec('COMMIT');
        p.exec('BEGIN READONLY');
        try {
          assert.throws(() => p.prefetchReads([old]), { code: 'POSTGRES_READ_BATCH_TOKEN' });
        } finally {
          p.exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'row-budget fallback drains SELECT without poisoning the connection or the SQL transaction',
      () => {
        const large = p.prepare('SELECT value FROM json_each(?)');
        const input = JSON.stringify(Array.from({ length: 20001 }, (_, i) => i));
        p.exec('BEGIN READONLY');
        try {
          assert.equal(p.prefetchReads([large.readRequest('all', [input])]), false);
          assert.equal(
            large.all(input).length,
            20001,
            'ordinary bounded transport path is still available',
          );
          assert.equal(
            settings.get(...args).value.length,
            Buffer.from('synthetic-readbatch-after').length,
          );
          assert.equal(f.a.owner.stats().poisoned, false);
        } finally {
          p.exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'queued reads share one row budget, drain later SELECTs, and preserve a later real SQL failure',
      () => {
        const many = p.prepare('SELECT value FROM json_each(?)');
        const first = JSON.stringify(Array.from({ length: 12000 }, (_, i) => i));
        const second = JSON.stringify(Array.from({ length: 12000 }, (_, i) => i + 20000));
        const bad = p.prepare('SELECT 1/0 AS value');
        p.exec('BEGIN READONLY');
        try {
          assert.equal(
            p.prefetchReads([many.readRequest('all', [first]), many.readRequest('all', [second])]),
            false,
          );
          assert.equal(
            settings.get(...args).value.length,
            Buffer.from('synthetic-readbatch-after').length,
          );
          assert.equal(f.a.owner.stats().poisoned, false);
          assert.throws(
            () =>
              p.prefetchReads([
                many.readRequest('all', [first]),
                many.readRequest('all', [second]),
                bad.readRequest('get', []),
              ]),
            { code: '22012' },
          );
          assert.throws(() => settings.get(...args), { code: '25P02' });
          assert.equal(f.a.owner.stats().poisoned, false);
        } finally {
          p.exec('ROLLBACK');
        }
        assert.equal(
          settings.get(...args).value.length,
          Buffer.from('synthetic-readbatch-after').length,
        );
      },
    );
    await t.test(
      'aggregate SQL deadline leaves the channel alive and the owning RR aborted until rollback',
      async () => {
        const { Client } = require('pg');
        const expectedCurrent = settings.get(org).value;
        const first = new Client(f.runtime.admin),
          second = new Client(f.runtime.admin);
        let release;
        await first.connect();
        try {
          await second.connect();
          await first.query('BEGIN');
          await first.query(
            'LOCK TABLE cartoteca_platform.telegram_settings IN ACCESS EXCLUSIVE MODE',
          );
          await second.query('BEGIN');
          await second.query(
            'LOCK TABLE cartoteca_platform.appointment_manual_confirmations IN ACCESS EXCLUSIVE MODE',
          );
          p.exec('BEGIN READONLY');
          const manual = p.prepare(
            'SELECT value FROM appointment_manual_confirmations WHERE organization_id=?',
          );
          const tokens = [
            settings.readRequest('get', [org]),
            manual.readRequest('all', [org]),
            ...Array.from({ length: 30 }, (_, i) =>
              p.prepare('SELECT ? AS value').readRequest('get', [i]),
            ),
          ];
          // PostgreSQL releases this first lock without waiting for the blocked Node loop.
          release = first.query('SELECT pg_sleep(0.2); COMMIT');
          assert.throws(() => p.prefetchReads(tokens), { code: '57014' });
          assert.equal(f.a.owner.stats().poisoned, false);
          assert.throws(() => settings.get(org), { code: '25P02' });
          p.exec('ROLLBACK');
          await second.query('ROLLBACK');
          await release;
          assert.deepEqual(settings.get(org).value, expectedCurrent);
        } finally {
          if (p.isTransaction) p.exec('ROLLBACK');
          await first.query('ROLLBACK').catch(() => {});
          await second.query('ROLLBACK').catch(() => {});
          await release?.catch(() => {});
          await first.end();
          await second.end();
        }
      },
    );
    await t.test(
      'writer and unframed reads cannot manufacture response descriptors or use prefetch',
      () => {
        assert.equal(p.prefetchReads([]), false);
        assert.throws(() => settings.readRequest('get', args), {
          code: 'POSTGRES_READ_BATCH_SCOPE',
        });
        p.exec('BEGIN IMMEDIATE');
        try {
          assert.equal(p.canPrefetchReads, false);
          assert.equal(p.prefetchReads([]), false);
        } finally {
          p.exec('ROLLBACK');
        }
      },
    );
  },
);
