const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const { statements } = require('../src/server/infrastructure/postgres/max-inbox-sql134.cjs');
const dirty =
  "INSERT INTO notification_schedule_dirty(kind,organization_id,subject) VALUES(?,?,?) ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor=''";
const cleanBusy = (e) =>
  e.code === 'ERR_SQLITE_ERROR' &&
  e.postgresCode === 'POSTGRES_BUSY' &&
  e.retryableBeforeBegin === true &&
  e.transactionOpen === false &&
  !e.outcomeUnknown &&
  !e.channelPoisoned;
const bot = 'max-inbox-bot:' + 'a'.repeat(64),
  otherBot = 'max-inbox-bot:' + 'b'.repeat(64);
const entity = (kind, key, botHash) => ({
  domain: 'max-inbox',
  kind,
  key,
  ...(kind === 'event' ? { botHash } : {}),
});
test(
  'native scoped queues remove whole-domain serialization while preserving compound, authority, legacy and SQL boundaries',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t),
      a = f.a,
      b = await f.open(),
      c = await f.open();
    const org = (i, queueDomain = 'push') => ({ queueDomain, organizationId: f.organizations[i] });
    await t.test(
      'different organizations in the same job domain and schedule can commit before the held sibling',
      () => {
        for (const domain of ['telegram', 'staff-telegram', 'staff-max', 'push', 'client']) {
          a.p.beginQueueOrganization(org(0, domain));
          b.p.beginQueueOrganization(org(1, domain));
          b.p.exec('COMMIT');
          assert.equal(a.p.isTransaction, true);
          a.p.exec('ROLLBACK');
        }
        a.p.beginQueueOrganization(org(0, 'schedule'));
        a.p.prepare(dirty).run('client', f.organizations[0], 'native-first');
        b.p.beginQueueOrganization(org(1, 'schedule'));
        b.p.prepare(dirty).run('client', f.organizations[1], 'native-second');
        b.p.exec('COMMIT');
        assert.ok(
          b.p
            .prepare(
              'SELECT 1 FROM notification_schedule_dirty WHERE organization_id=? AND subject=?',
            )
            .get(f.organizations[1], 'native-second'),
        );
        assert.equal(a.p.isTransaction, true);
        a.p.exec('ROLLBACK');
        assert.equal(
          c.p
            .prepare('SELECT 1 FROM notification_schedule_dirty WHERE subject=?')
            .get('native-first'),
          undefined,
        );
      },
    );
    await t.test(
      'same organization excludes all queue domains and compound commits while legacy domain/critical maintenance remains compatible',
      () => {
        a.p.beginQueueOrganization(org(0));
        assert.throws(() => b.p.beginQueueOrganization(org(0, 'staff-max')), cleanBusy);
        assert.throws(
          () =>
            b.p.beginCompound({
              operation: 'cabinet',
              organizationId: f.organizations[0],
              cabinetStoreId: f.cabinets[0].storeId,
            }),
          cleanBusy,
        );
        assert.throws(() => b.p.beginQueue('push'), cleanBusy);
        assert.throws(() => b.p.exec('BEGIN QUEUE'), cleanBusy);
        assert.throws(() => b.p.exec('BEGIN IMMEDIATE'), cleanBusy);
        b.p.beginQueue('client');
        b.p.exec('ROLLBACK');
        a.p.exec('ROLLBACK');
        b.p.beginCompound({
          operation: 'cabinet',
          organizationId: f.organizations[0],
          cabinetStoreId: f.cabinets[0].storeId,
        });
        assert.throws(() => a.p.beginQueueOrganization(org(0)), cleanBusy);
        a.p.beginQueueOrganization(org(1));
        a.p.exec('ROLLBACK');
        b.p.exec('ROLLBACK');
      },
    );
    await t.test(
      'the final organization guard may read only its attested cabinet and cannot mutate clinical data',
      () => {
        a.p.beginQueueOrganization(org(0));
        a.c[0].exec('BEGIN READONLY');
        a.c[0].prepare('SELECT value FROM meta').all();
        assert.throws(() => a.c[1].prepare('SELECT value FROM meta').all());
        assert.throws(() =>
          a.c[0]
            .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
            .run('denied', Buffer.from('synthetic')),
        );
        a.c[0].exec('COMMIT');
        a.p.exec('ROLLBACK');
      },
    );
    await t.test(
      'exclusive policy and offline fences reject admission cleanly without consuming a callback',
      async () => {
        for (const key of [KEYS.policy, KEYS.maintenance]) {
          await f.admin.query('SELECT pg_advisory_lock($1::bigint)', [key]);
          try {
            assert.throws(() => a.p.beginQueueOrganization(org(0)), cleanBusy);
            assert.throws(() => b.p.beginQueueEntity(entity('bot', bot)), cleanBusy);
          } finally {
            await f.admin.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
          }
        }
      },
    );
    await t.test(
      'different MAX bot leases write concurrently and events retain shared bot authority until transaction settlement',
      () => {
        a.p.beginQueueEntity(entity('bot', bot));
        a.p.prepare(statements.acquire.sql).run(bot, 'synthetic-owner', 10000, 0);
        b.p.beginQueueEntity(entity('bot', otherBot));
        b.p.prepare(statements.acquire.sql).run(otherBot, 'synthetic-other', 10000, 0);
        b.p.exec('COMMIT');
        assert.equal(a.p.isTransaction, true);
        a.p.exec('COMMIT');
        const first = randomUUID(),
          second = randomUUID();
        for (const id of [first, second])
          a.p
            .prepare(statements.insert.sql)
            .run(id, bot, 'synthetic-' + id, Buffer.from('synthetic'), 0, 0, 1000);
        a.p.beginQueueEntity(entity('event', first, bot));
        assert.equal(
          a.p.prepare(statements.claim.sql).run(100, 'lease-first', first, bot, 0, 0, null, 1, 1)
            .changes,
          1,
        );
        b.p.beginQueueEntity(entity('event', second, bot));
        assert.equal(
          b.p.prepare(statements.claim.sql).run(100, 'lease-second', second, bot, 0, 0, null, 1, 1)
            .changes,
          1,
        );
        b.p.exec('COMMIT');
        assert.throws(() => b.p.beginQueueEntity(entity('bot', bot)), cleanBusy);
        assert.throws(() => b.p.beginQueueEntity(entity('event', first, bot)), cleanBusy);
        assert.throws(() => b.p.beginQueue('max-inbox'), cleanBusy);
        a.p.exec('ROLLBACK');
        assert.equal(
          c.p.prepare('SELECT status FROM max_event_inbox WHERE id=?').get(first).status,
          'pending',
        );
      },
    );
    await t.test(
      'MAX exact capacity admission is serialized separately from event processing and orphan keys are individually scoped',
      () => {
        a.p.beginQueueEntity(entity('admission', bot));
        assert.throws(() => b.p.beginQueueEntity(entity('admission', otherBot)), cleanBusy);
        b.p.beginQueueEntity(entity('event', randomUUID(), otherBot));
        b.p.exec('ROLLBACK');
        a.p.exec('ROLLBACK');
        const key = 'staff-selftest-v1:max:' + randomUUID(),
          other = 'staff-selftest-v1:max:' + randomUUID();
        a.p.beginQueueEntity({ domain: 'staff-max', kind: 'marker', key });
        assert.throws(
          () => b.p.beginQueueEntity({ domain: 'staff-max', kind: 'marker', key }),
          cleanBusy,
        );
        b.p.beginQueueEntity({ domain: 'staff-max', kind: 'marker', key: other });
        b.p.exec('ROLLBACK');
        a.p.exec('ROLLBACK');
      },
    );
    await t.test(
      'a callback or commit-stage BUSY cannot be mistaken for refused outer admission',
      async () => {
        const assets = path.join(f.runtime.root, 'queue-callback-assets');
        const directory = path.join(assets, 'platform');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(assets, 'postgresql-runtime.json'),
          JSON.stringify(f.identity.lineage),
        );
        fs.writeFileSync(path.join(directory, 'platform.key'), randomBytes(32));
        const database = createPlatformDatabase(directory, {
          notificationSchema: 19,
          sharedCabinetWrites: true,
          databaseOwner: a.owner,
        });
        const crafted = (extra = {}) =>
          Object.assign(Error('Synthetic nested BUSY'), {
            code: 'ERR_SQLITE_ERROR',
            postgresCode: 'POSTGRES_BUSY',
            retryableBeforeBegin: true,
            transactionOpen: false,
            channelPoisoned: false,
            outcomeUnknown: false,
            ...extra,
          });
        try {
          for (const extra of [{}, { outcomeUnknown: true, channelPoisoned: true }]) {
            const error = crafted(extra);
            assert.throws(
              () =>
                database.organizationQueueTransaction(() => {
                  throw error;
                }, org(0)),
              (failure) =>
                failure === error &&
                !cleanBusy(failure) &&
                failure.retryableBeforeBegin === false &&
                failure.scopedQueueCallbackStarted === true &&
                failure.outcomeUnknown === (extra.outcomeUnknown ?? false) &&
                failure.channelPoisoned === (extra.channelPoisoned ?? false),
            );
            assert.equal(database.db.isTransaction, false);
          }
          const originalExec = database.db.exec;
          const commitError = crafted({ outcomeUnknown: true });
          database.db.exec = (sql) => {
            if (sql === 'COMMIT') throw commitError;
            return originalExec(sql);
          };
          try {
            assert.throws(
              () => database.organizationQueueTransaction(() => {}, org(0)),
              (error) =>
                error === commitError &&
                !cleanBusy(error) &&
                error.scopedQueueCallbackStarted === true &&
                error.outcomeUnknown === true,
            );
            assert.equal(database.db.isTransaction, false);
          } finally {
            database.db.exec = originalExec;
          }
          await assert.rejects(
            database.asyncOrganizationQueueTransaction(() => {
              throw crafted();
            }, org(0)),
            (error) => !cleanBusy(error) && error.scopedQueueCallbackStarted === true,
          );
          b.p.beginQueueOrganization(org(0));
          let callbacks = 0;
          assert.throws(
            () =>
              database.organizationQueueTransaction(() => {
                callbacks++;
              }, org(0)),
            cleanBusy,
          );
          assert.equal(callbacks, 0);
          b.p.exec('ROLLBACK');
        } finally {
          if (b.p.isTransaction) b.p.exec('ROLLBACK');
          database.closeWriter();
          database.db.close();
        }
      },
    );
    await t.test(
      'every raw worker operation retains pinned cabinet identity after inspect, including held cursors and transaction cleanup',
      async () => {
        const raw = await f.raw();
        const own = f.cabinets[0],
          other = f.cabinets[1];
        const forged = { ...other, organizationId: own.organizationId };
        const read = (scope) =>
          compile('SELECT value FROM meta', scope, [], 'all', f.cabinetCatalog);
        const denied = { code: 'POSTGRES_ASSET_LINEAGE_MISMATCH' };
        a.c[1]
          .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
          .run('private-synthetic', Buffer.from('other-cabinet'));
        assert.throws(() => raw.request({ op: 'begin', scope: forged, mode: 'READONLY' }), denied);
        const cursor = raw.request({
          op: 'cursorOpen',
          scope: other,
          plan: read(other),
          method: 'all',
        }).cursor;
        raw.request({
          op: 'begin',
          scope: f.platform,
          mode: 'QUEUEORG',
          scopedQueue: org(0, 'schedule'),
        });
        try {
          for (const command of [
            { op: 'execute', scope: forged, plan: read(other), method: 'all' },
            { op: 'cursorOpen', scope: forged, plan: read(other), method: 'all' },
            { op: 'snapshotVersion', scope: forged },
            { op: 'savepoint', scope: forged, name: 'ct_sp_901', mode: 'READONLY' },
            { op: 'cursorNext', scope: forged, cursor, size: 1 },
            { op: 'cursorClose', scope: forged, cursor },
            { op: 'commit', scope: forged },
            { op: 'rollback', scope: forged },
          ])
            assert.throws(() => raw.request(command), denied, command.op);
          raw.request({ op: 'savepoint', scope: own, name: 'ct_sp_902', mode: 'READONLY' });
          for (const op of ['release', 'rollbackTo'])
            assert.throws(() => raw.request({ op, scope: forged, name: 'ct_sp_902' }), denied, op);
          raw.request({ op: 'execute', scope: own, plan: read(own), method: 'all' });
          raw.request({ op: 'release', scope: own, name: 'ct_sp_902' });
          assert.match(
            raw.request({ op: 'snapshotVersion', scope: f.platform }),
            /^[0-9]+:[0-9]+:/,
          );
        } finally {
          raw.request({ op: 'rollback', scope: f.platform });
          raw.request({ op: 'cursorClose', scope: other, cursor });
        }
        raw.request({
          op: 'begin',
          scope: f.platform,
          mode: 'QUEUEORG',
          scopedQueue: org(0, 'schedule'),
        });
        raw.request({ op: 'commit', scope: f.platform });
        assert.equal(raw.stats().poisoned, false);
        assert.equal(
          a.c[1]
            .prepare('SELECT value FROM meta WHERE key=?')
            .get('private-synthetic')
            .value.toString(),
          'other-cabinet',
        );
      },
    );
    await t.test(
      'native worker independently denies forged organization, bot, entity and unsupported SQL plans',
      async () => {
        const raw = await f.raw();
        assert.throws(() =>
          raw.request({
            op: 'begin',
            scope: f.platform,
            mode: 'QUEUEORG',
            scopedQueue: { queueDomain: 'push', organizationId: randomUUID() },
          }),
        );
        raw.request({
          op: 'begin',
          scope: f.platform,
          mode: 'QUEUEORG',
          scopedQueue: org(0, 'schedule'),
        });
        const foreign = compile(
          dirty,
          f.platform,
          ['client', f.organizations[1], 'forged'],
          'run',
          f.catalog,
        );
        assert.throws(() =>
          raw.request({
            op: 'execute',
            scope: f.platform,
            plan: foreign,
            method: 'run',
            mutating: true,
          }),
        );
        assert.throws(() =>
          raw.request({
            op: 'execute',
            scope: f.cabinets[1],
            plan: { text: 'SELECT 1', values: [], effect: 'read' },
            method: 'all',
          }),
        );
        assert.throws(() =>
          raw.request({
            op: 'execute',
            scope: f.platform,
            plan: { text: 'SELECT pg_catalog.pg_sleep(1)', values: [], effect: 'read' },
            method: 'all',
          }),
        );
        raw.request({ op: 'rollback', scope: f.platform });
        const id = randomUUID();
        raw.request({
          op: 'begin',
          scope: f.platform,
          mode: 'QUEUEENTITY',
          scopedQueue: entity('event', id, bot),
        });
        const wrong = compile(
          statements.save.sql,
          f.platform,
          [Buffer.from('synthetic'), id, otherBot, 'lease', 100, 1],
          'run',
          f.catalog,
        );
        assert.throws(() =>
          raw.request({
            op: 'execute',
            scope: f.platform,
            plan: wrong,
            method: 'run',
            mutating: true,
          }),
        );
        raw.request({ op: 'rollback', scope: f.platform });
        assert.equal(raw.stats().poisoned, false);
      },
    );
  },
);
