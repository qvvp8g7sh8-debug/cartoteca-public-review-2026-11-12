const test = require('node:test'),
  assert = require('node:assert/strict');
const { Client } = require('pg');
const { createHash, randomBytes } = require('node:crypto');
const {
  hotDirectoryFixture170: fixture,
} = require('./helpers/postgres-hot-directory170-fixture.cjs');
const {
  prepareDirectoryState196: prepareState,
} = require('../src/server/infrastructure/postgres/directory-state-prepare196.cjs');
const {
  verifyDirectoryState196: verifyState,
} = require('../src/server/infrastructure/postgres/directory-state-schema196.cjs');
const {
  HEAD,
  CHANGES,
  RECORD,
  TRIGGER,
  MAX_CHANGES,
  SEQ_WINDOW,
} = require('../src/server/infrastructure/postgres/directory-state-sql196.cjs');
const {
  projectionKey,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { identifier } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const sha = (v) => createHash('sha256').update(v).digest('hex');
test(
  '196 native adjunct has complete transactional feed, bounded retention and current-state inverse',
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      role = f.runtime.application.user,
      store = f.cabinets[0].storeId,
      app = new Client(f.runtime.application),
      extra = [];
    async function tx(fn, s = store) {
      await f.admin.query('BEGIN');
      try {
        await f.admin.query(
          "SELECT set_config('cartoteca.kind','cabinet',true),set_config('cartoteca.store_id',$1,true)",
          [s],
        );
        const value = await fn();
        await f.admin.query('COMMIT');
        return value;
      } catch (error) {
        await f.admin.query('ROLLBACK');
        throw error;
      }
    }
    const transition = (opts) =>
      tx(() => prepareState(f.admin, role, { stores: f.cabinets, ...opts }));
    const head = async (s = store) =>
      (
        await f.admin.query(
          `SELECT epoch::text,seq::text,floor_seq::text,reset_seq::text,change_count::text FROM ${HEAD} WHERE store_id=$1`,
          [s],
        )
      ).rows[0];
    const log = async (seq, s = store) =>
      (
        await f.admin.query(
          `SELECT seq::text,identity_digest,audience,patient_id,summary_changed,projection_changed FROM ${CHANGES} WHERE store_id=$1 AND seq>$2::bigint ORDER BY seq,identity_digest,audience`,
          [s, seq],
        )
      ).rows;
    async function fingerprint() {
      return (
        await f.admin
          .query(`SELECT count(*)::text n,md5(COALESCE(string_agg(md5(row_to_json(s)::text),'' ORDER BY md5(row_to_json(s)::text)),'')) hash FROM (
 SELECT _store_id,patient_id id,audience,value FROM cartoteca_cabinet.cabinet_summaries UNION ALL
 SELECT _store_id,id,NULL,value FROM cartoteca_cabinet.patients UNION ALL
 SELECT _store_id,key,NULL,value FROM cartoteca_cabinet.meta) s`)
      ).rows[0];
    }
    async function same(before) {
      const after = await fingerprint();
      assert.equal(
        after.n === before.n && after.hash === before.hash,
        true,
        'clinical/cipher fingerprint unchanged',
      );
    }
    async function updateProjection(key = projectionKey('patient', '*')) {
      return f.admin.query(
        'UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key=$2',
        [store, key],
      );
    }
    async function client() {
      const c = new Client(f.runtime.admin);
      await c.connect();
      extra.push(c);
      return c;
    }
    async function begin(c) {
      await c.query('BEGIN');
      await c.query(
        "SELECT set_config('cartoteca.kind','cabinet',true),set_config('cartoteca.store_id',$1,true)",
        [store],
      );
    }
    try {
      await app.connect();
      await t.test('install/rollback/idempotence/reset preserve source bytes', async () => {
        assert.equal(await verifyState(app, role), null);
        const before = await fingerprint();
        await f.admin.query('BEGIN');
        try {
          const value = await prepareState(f.admin, role, { stores: f.cabinets });
          assert.equal(value.prepared, true);
        } finally {
          await f.admin.query('ROLLBACK');
        }
        assert.equal(await verifyState(app, role), null);
        await same(before);
        const installed = await transition();
        assert.equal(installed.preparedHeads, 2);
        assert.equal(installed.clinicalRowsChanged, 0);
        const cap = await verifyState(app, role),
          old = await head(),
          again = await transition();
        assert.equal(again.changed, false);
        assert.deepEqual(await head(), old);
        assert.equal(again.epoch, cap.epoch);
        const reset = await transition({ stores: [store], reset: true });
        assert.equal(reset.headsReset, 1);
        const now = await head();
        assert.notEqual(now.epoch, old.epoch);
        assert.equal(now.seq, '1');
        await same(before);
      });
      await t.test('RLS scope and state/helper write denial', async () => {
        for (const s of f.cabinets)
          await tx(
            () =>
              f.admin.query(
                'UPDATE cartoteca_cabinet.cabinet_summaries SET value=value WHERE _store_id=$1',
                [s.storeId],
              ),
            s.storeId,
          );
        await app.query(
          "SELECT set_config('cartoteca.kind','cabinet',false),set_config('cartoteca.store_id',$1,false)",
          [store],
        );
        const heads = (await app.query(`SELECT store_id FROM ${HEAD}`)).rows,
          changes = (await app.query(`SELECT store_id FROM ${CHANGES}`)).rows;
        assert.equal(heads.length, 1);
        assert.equal(
          heads.every((r) => r.store_id === store),
          true,
        );
        assert.ok(changes.length);
        assert.equal(
          changes.every((r) => r.store_id === store),
          true,
        );
        await assert.rejects(
          () => app.query(`UPDATE ${HEAD} SET seq=seq WHERE store_id=$1`, [store]),
          (e) => e.code === '42501',
        );
        await assert.rejects(
          () =>
            app.query(`SELECT ${RECORD}($1,$2,'*','patient',true,false,false)`, [
              store,
              sha('patient'),
            ]),
          (e) => e.code === '42501',
        );
      });
      await t.test('trigger/owner tampering fails closed', async () => {
        await f.admin.query(
          'ALTER TABLE cartoteca_cabinet.meta DISABLE TRIGGER ct_directory_state196',
        );
        try {
          await assert.rejects(
            () => verifyState(app, role),
            (e) => e.status === 503,
          );
        } finally {
          await f.admin.query(
            'ALTER TABLE cartoteca_cabinet.meta ENABLE TRIGGER ct_directory_state196',
          );
        }
        assert.ok(await verifyState(app, role));
        const owner = (await f.admin.query('SELECT current_user owner')).rows[0].owner,
          temp = 'ct_owner196_' + randomBytes(6).toString('hex');
        await f.admin.query(`CREATE ROLE ${identifier(temp)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        try {
          await f.admin.query(`ALTER FUNCTION ${TRIGGER}() OWNER TO ${identifier(temp)}`);
          await assert.rejects(
            () => verifyState(app, role),
            (e) => e.status === 503,
          );
        } finally {
          await f.admin.query(`ALTER FUNCTION ${TRIGGER}() OWNER TO ${identifier(owner)}`);
          await f.admin.query(`REVOKE ALL ON FUNCTION ${TRIGGER}() FROM ${identifier(temp)}`);
          await f.admin.query(`DROP ROLE ${identifier(temp)}`);
        }
        assert.ok(await verifyState(app, role));
      });
      await t.test('OLD/NEW/audience/delete/projection-only coverage', async () => {
        let before = await head();
        await tx(() =>
          f.admin.query(
            "UPDATE cartoteca_cabinet.cabinet_summaries SET patient_id='moved196',audience=$4 WHERE _store_id=$1 AND patient_id=$2 AND audience=$3",
            [store, 'patient', '*', 'b'.repeat(64)],
          ),
        );
        let rows = await log(before.seq);
        assert.ok(
          rows.some((r) => r.patient_id === 'patient' && r.audience === '*' && r.summary_changed),
        );
        assert.ok(
          rows.some(
            (r) =>
              r.patient_id === 'moved196' && r.audience === 'b'.repeat(64) && r.summary_changed,
          ),
        );
        await tx(() =>
          f.admin.query(
            "UPDATE cartoteca_cabinet.cabinet_summaries SET patient_id='patient',audience='*' WHERE _store_id=$1 AND patient_id='moved196' AND audience=$2",
            [store, 'b'.repeat(64)],
          ),
        );
        const key = projectionKey('directory170-0', '*'),
          cipher = (
            await f.admin.query(
              'SELECT value FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 LIMIT 1',
              [store],
            )
          ).rows[0].value;
        await tx(() =>
          f.admin.query(
            'INSERT INTO cartoteca_cabinet.meta(_store_id,key,value) VALUES($1,$2,$3) ON CONFLICT(_store_id,key) DO UPDATE SET value=excluded.value',
            [store, key, cipher],
          ),
        );
        before = await head();
        await tx(() =>
          f.admin.query('DELETE FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key=$2', [
            store,
            key,
          ]),
        );
        rows = await log(before.seq);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].patient_id, null);
        assert.equal(rows[0].identity_digest, sha('directory170-0'));
        assert.equal(rows[0].projection_changed, true);
        before = await head();
        await tx(() =>
          f.admin.query(
            'DELETE FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND patient_id=$2 AND audience=$3',
            [store, 'directory170-1', '*'],
          ),
        );
        assert.ok(
          (await log(before.seq)).some(
            (r) => r.patient_id === 'directory170-1' && r.summary_changed,
          ),
        );
      });
      await t.test('unrelated meta is stable; READY/malformed reset', async () => {
        const before = await head();
        await tx(() =>
          f.admin.query(
            "UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key IN('revision','initialized')",
            [store],
          ),
        );
        assert.deepEqual(await head(), before);
        for (const key of ['directory164:malformed:*', 'directory164-ready']) {
          await tx(() =>
            f.admin.query(
              'INSERT INTO cartoteca_cabinet.meta(_store_id,key,value) VALUES($1,$2,$3) ON CONFLICT(_store_id,key) DO UPDATE SET value=excluded.value',
              [store, key, Buffer.from('synthetic196')],
            ),
          );
          const h = await head();
          assert.equal(h.reset_seq, h.seq);
          assert.equal(h.floor_seq, h.seq);
          assert.equal(h.change_count, '0');
        }
      });
      await t.test('head commit order and rollback', async () => {
        const a = await client(),
          b = await client(),
          key1 = projectionKey('patient', '*'),
          key2 = projectionKey('directory170-0', '*');
        await tx(async () => {
          for (const key of [key1, key2])
            await f.admin.query(
              'INSERT INTO cartoteca_cabinet.meta(_store_id,key,value) VALUES($1,$2,$3) ON CONFLICT(_store_id,key) DO UPDATE SET value=excluded.value',
              [store, key, Buffer.from('synthetic196')],
            );
        });
        const old = await head();
        await begin(a);
        await a.query(
          'UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key=$2',
          [store, key1],
        );
        await a.query('ROLLBACK');
        assert.deepEqual(await head(), old);
        await begin(a);
        await a.query(
          'UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key=$2',
          [store, key1],
        );
        await begin(b);
        let pending;
        try {
          pending = b.query(
            'UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key=$2',
            [store, key2],
          );
          pending.catch(() => {});
          const until = Date.now() + 4000;
          let blocked = false;
          while (!blocked && Date.now() < until) {
            blocked = (
              await f.admin.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) blocked', [
                b.processID,
                a.processID,
              ])
            ).rows[0].blocked;
            if (!blocked) await new Promise((r) => setTimeout(r, 5));
          }
          assert.equal(blocked, true, 'different source waits on the shared generation head');
          await a.query('COMMIT');
          await pending;
          await b.query('COMMIT');
        } finally {
          await a.query('ROLLBACK');
          await b.query('ROLLBACK');
          if (pending) await pending.catch(() => {});
        }
        assert.equal(BigInt((await head()).seq), BigInt(old.seq) + 2n);
      });
      await t.test('retention/overflow/TRUNCATE preserve complete feed', async () => {
        const key = projectionKey('patient', '*');
        for (let i = 0; i < SEQ_WINDOW + 2; i++) await tx(() => updateProjection(key));
        let h = await head();
        assert.ok(BigInt(h.floor_seq) >= BigInt(h.seq) - BigInt(SEQ_WINDOW));
        assert.ok(Number(h.change_count) <= MAX_CHANGES);
        await tx(() =>
          f.admin.query(
            `INSERT INTO cartoteca_cabinet.meta(_store_id,key,value)
    SELECT $1,'directory164:'||encode(sha256(convert_to('overflow196-'||g::text,'UTF8')),'hex')||':*',$2
    FROM generate_series(1,$3::integer) g`,
            [store, Buffer.from('synthetic196'), MAX_CHANGES + 1],
          ),
        );
        h = await head();
        assert.equal(h.reset_seq, h.seq);
        assert.equal(h.floor_seq, h.seq);
        assert.equal(h.change_count, '0');
        assert.equal((await log('0')).length, 0);
        await tx(() => f.admin.query('TRUNCATE cartoteca_cabinet.cabinet_summaries'));
        for (const s of f.cabinets) {
          const current = await head(s.storeId);
          assert.equal(current.reset_seq, current.seq);
          assert.equal(current.change_count, '0');
        }
      });
      await t.test('current-data inverse and fresh reinstall', async () => {
        const before = await fingerprint(),
          old = await verifyState(app, role);
        const removed = await transition({ rollback: true });
        assert.equal(removed.prepared, false);
        assert.equal(await verifyState(app, role), null);
        await same(before);
        const next = await transition();
        assert.equal(next.preparedHeads, 2);
        assert.notEqual(next.epoch, old.epoch);
        await same(before);
      });
    } finally {
      for (const c of extra) {
        await c.query('ROLLBACK').catch(() => {});
        await c.end().catch(() => {});
      }
      await app.end().catch(() => {});
      await f.close();
    }
  },
);
