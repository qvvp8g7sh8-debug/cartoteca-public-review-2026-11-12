const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const {
  createOrganizationQueueMaintenanceStore,
} = require('../src/server/modules/notifications/organization-queue-maintenance134.cjs');
const queries = require('../src/server/infrastructure/postgres/queue-org-maintenance-sql134.cjs');
const {
  queueStatements,
} = require('../src/server/infrastructure/postgres/queue-org-statements134.cjs');
const { cleanBusy } = require('../src/server/modules/notifications/queue-org134.cjs');
const NOW = 1000000000,
  DAY = 86400000;

test(
  'native organization maintenance admits bounded SQL without changing another organization or retrying uncertain sends',
  { timeout: 180000 },
  async (t) => {
    const f = await queueFixture(t),
      { p } = f.a,
      sibling = await f.open(),
      accounts = f.organizations.map(() => randomUUID());
    function legacy(work) {
      p.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        p.exec('COMMIT');
        return result;
      } catch (error) {
        if (p.isTransaction) p.exec('ROLLBACK');
        throw error;
      }
    }
    function transaction(domain, organizationId, work) {
      p.beginQueueOrganization({ queueDomain: domain, organizationId });
      try {
        const result = work();
        p.exec('COMMIT');
        return result;
      } catch (error) {
        if (p.isTransaction) p.exec('ROLLBACK');
        throw error;
      }
    }
    function entityTransaction(scope, work) {
      p.beginQueueEntity(scope);
      try {
        const result = work();
        p.exec('COMMIT');
        return result;
      } catch (error) {
        if (p.isTransaction) p.exec('ROLLBACK');
        throw error;
      }
    }
    legacy(() => {
      for (let i = 0; i < accounts.length; i++)
        p.prepare('INSERT INTO accounts(id,email_hash,value,created_at) VALUES(?,?,?,?)').run(
          accounts[i],
          'synthetic-maintenance-' + accounts[i],
          Buffer.from('synthetic'),
          1,
        );
    });
    function seed(table, id, owner = 0, options = {}) {
      const org = f.organizations[owner],
        status = options.status || 'pending',
        expires = options.expires ?? NOW + DAY,
        lease = options.lease ?? 0;
      if (table === 'notification_channel_jobs') {
        p.prepare(
          'INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          org,
          'patient-' + id,
          'appointment-' + id,
          'stamp',
          options.channel || 'telegram',
          'callback-' + id,
          Buffer.from('synthetic'),
          status,
          NOW,
          expires,
          lease,
        );
      } else {
        const deviceColumn = table === 'staff_push_jobs' ? ',device_id' : '',
          deviceValue = table === 'staff_push_jobs' ? ',?' : '';
        p.prepare(
          `INSERT INTO ${table}(id,organization_id,account_id,event_key,value,status,next_at,expires_at,lease_until,lease_id${deviceColumn}) VALUES(?,?,?,?,?,?,?,?,?,?${deviceValue})`,
        ).run(
          id,
          org,
          accounts[owner],
          'event-' + id,
          Buffer.from('synthetic'),
          status,
          NOW,
          expires,
          lease,
          options.leaseId ?? 'original',
          ...(table === 'staff_push_jobs' ? ['device-' + id] : []),
        );
      }
    }
    const rows = (table, owner) =>
      p
        .prepare(
          `SELECT * FROM ${table}${owner === undefined ? '' : ' WHERE organization_id=?'} ORDER BY id`,
        )
        .all(...(owner === undefined ? [] : [f.organizations[owner]]))
        .map((row) => ({ ...row }));
    const store = (db = p) => createOrganizationQueueMaintenanceStore({ db });
    const phase = (id, db = p) => store(db).phases.find((entry) => entry.id === id);
    function observeWrites(before) {
      return {
        prepare(sql) {
          const statement = p.prepare(sql);
          return sql.startsWith('UPDATE ') && sql.includes(' SET status=CASE id ')
            ? {
                run(...args) {
                  before(sql, args);
                  return statement.run(...args);
                },
              }
            : statement;
        },
      };
    }
    function cases(d) {
      if (d.mode === 'uncertain')
        return [{ status: 'sending', lease: NOW - 1, expected: 'uncertain' }];
      if (d.mode === 'reserved')
        return [
          { status: 'reserved', lease: NOW - 1, expected: 'pending' },
          { status: 'reserved', lease: NOW - 1, expires: NOW, expected: 'cancelled' },
        ];
      if (d.mode === 'delete')
        return [
          ...['sent', 'failed', 'cancelled', ...(d.channel === 'max' ? ['uncertain'] : [])].map(
            (status) => ({ status, expires: NOW - 7 * DAY - 1, expected: null }),
          ),
          { status: 'sent', expires: NOW - 7 * DAY, expected: 'sent', unchanged: true },
        ];
      return [
        { status: 'pending', expires: NOW, expected: 'cancelled' },
        ...(d.table === 'notification_channel_jobs'
          ? []
          : [
              {
                status: 'sending',
                lease: NOW - 1,
                expires: NOW,
                expected: d.mode === 'max-expiry' ? 'uncertain' : 'cancelled',
              },
              { status: 'sending', lease: NOW + 1, expires: NOW, expected: 'cancelled' },
            ]),
      ];
    }

    await t.test(
      'every fixed phase executes actual scoped SQL and leaves foreign rows byte-for-byte unchanged',
      () => {
        const maintenance = store();
        for (const d of queries.phases) {
          const inputs = cases(d);
          legacy(() => {
            p.prepare(`DELETE FROM ${d.table}`).run();
            for (let owner = 0; owner < 2; owner++)
              for (let n = 0; n < inputs.length; n++)
                seed(d.table, d.id + '-' + owner + '-' + n, owner, {
                  ...inputs[n],
                  channel: d.channel,
                });
          });
          const foreign = rows(d.table, 1),
            before = new Map(rows(d.table, 0).map((row) => [row.id, row]));
          const result = transaction(d.domain, f.organizations[0], () =>
            maintenance.phases.find((entry) => entry.id === d.id).run(NOW, 128, f.organizations[0]),
          );
          const selected = inputs.filter((input) => !input.unchanged).length;
          assert.equal(result.examined, selected, d.id);
          assert.equal(result.changed, selected, d.id);
          assert.deepEqual(rows(d.table, 1), foreign, d.id + ': foreign organization');
          const after = new Map(rows(d.table, 0).map((row) => [row.id, row]));
          for (let n = 0; n < inputs.length; n++) {
            const id = d.id + '-0-' + n,
              input = inputs[n],
              row = after.get(id);
            if (input.expected === null) assert.equal(row, undefined, id);
            else if (input.unchanged) assert.deepEqual(row, before.get(id), id);
            else {
              assert.equal(row.status, input.expected, id);
              assert.equal(row.lease_until, 0, id);
              if (d.reset) assert.equal(row.lease_id, null, id);
            }
          }
        }
      },
    );

    await t.test(
      '128 rows use two admitted 64-row updates and keep the other organization untouched',
      () => {
        legacy(() => {
          p.prepare('DELETE FROM staff_push_jobs').run();
          for (let n = 0; n < 128; n++)
            seed('staff_push_jobs', 'batch-' + String(n).padStart(3, '0'), 0, { expires: NOW });
          seed('staff_push_jobs', 'batch-foreign', 1, { expires: NOW });
        });
        const foreign = rows('staff_push_jobs', 1),
          sizes = [];
        const entry = phase(
          'staff-push-expiry',
          observeWrites((sql) => sizes.push((sql.match(/WHEN \? THEN \?/g) || []).length)),
        );
        const result = transaction('push', f.organizations[0], () =>
          entry.run(NOW, 128, f.organizations[0]),
        );
        assert.equal(result.examined, 128);
        assert.equal(result.changed, 128);
        assert.deepEqual(sizes, [64, 64]);
        assert.ok(rows('staff_push_jobs', 0).every((row) => row.status === 'cancelled'));
        assert.deepEqual(rows('staff_push_jobs', 1), foreign);
      },
    );

    await t.test('a freshly replaced lease survives a stale selected-row CAS', () => {
      legacy(() => {
        p.prepare('DELETE FROM staff_max_jobs').run();
        for (let owner = 0; owner < 2; owner++)
          seed('staff_max_jobs', 'replacement-' + owner, owner, {
            status: 'sending',
            lease: NOW - 1,
          });
      });
      const foreign = rows('staff_max_jobs', 1);
      let replacements = 0;
      const entry = phase(
        'staff-max-sending',
        observeWrites(() => {
          replacements++;
          assert.equal(
            p
              .prepare(queueStatements('staff-max').claim.sql)
              .run(
                NOW + DAY,
                'replacement',
                f.organizations[0],
                'replacement-0',
                'sending',
                0,
                NOW - 1,
                'original',
              ).changes,
            1,
          );
        }),
      );
      const result = transaction('staff-max', f.organizations[0], () =>
        entry.run(NOW, 128, f.organizations[0]),
      );
      assert.equal(replacements, 1);
      assert.equal(result.examined, 1);
      assert.equal(result.changed, 0);
      const row = rows('staff_max_jobs', 0)[0];
      assert.equal(row.status, 'sending');
      assert.equal(row.lease_id, 'replacement');
      assert.equal(row.lease_until, NOW + DAY);
      assert.equal(row.attempts, 1);
      assert.deepEqual(rows('staff_max_jobs', 1), foreign);
    });

    await t.test(
      'a native SQL failure in the second chunk rolls back the entire 128-row batch',
      async () => {
        legacy(() => {
          p.prepare('DELETE FROM staff_push_jobs').run();
          for (let n = 0; n < 128; n++)
            seed('staff_push_jobs', 'rollback-' + String(n).padStart(3, '0'), 0, { expires: NOW });
          seed('staff_push_jobs', 'rollback-foreign', 1, { expires: NOW });
        });
        const before = rows('staff_push_jobs');
        await f.admin.query(
          "CREATE FUNCTION cartoteca_platform.synthetic_fail_maintenance134() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic maintenance chunk failure'; RETURN NEW; END $$",
        );
        try {
          await f.admin.query(
            "CREATE TRIGGER synthetic_fail_maintenance134 BEFORE UPDATE ON cartoteca_platform.staff_push_jobs FOR EACH ROW WHEN (NEW.id='rollback-069' AND NEW.status='cancelled') EXECUTE FUNCTION cartoteca_platform.synthetic_fail_maintenance134()",
          );
          let chunks = 0;
          const entry = phase(
            'staff-push-expiry',
            observeWrites(() => chunks++),
          );
          assert.throws(
            () =>
              transaction('push', f.organizations[0], () =>
                entry.run(NOW, 128, f.organizations[0]),
              ),
            (error) => error.code === 'P0001' && !error.outcomeUnknown && !error.channelPoisoned,
          );
          assert.equal(chunks, 2);
          assert.equal(p.isTransaction, false);
          assert.deepEqual(rows('staff_push_jobs'), before);
        } finally {
          await f.admin.query(
            'DROP TRIGGER IF EXISTS synthetic_fail_maintenance134 ON cartoteca_platform.staff_push_jobs',
          );
          await f.admin.query('DROP FUNCTION cartoteca_platform.synthetic_fail_maintenance134()');
        }
      },
    );

    await t.test(
      'marker entity deletes only its orphan and preserves a live job and another marker',
      () => {
        for (const [channel, table] of [
          ['telegram', 'staff_notification_jobs'],
          ['max', 'staff_max_jobs'],
        ]) {
          const live = randomUUID(),
            orphan = randomUUID(),
            other = randomUUID(),
            prefix = 'staff-selftest-v1:' + channel + ':',
            scope = { domain: 'staff-' + channel, kind: 'marker', key: prefix + orphan };
          legacy(() => {
            p.prepare(`DELETE FROM ${table}`).run();
            seed(table, live, 0, { status: 'pending', expires: NOW + DAY });
            for (const id of [live, orphan, other])
              p.prepare('INSERT INTO telegram_runtime(key,value) VALUES(?,?)').run(
                prefix + id,
                Buffer.from('synthetic'),
              );
          });
          const entry = store().phases.find(
              (item) => item.nextEntity && item.queueDomain === scope.domain,
            ),
            untouched = p
              .prepare('SELECT value FROM telegram_runtime WHERE key=?')
              .get(prefix + other);
          assert.throws(() =>
            entityTransaction(scope, () => entry.run(NOW, 1, { ...scope, key: prefix + other })),
          );
          assert.equal(entityTransaction(scope, () => entry.run(NOW, 1, scope)).changed, 1);
          assert.equal(
            p.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(scope.key),
            undefined,
          );
          const liveScope = { ...scope, key: prefix + live };
          assert.equal(entityTransaction(liveScope, () => entry.run(NOW, 1, liveScope)).changed, 0);
          assert.ok(p.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(liveScope.key));
          assert.deepEqual(
            p.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(prefix + other),
            untouched,
          );
        }
      },
    );

    await t.test(
      'the discovery cursor advances from held organization A to writable B and returns to A',
      () => {
        legacy(() => {
          p.prepare('DELETE FROM staff_push_jobs').run();
          seed('staff_push_jobs', 'fair-a', 0, { expires: NOW - 2 });
          seed('staff_push_jobs', 'fair-b', 1, { expires: NOW - 1 });
        });
        const entry = phase('staff-push-expiry'),
          first = entry.nextOrganization(NOW);
        assert.equal(first, f.organizations[0]);
        sibling.p.beginQueueOrganization({ queueDomain: 'push', organizationId: first });
        let callbacks = 0;
        try {
          assert.throws(() => transaction('push', first, () => callbacks++), cleanBusy);
          assert.equal(callbacks, 0);
          const next = entry.nextOrganization(NOW);
          assert.equal(next, f.organizations[1]);
          assert.equal(transaction('push', next, () => entry.run(NOW, 128, next)).changed, 1);
          assert.equal(rows('staff_push_jobs', 0)[0].status, 'pending');
          assert.equal(rows('staff_push_jobs', 1)[0].status, 'cancelled');
          assert.equal(sibling.p.isTransaction, true);
        } finally {
          sibling.p.exec('ROLLBACK');
        }
        const again = entry.nextOrganization(NOW);
        assert.equal(again, f.organizations[0]);
        assert.equal(transaction('push', again, () => entry.run(NOW, 128, again)).changed, 1);
      },
    );
  },
);
