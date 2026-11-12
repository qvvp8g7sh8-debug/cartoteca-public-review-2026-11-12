const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  hotDirectoryFixture170,
  bounded169,
  hotSQL169,
} = require('./helpers/postgres-hot-directory170-fixture.cjs');
const {
  projectionKey,
  encodeProjection,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');

test(
  '185 real PG incremental proof reuses unchanged rows and keeps fresh RR/authority/ACK boundaries',
  { timeout: 300000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t);
    f.config.nativeDirectorySnapshots180 = true;
    const key = fs.readFileSync(path.join(f.dir, 'encryption.key'));
    const original = crypto.createDecipheriv;
    let counting = false,
      decodes = 0;
    crypto.createDecipheriv = function (...args) {
      if (counting && args[0] === 'aes-256-gcm') {
        let exported = null;
        const supplied = args[1];
        const bytes =
          supplied instanceof crypto.KeyObject &&
          supplied.type === 'secret' &&
          supplied.symmetricKeySize === 32
            ? (exported = supplied.export())
            : Buffer.isBuffer(supplied) || ArrayBuffer.isView(supplied)
              ? supplied
              : null;
        if (bytes && Buffer.from(bytes).equals(key)) decodes++;
        exported?.fill(0);
      }
      return original.apply(this, args);
    };
    async function measured(task) {
      decodes = 0;
      counting = true;
      try {
        const reply = await task();
        return { reply, decodes };
      } finally {
        counting = false;
      }
    }
    const db = f.a.c[0],
      patient = 'patient',
      pkey = projectionKey(patient, '*');
    const metadataCount = db
      .prepare("SELECT key FROM meta WHERE key IN('directory164-ready','revision','initialized')")
      .all().length;
    const codec = {
      encode: f.storage.encode,
      hash: (value) => crypto.createHmac('sha256', key).update(value).digest('hex'),
    };
    function capture() {
      return {
        full: db
          .prepare("SELECT value FROM cabinet_summaries WHERE patient_id=? AND audience='*'")
          .get(patient).value,
        projection: db.prepare('SELECT value FROM meta WHERE key=?').get(pkey).value,
        revision: db.prepare("SELECT value FROM meta WHERE key='revision'").get().value,
      };
    }
    function write({
      phone,
      projectionOnly = false,
      corruptFull = false,
      wrongProof = false,
      restore = null,
      rollback = false,
    } = {}) {
      const old = capture();
      const summary = { ...f.storage.decode(old.full), ...(phone ? { phone } : {}) };
      const full = restore?.full || (projectionOnly ? old.full : f.storage.encode(summary));
      const projection =
        restore?.projection ||
        (corruptFull
          ? old.projection
          : wrongProof
            ? f.storage.encode({
                version: 1,
                id: patient,
                audience: '*',
                sourceHash: '0'.repeat(64),
                row: { id: patient, appointments: [] },
              })
            : encodeProjection(summary, '*', full, codec));
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id=? AND audience='*'").run(
          full,
          patient,
        );
        // Real164 invalidation trigger deletes this projection on summary UPDATE.
        // Restore/upsert the intended current proof with triggers left enabled.
        db.prepare(
          'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ).run(pkey, projection);
        db.prepare("UPDATE meta SET value=? WHERE key='revision'").run(
          restore?.revision || f.storage.encode(Number(f.storage.decode(old.revision)) + 1),
        );
        db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return old;
    }
    function owningRR(k) {
      return k.trace.some((r) => r.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    }
    try {
      await t.test(
        'cold validates all; one current changed row and projection-only reencryption each decode only one pair',
        async () => {
          const k = await f.make();
          try {
            const count = db
              .prepare("SELECT count(*) AS n FROM cabinet_summaries WHERE audience='*'")
              .get().n;
            const cold = await measured(() => f.raw(k));
            assert.equal(cold.reply.status, 200);
            assert.equal(cold.decodes, 2 * Number(count) + metadataCount);
            write({ phone: '+79991850001' });
            k.clear();
            const changed = await measured(() => f.raw(k));
            assert.equal(changed.reply.status, 200);
            assert.equal(changed.decodes, metadataCount + 2);
            assert.equal(
              changed.reply.body.directory.find((r) => r.id === patient).phone,
              '+79991850001',
            );
            assert.ok(owningRR(k));
            assert.equal(k.operations.viewStats().entries, 0);
            assert.equal(k.operations.viewStats().directorySnapshots180.entries, 1);
            write({ projectionOnly: true });
            k.clear();
            const reencrypted = await measured(() => f.raw(k));
            assert.equal(reencrypted.reply.status, 200);
            assert.equal(reencrypted.decodes, metadataCount + 2);
            assert.equal(k.operations.ownerStats166().borrowed, 0);
          } finally {
            await k.close();
          }
        },
      );
      await t.test(
        'rollback preserves source stamp and unseen query stays one fresh metadata read',
        async () => {
          const k = await f.make();
          try {
            await f.warm(k);
            write({ phone: '+79991859999', rollback: true });
            k.clear();
            const result = await measured(() =>
              f.raw(k, f.directoryUrl.replace('q=Synthetic', 'q=Gamma')),
            );
            assert.equal(result.reply.status, 200);
            assert.equal(result.decodes, 0);
            assert.equal(k.trace.length, 1);
            assert.ok(hotSQL169(k.trace[0].text));
          } finally {
            await k.close();
          }
        },
      );
      await t.test(
        'current full-only corruption and wrong fresh projection proof are503 before reuse',
        async () => {
          const k = await f.make();
          try {
            await f.warm(k);
            for (const change of [
              { corruptFull: true, phone: '+79991850002' },
              { wrongProof: true },
            ]) {
              const before = write(change);
              k.clear();
              try {
                const result = await measured(() => f.raw(k));
                assert.equal(result.reply.status, 503);
                assert.equal(result.reply.body.directory, undefined);
                assert.equal(
                  result.decodes,
                  metadataCount + (change.wrongProof ? 1 : 0),
                  'full mismatch is rejected before any full-summary decode',
                );
                assert.equal(k.operations.viewStats().entries, 0);
                assert.equal(k.operations.viewStats().directorySnapshots180.entries, 1);
              } finally {
                write({ restore: before });
              }
              k.clear();
              assert.equal((await f.raw(k)).status, 200);
            }
          } finally {
            await k.close();
          }
        },
      );
      await t.test(
        'fresh revocation after COMMIT discards reused producer and does not prime its new source stamp',
        async () => {
          const k = await f.make();
          try {
            await f.warm(k);
            write({ phone: '+79991850003' });
            k.clear();
            const gate = k.arm(
              'submit',
              (text) =>
                text.startsWith('WITH auth_guard') && k.trace.some((r) => r.text === 'COMMIT'),
            );
            const running = f.raw(k);
            try {
              await bounded169(gate.entered);
              f.a.p
                .prepare(
                  "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
                )
                .run(f.organizations[0], f.actors[0].accountId);
              gate.release();
              const reply = await running;
              assert.equal(reply.status, 401);
              assert.equal(reply.body.directory, undefined);
              assert.equal(k.operations.viewStats().directorySnapshots180.entries, 1);
            } finally {
              gate.release();
              await running.catch(() => {});
              f.a.p
                .prepare(
                  "UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?",
                )
                .run(f.organizations[0], f.actors[0].accountId);
            }
            k.clear();
            const again = await measured(() => f.raw(k));
            assert.equal(again.reply.status, 200);
            assert.equal(again.decodes, metadataCount + 2);
            assert.ok(owningRR(k), 'discarded new stamp cannot become a hot response');
          } finally {
            await k.close();
          }
        },
      );
      await t.test(
        'lost read-COMMIT acknowledgement never publishes the newly built representation',
        async () => {
          const k = await f.make();
          try {
            await f.warm(k);
            write({ phone: '+79991850004' });
            k.clear();
            const wrapped = k.clients.map((client) => [client, client.query]);
            let failed = false;
            for (const [client, query] of wrapped)
              client.query = async function (input, ...args) {
                const text = typeof input === 'string' ? input : input.text;
                const reply = await query.call(this, input, ...args);
                if (text === 'COMMIT' && !failed) {
                  failed = true;
                  throw Object.assign(Error('Synthetic185 read ACK lost'), { code: 'ECONNRESET' });
                }
                return reply;
              };
            try {
              const reply = await f.raw(k);
              assert.ok([500, 503].includes(reply.status));
              assert.equal(reply.body.directory, undefined);
              assert.equal(failed, true);
            } finally {
              for (const [client, query] of wrapped) client.query = query;
            }
            k.clear();
            const next = await measured(() => f.raw(k));
            assert.equal(next.reply.status, 200);
            assert.ok(owningRR(k));
            assert.ok(
              next.decodes >= metadataCount + 2,
              'failed ACK cannot prime the new source stamp',
            );
            assert.equal(k.operations.ownerStats166().borrowed, 0);
          } finally {
            await k.close();
          }
        },
      );
    } finally {
      crypto.createDecipheriv = original;
      key.fill(0);
      await f.close();
    }
  },
);
