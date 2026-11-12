const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { hotDirectoryFixture170 } = require('./helpers/postgres-hot-directory170-fixture.cjs');
const {
  prepareDirectoryState196,
} = require('../src/server/infrastructure/postgres/directory-state-prepare196.cjs');
const {
  verifyDirectoryState196,
} = require('../src/server/infrastructure/postgres/directory-state-schema196.cjs');
const { HEAD } = require('../src/server/infrastructure/postgres/directory-state-sql196.cjs');
const {
  verifyHotMetadata169,
} = require('../src/server/infrastructure/postgres/hot-metadata-component169.cjs');
const {
  createHotDirectoryQuery196,
  parseHotDirectory196,
} = require('../src/server/infrastructure/postgres/hot-directory-query196.cjs');
const {
  createDirectoryReadState196,
} = require('../src/server/infrastructure/postgres/directory-read-state196.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');

test(
  '196 actual hot selected proof and RR logical feed preserve current authority/snapshot boundaries',
  { timeout: 180000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t),
      role = f.runtime.application.user,
      scope = f.cabinets[0],
      actor = f.actors[0],
      app = new Client(f.runtime.application);
    let connected = false,
      writer;
    const shared = f.runtime.status().shared === true;
    const pgPid = shared
      ? null
      : Number(
          fs.readFileSync(path.join(f.runtime.data, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0],
        );
    t.after(() => {
      assert.equal(fs.existsSync(f.runtime.root), false, 'owned synthetic cluster retired');
      if (shared) {
        t.diagnostic(
          'portable196 fixture retired; shared postmaster closure belongs to outer owner',
        );
        return;
      }
      let gone = false;
      try {
        process.kill(pgPid, 0);
      } catch (error) {
        gone = error.code === 'ESRCH';
      }
      assert.equal(gone, true, 'owned postmaster physically exited');
      t.diagnostic('portable196 closure: rootGone=true postmasterGone=true');
    });
    async function adminTx(kind, storeId, fn) {
      await f.admin.query('BEGIN');
      try {
        await f.admin.query(
          "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
          [kind, storeId],
        );
        const value = await fn();
        await f.admin.query('COMMIT');
        return value;
      } catch (error) {
        await f.admin.query('ROLLBACK');
        throw error;
      }
    }
    try {
      await app.connect();
      connected = true;
      assert.equal(await verifyDirectoryState196(app, role), null);
      const prepared = await adminTx('cabinet', scope.storeId, () =>
        prepareDirectoryState196(f.admin, role, { stores: f.cabinets }),
      );
      assert.equal(prepared.prepared, true);
      assert.equal(prepared.clinicalRowsChanged, 0);
      assert.equal(prepared.preparedHeads, f.cabinets.length);
      const opened = await f.open();
      writer = createStorage(f.dir, {
        cabinetSchema: 2,
        databaseOwner: opened.owner,
        databaseRoot: f.dir,
        photoOrganizationId: actor.organizationId,
      });
      assert.equal(writer.db.directoryState196.version, 1);
      const capability = await verifyDirectoryState196(app, role);
      const metadata = await verifyHotMetadata169(app, role, { marker: f.identity.lineage });
      const makePlan = createHotDirectoryQuery196({
        marker: f.identity.lineage,
        capability: metadata,
        platformTemplate: { version: f.catalog.version, hash: digest(f.catalog) },
        directoryState196: capability,
      });
      const input = {
        claimedAccountId: actor.accountId,
        claimedOrganizationId: actor.organizationId,
        tokenHash: createHash('sha256').update(actor.token).digest('hex'),
        selectedIds: ['patient'],
        audience: '*',
      };
      async function hot(change = {}) {
        const query = makePlan({ ...input, ...change }),
          result = await app.query(query.text, query.values);
        return { rows: result.rows, value: parseHotDirectory196(result.rows, query.expected) };
      }
      const selected = async () =>
        (
          await f.admin.query(
            'SELECT value FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND patient_id=$2 AND audience=$3',
            [scope.storeId, 'patient', '*'],
          )
        ).rows[0].value;
      async function repairProjection() {
        const value = await selected(),
          summary = writer.decode(value),
          statement = writer.indexes.directoryProjection164.statement(summary, '*', value);
        assert.ok(statement);
        await adminTx('cabinet', scope.storeId, () =>
          f.admin.query(
            'INSERT INTO cartoteca_cabinet.meta(_store_id,key,value) VALUES($1,$2,$3) ON CONFLICT(_store_id,key) DO UPDATE SET value=excluded.value',
            [scope.storeId, ...statement.args],
          ),
        );
      }
      await t.test(
        'one no-GUC helper returns exact current selected BYTEA despite unrelated caller scope',
        async () => {
          await app.query(
            "SELECT set_config('cartoteca.kind','cabinet',false),set_config('cartoteca.store_id',$1,false)",
            [f.cabinets[1].storeId],
          );
          const reply = await hot();
          assert.equal(reply.value.eligible, true);
          assert.ok(reply.value.directory196);
          assert.deepEqual(
            reply.value.directory196.selected.map((row) => row.id),
            ['patient'],
          );
          assert.deepEqual(reply.value.directory196.selected[0].value, await selected());
          assert.equal(
            f.storage.decode(reply.value.directory196.revisionCipher),
            f.storage.get('revision'),
          );
          const empty = await hot({ selectedIds: [] });
          assert.deepEqual(empty.value.directory196.selected, []);
          assert.equal(empty.rows[0].selected_bytes196, '0');
          const missing = await hot({ selectedIds: ['other-patient'] });
          assert.equal(missing.value.directory196, null);
          assert.deepEqual(missing.rows[0].selected_ciphers196, []);
        },
      );
      await t.test(
        'expired or revoked CURRENT authority never selects clinical ciphers',
        async () => {
          const expires = (
            await f.admin.query(
              'SELECT expires_at FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND token_hash=$2',
              [f.platform.storeId, input.tokenHash],
            )
          ).rows[0].expires_at;
          await adminTx('platform', f.platform.storeId, () =>
            f.admin.query(
              'UPDATE cartoteca_platform.platform_sessions SET expires_at=$3 WHERE _store_id=$1 AND token_hash=$2',
              [f.platform.storeId, input.tokenHash, Date.now() - 60000],
            ),
          );
          try {
            const reply = await hot();
            assert.equal(reply.value.directory196, null);
            assert.deepEqual(reply.rows[0].selected_ciphers196, []);
            assert.equal(reply.rows[0].cabinet_revision196, null);
          } finally {
            await adminTx('platform', f.platform.storeId, () =>
              f.admin.query(
                'UPDATE cartoteca_platform.platform_sessions SET expires_at=$3 WHERE _store_id=$1 AND token_hash=$2',
                [f.platform.storeId, input.tokenHash, expires],
              ),
            );
          }
          await adminTx('platform', f.platform.storeId, () =>
            f.admin.query(
              "UPDATE cartoteca_platform.memberships SET status='revoked' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
              [f.platform.storeId, actor.organizationId, actor.accountId],
            ),
          );
          try {
            const reply = await hot();
            assert.equal(reply.value.directory196, null);
            assert.deepEqual(reply.rows[0].selected_ciphers196, []);
            assert.equal(reply.rows[0].cabinet_revision196, null);
          } finally {
            await adminTx('platform', f.platform.storeId, () =>
              f.admin.query(
                "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
                [f.platform.storeId, actor.organizationId, actor.accountId],
              ),
            );
          }
        },
      );
      await t.test(
        'owning RR keeps one head while later transaction changes the real feed',
        async () => {
          const freshState = () =>
            createDirectoryReadState196({
              capability,
              scope,
              check() {},
              sql: (text, values) => app.query(text, values),
              selectScope: async (selected) => {
                await app.query(
                  "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
                  [selected.kind, selected.storeId],
                );
              },
            });
          await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          let before;
          try {
            const state = freshState();
            before = await state.directoryHead196();
            assert.ok(before);
            await adminTx('cabinet', scope.storeId, () =>
              f.admin.query(
                'UPDATE cartoteca_cabinet.cabinet_summaries SET value=value WHERE _store_id=$1 AND patient_id=$2 AND audience=$3',
                [scope.storeId, 'patient', '*'],
              ),
            );
            assert.deepEqual(await state.directoryHead196(), before);
            assert.deepEqual((await state.directoryChanges196(before, '*')).identities, []);
            await app.query('COMMIT');
          } catch (error) {
            await app.query('ROLLBACK');
            throw error;
          }
          await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const state = freshState(),
              current = await state.directoryHead196(),
              delta = await state.directoryChanges196(before, '*');
            assert.ok(BigInt(current.seq) > BigInt(before.seq));
            assert.equal(delta.identities.length, 1);
            assert.equal(delta.identities[0].patientId, 'patient');
            assert.equal(delta.identities[0].summaryChanged, true);
            assert.equal(delta.identities[0].projectionChanged, true);
            assert.equal(
              delta.identities[0].identityDigest,
              createHash('sha256').update('patient').digest('hex'),
            );
            await app.query('COMMIT');
          } catch (error) {
            await app.query('ROLLBACK');
            throw error;
          }
          await repairProjection();
        },
      );
      await t.test(
        'selected-size bound returns no partial ciphers and reset epochs force bootstrap',
        async () => {
          const original = await selected();
          await adminTx('cabinet', scope.storeId, () =>
            f.admin.query(
              'UPDATE cartoteca_cabinet.cabinet_summaries SET value=$4 WHERE _store_id=$1 AND patient_id=$2 AND audience=$3',
              [scope.storeId, 'patient', '*', Buffer.alloc(2 * 1024 * 1024 + 1)],
            ),
          );
          try {
            const reply = await hot();
            assert.equal(reply.value.directory196, null);
            assert.equal(reply.rows[0].directory_eligibility196, 'selected-size');
            assert.deepEqual(reply.rows[0].selected_ciphers196, []);
          } finally {
            await adminTx('cabinet', scope.storeId, () =>
              f.admin.query(
                'UPDATE cartoteca_cabinet.cabinet_summaries SET value=$4 WHERE _store_id=$1 AND patient_id=$2 AND audience=$3',
                [scope.storeId, 'patient', '*', original],
              ),
            );
            await repairProjection();
          }
          const old = (
            await f.admin.query(`SELECT epoch::text,seq::text FROM ${HEAD} WHERE store_id=$1`, [
              scope.storeId,
            ])
          ).rows[0];
          const reset = await adminTx('cabinet', scope.storeId, () =>
            prepareDirectoryState196(f.admin, role, { stores: [scope.storeId], reset: true }),
          );
          assert.equal(reset.headsReset, 1);
          const reply = await hot();
          assert.notEqual(reply.value.directory196.head.epoch, old.epoch);
          assert.equal(reply.value.directory196.head.seq, '1');
        },
      );
    } finally {
      if (connected) await app.end().catch(() => {});
      writer?.close();
      await f.close();
    }
  },
);
