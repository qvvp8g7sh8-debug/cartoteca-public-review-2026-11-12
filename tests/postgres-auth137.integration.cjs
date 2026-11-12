// Actual runtime factories; faults are injected only after real SQL/COMMIT boundaries.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const sessions = require('../src/server/modules/auth/sessions.cjs'),
  createSessions = sessions.createSessions;
const sessionSql =
  'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)';
const state = {
  active: false,
  auth: 0,
  legacy: 0,
  callbacks: 0,
  before: null,
  lateFailure: false,
  lostAck: false,
  lastSession: null,
};
sessions.createSessions = (c) =>
  createSessions({
    ...c,
    db: new Proxy(c.db, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key);
        return (sql) => {
          const statement = target.prepare(sql);
          if (sql !== sessionSql) return statement;
          return new Proxy(statement, {
            get(t, k) {
              if (k !== 'run') return Reflect.get(t, k);
              return (...args) => {
                const result = t.run(...args);
                if (state.active) state.lastSession = args;
                return result;
              };
            },
          });
        };
      },
    }),
    audit(...args) {
      const result = c.audit(...args);
      if (state.active && state.lateFailure && args[0] === 'login_succeeded')
        c.db.prepare(sessionSql).run(...state.lastSession);
      return result;
    },
    async asyncTransaction(callback, options) {
      if (state.active) state.legacy++;
      return c.asyncTransaction(callback, options);
    },
    ...(c.asyncAuthTransaction
      ? {
          async asyncAuthTransaction(callback, scope, options) {
            if (!state.active) return c.asyncAuthTransaction(callback, scope, options);
            state.auth++;
            const before = state.before;
            state.before = null;
            await before?.();
            const result = await c.asyncAuthTransaction(
              () => {
                state.callbacks++;
                assert.equal(c.db.transactionIntent, 'AUTH');
                return callback();
              },
              scope,
              options,
            );
            if (state.lostAck)
              throw Object.assign(Error('Synthetic loss after actual AUTH COMMIT'), {
                outcomeUnknown: true,
              });
            return result;
          },
        }
      : {}),
  });
const { postgresBusinessFixture } = require('./helpers/postgres-business133-fixture.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const { readRuntime } = require('../src/server/infrastructure/postgres/runtime.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const busy = (e) =>
  e.postgresCode === 'POSTGRES_BUSY' &&
  e.retryableBeforeBegin === true &&
  e.transactionOpen === false &&
  !e.outcomeUnknown &&
  !e.channelPoisoned;
test(
  'ordinary AUTH independently preserves scope, fresh authority, atomic outcomes and unrelated clinical work',
  { timeout: 180000 },
  async (t) => {
    t.after(() => {
      sessions.createSessions = createSessions;
    });
    const f = await postgresBusinessFixture(t),
      db = f.database.db,
      email = 'owner@classic.test',
      password = 'Synthetic-classic-password-2026',
      client = 'auth137-one';
    const second = await f.platform.registerOwner({
      email: 'second@auth137.synthetic.test',
      password,
      displayName: 'Synthetic second',
      organizationName: 'Synthetic second org',
    });
    f.platform.verifyEmail(second.verificationToken);
    const options = await initializePostgresOwner({
      dataDir: f.destination,
      storageBackend: 'postgres',
      postgres: f.runtime.application,
      notificationSchema: 18,
      processRole: 'command',
    });
    const platform2 = createPlatformStore(path.join(f.destination, 'platform'), {
      ...options,
      assistantComposition: false,
      scheduledNotifications: true,
      scheduleStartupReconcile: false,
      notificationChannelProjection: true,
    });
    const database2 = createPlatformDatabase(path.join(f.destination, 'platform'), {
      notificationSchema: 18,
      databaseOwner: options.databaseOwner,
      sharedCabinetWrites: true,
    });
    t.after(async () => {
      state.active = false;
      database2.closeWriter();
      database2.db.close();
      platform2.close();
      await options.databaseOwner.close();
    });
    const keys = [f.database.limitKey('email', email), f.database.limitKey('client', client)],
      cap = {
        accountId: f.owner.accountId,
        organizationId: f.org,
        emailHash: f.database.emailHash(email),
        clientKey: keys[1],
      },
      cap2 = {
        accountId: second.accountId,
        organizationId: second.organizationId,
        emailHash: f.database.emailHash('second@auth137.synthetic.test'),
        clientKey: f.database.limitKey('client', 'auth137-two'),
      };
    const count = (table) => db.prepare('SELECT count(*) n FROM ' + table).get().n;
    const snapshot = () => ({
      sessions: count('platform_sessions'),
      audit: db.prepare("SELECT count(*) n FROM platform_audit WHERE event='login_succeeded'").get()
        .n,
      rates: keys.map(
        (key) => db.prepare('SELECT * FROM login_limits WHERE key=?').get(key) ?? null,
      ),
    });
    const seed = () =>
      f.database.transaction(() => {
        for (const key of keys)
          db.prepare(
            'INSERT INTO login_limits VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_started=excluded.window_started,blocked_until=excluded.blocked_until',
          ).run(key, 2, Date.now(), 0);
      });
    const reset = () => {
      state.auth = state.legacy = state.callbacks = 0;
      state.lastSession = null;
    };
    state.active = true;
    await t.test(
      'known ordinary login uses AUTH while global-admin, unknown and wrong-password remain legacy',
      async () => {
        reset();
        const signed = await f.platform.login(email, password, '', client);
        assert.equal(state.auth, 1);
        assert.equal(state.callbacks, 1);
        assert.equal(state.legacy, 0);
        assert.equal(f.platform.session(signed.token).organizationId, f.org);
        state.primaryToken = signed.token;
        reset();
        await f.platform.login(
          'operator@compound.synthetic.test',
          'Synthetic-compound-operator-password',
          '',
          'admin-client',
        );
        assert.equal(state.auth, 0);
        assert.equal(state.legacy, 1);
        const adminRow = db
          .prepare("SELECT id,value FROM accounts WHERE global_admin=1 AND status='active'")
          .get();
        const sessionCount = count('platform_sessions');
        f.database.transaction(() =>
          db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
            f.database.seal({
              ...f.database.open(adminRow.value),
              adminMfa: { enabled: true, revision: randomUUID() },
            }),
            adminRow.id,
          ),
        );
        try {
          reset();
          await assert.rejects(
            () =>
              f.platform.login(
                'operator@compound.synthetic.test',
                'Synthetic-compound-operator-password',
                '',
                'mfa-client',
              ),
            (e) => e.code === 'MFA_REQUIRED' && e.status === 401,
          );
          assert.equal(state.auth, 0);
          assert.equal(state.legacy, 1);
          assert.equal(count('platform_sessions'), sessionCount);
        } finally {
          f.database.transaction(() =>
            db.prepare('UPDATE accounts SET value=? WHERE id=?').run(adminRow.value, adminRow.id),
          );
        }
        reset();
        await assert.rejects(
          () =>
            f.platform.login(
              'absent@auth137.synthetic.test',
              'wrong-password',
              '',
              'unknown-client',
            ),
          (e) => e.status === 401,
        );
        assert.equal(state.auth, 0);
        reset();
        await assert.rejects(
          () => f.platform.login(email, 'wrong-password', '', 'wrong-client'),
          (e) => e.status === 401,
        );
        assert.equal(state.auth, 0);
        f.database.transaction(() =>
          db.prepare('DELETE FROM login_limits WHERE key=?').run(keys[0]),
        );
      },
    );
    await t.test(
      'admin source changes stay searchable, stale projections repair under legacy EX and hint drift denies without callback',
      async () => {
        const adminId = db
          .prepare("SELECT id FROM accounts WHERE global_admin=1 AND status='active'")
          .get().id;
        f.platform.updateAccountProfile(state.primaryToken, {
          displayName: 'ProjectionChangedOwner',
          organization: {
            name: 'ProjectionChangedOrganization',
            city: 'Synthetic',
            phone: '+79999999999',
          },
        });
        assert.equal(
          f.platform.admin
            .accounts(adminId, { q: 'projectionchangedowner' })
            .items.some((a) => a.id === cap.accountId),
          true,
        );
        assert.equal(
          f.platform.admin
            .organizations(adminId, { q: 'projectionchangedorganization' })
            .items.some((o) => o.id === cap.organizationId),
          true,
        );
        const sourceValues = () => [
          db.prepare('SELECT value FROM accounts WHERE id=?').get(cap.accountId).value,
          db.prepare('SELECT value FROM organizations WHERE id=?').get(cap.organizationId).value,
        ];
        const projections = () => [
          db
            .prepare(
              "SELECT source_value FROM admin_directory_records WHERE kind='account' AND resource_id=?",
            )
            .get(cap.accountId)?.source_value,
          db
            .prepare(
              "SELECT source_value FROM admin_directory_records WHERE kind='organization' AND resource_id=?",
            )
            .get(cap.organizationId)?.source_value,
        ];
        const terms = () =>
          db
            .prepare(
              'SELECT kind,resource_id,term_hash FROM admin_directory_terms ORDER BY kind,resource_id,term_hash',
            )
            .all();
        assert.deepEqual(projections(), sourceValues());
        const stableTerms = terms();
        reset();
        await f.platform.login(email, password, '', client);
        assert.equal(state.auth, 1);
        assert.equal(state.legacy, 0);
        assert.deepEqual(projections(), sourceValues());
        assert.deepEqual(terms(), stableTerms);
        const lastAudit = db
          .prepare(
            "SELECT max(time) time FROM platform_audit WHERE actor_id=? AND event='login_succeeded'",
          )
          .get(cap.accountId).time;
        assert.equal(f.platform.admin.account(adminId, cap.accountId).lastLoginAt, lastAudit);
        assert.equal(
          f.platform.admin.organization(adminId, cap.organizationId).lastActivityAt,
          lastAudit,
        );
        for (const [kind, resource] of [
          ['account', cap.accountId],
          ['organization', cap.organizationId],
        ]) {
          f.database.transaction(() =>
            db
              .prepare(
                'UPDATE admin_directory_records SET source_value=? WHERE kind=? AND resource_id=?',
              )
              .run(Buffer.from('synthetic-stale-projection'), kind, resource),
          );
          reset();
          await f.platform.login(email, password, '', client);
          assert.equal(state.auth, 0);
          assert.equal(state.legacy, 1);
          assert.deepEqual(projections(), sourceValues());
          assert.deepEqual(terms(), stableTerms);
        }
        const before = snapshot();
        reset();
        state.before = () =>
          f.database.transaction(() =>
            db
              .prepare("DELETE FROM admin_directory_records WHERE kind='account' AND resource_id=?")
              .run(cap.accountId),
          );
        try {
          await assert.rejects(
            () => f.platform.login(email, password, '', client),
            (e) => e.status === 401,
          );
          assert.equal(state.auth, 1);
          assert.equal(state.callbacks, 0);
          assert.equal(state.legacy, 0);
          assert.deepEqual(snapshot(), before);
          assert.equal(projections()[0], undefined);
        } finally {
          // The next separate login is a new deliberate command, not automatic retry.
          reset();
          await f.platform.login(email, password, '', client);
          assert.equal(state.auth, 0);
          assert.equal(state.legacy, 1);
          assert.deepEqual(projections(), sourceValues());
          assert.deepEqual(terms(), stableTerms);
        }
      },
    );
    await t.test(
      'different accounts proceed while account A is held; same account or shared IP is intentionally excluded',
      async () => {
        db.beginAuth(cap);
        try {
          const signed = await platform2.login(
            'second@auth137.synthetic.test',
            password,
            '',
            'auth137-two',
          );
          assert.equal(signed.organizationId, second.organizationId);
          assert.throws(() => database2.db.beginAuth({ ...cap, clientKey: cap2.clientKey }), busy);
          assert.throws(() => database2.db.beginAuth({ ...cap2, clientKey: cap.clientKey }), busy);
          const policy = await f.admin.query('SELECT pg_try_advisory_lock($1::bigint) held', [
            KEYS.policy,
          ]);
          if (policy.rows[0].held)
            await f.admin.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.policy]);
          assert.equal(policy.rows[0].held, false, 'admin policy EX is excluded by AUTH policy SH');
        } finally {
          db.exec('ROLLBACK');
        }
        db.beginCompound({
          operation: 'cabinet',
          organizationId: f.org,
          cabinetStoreId: f.storage.db.scope.storeId,
        });
        try {
          const signed = await platform2.login(email, password, '', 'unrelated-clinical-client');
          assert.equal(signed.organizationId, f.org);
        } finally {
          db.exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'late allowed SQL23505 rolls back reset/session/audit and a committed lost ACK never replays',
      async () => {
        seed();
        const before = snapshot();
        reset();
        state.lateFailure = true;
        try {
          await assert.rejects(
            () => f.platform.login(email, password, '', client),
            (e) =>
              e.code === '23505' &&
              e.authCallbackStarted === true &&
              e.retryableBeforeBegin === false,
          );
        } finally {
          state.lateFailure = false;
        }
        assert.deepEqual(snapshot(), before);
        assert.equal(state.callbacks, 1);
        reset();
        state.lostAck = true;
        try {
          await assert.rejects(
            () => f.platform.login(email, password, '', client),
            (e) => e.outcomeUnknown === true,
          );
        } finally {
          state.lostAck = false;
        }
        const after = snapshot();
        assert.equal(after.sessions, before.sessions + 1);
        assert.equal(after.audit, before.audit + 1);
        assert.deepEqual(after.rates, [null, null]);
        assert.equal(state.callbacks, 1);
        assert.equal(state.auth, 1);
      },
    );
    await t.test(
      'fresh revoke, extra active org, disable and unexpected admin deny before callback or writes',
      async () => {
        const account = db
          .prepare('SELECT value,global_admin,status FROM accounts WHERE id=?')
          .get(cap.accountId);
        const cases = [
          {
            run: () =>
              db
                .prepare(
                  "UPDATE memberships SET status='revoked' WHERE organization_id=? AND account_id=?",
                )
                .run(f.org, cap.accountId),
            undo: () =>
              db
                .prepare(
                  "UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?",
                )
                .run(f.org, cap.accountId),
          },
          {
            run: () =>
              db
                .prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
                .run(second.organizationId, cap.accountId, 'cosmetologist', 'active', Date.now()),
            undo: () =>
              db
                .prepare('DELETE FROM memberships WHERE organization_id=? AND account_id=?')
                .run(second.organizationId, cap.accountId),
          },
          {
            run: () =>
              db.prepare("UPDATE organizations SET status='suspended' WHERE id=?").run(f.org),
            undo: () =>
              db.prepare("UPDATE organizations SET status='active' WHERE id=?").run(f.org),
          },
          {
            run: () =>
              db.prepare("UPDATE accounts SET status='suspended' WHERE id=?").run(cap.accountId),
            undo: () =>
              db
                .prepare('UPDATE accounts SET status=? WHERE id=?')
                .run(account.status, cap.accountId),
          },
          {
            run: () =>
              db.prepare('UPDATE accounts SET global_admin=1 WHERE id=?').run(cap.accountId),
            undo: () =>
              db
                .prepare('UPDATE accounts SET global_admin=? WHERE id=?')
                .run(account.global_admin, cap.accountId),
          },
        ];
        for (const scenario of cases) {
          seed();
          const before = snapshot();
          reset();
          state.before = () => f.database.transaction(scenario.run);
          try {
            await assert.rejects(
              () => f.platform.login(email, password, '', client),
              (e) => e.status === 401,
            );
            assert.equal(state.callbacks, 0);
            assert.equal(state.legacy, 0);
            assert.deepEqual(snapshot(), before);
          } finally {
            f.database.transaction(scenario.undo);
          }
        }
        seed();
        const resetToken = f.platform.requestPasswordReset(email);
        let afterPasswordReset;
        reset();
        state.before = async () => {
          // Official legacy password reset also updates the admin projection and revokes sessions.
          await f.platform.resetPassword(resetToken, 'Changed-synthetic-password-137');
          afterPasswordReset = snapshot();
        };
        try {
          await assert.rejects(
            () => f.platform.login(email, password, '', client),
            (e) => e.status === 401,
          );
          assert.equal(state.callbacks, 1);
          assert.deepEqual(snapshot(), afterPasswordReset);
        } finally {
          const restore = f.platform.requestPasswordReset(email);
          await f.platform.resetPassword(restore, password);
        }
      },
    );
    await t.test(
      'coordinator rejects foreign keys, authority updates, nested scopes and reads with no replay',
      async () => {
        const cases = [
          () => db.prepare('DELETE FROM login_limits WHERE key=?').run(cap2.clientKey),
          () =>
            db
              .prepare(
                "UPDATE memberships SET status='revoked' WHERE organization_id=? AND account_id=?",
              )
              .run(cap.organizationId, cap.accountId),
          () =>
            db.prepare("SELECT * FROM accounts WHERE id=? AND status='active'").get(cap2.accountId),
          () => db.exec('BEGIN DEFERRED'),
        ];
        for (const callback of cases) {
          let called = 0;
          await assert.rejects(
            () =>
              f.database.asyncAuthTransaction(() => {
                called++;
                callback();
              }, cap),
            (e) =>
              e.code?.startsWith('POSTGRES_AUTH_') || e.code === 'POSTGRES_TRANSACTION_NESTING',
          );
          assert.equal(called, 1);
          assert.equal(db.isTransaction, false);
        }
      },
    );
    await t.test(
      'raw worker independently rejects forged canonical actor and SQL without coordinator validation',
      async () => {
        const raw = createTransport({ connection: f.runtime.application });
        await raw.ready();
        t.after(() => raw.close());
        const marker = readRuntime(f.destination),
          scope = db.scope;
        raw.request({
          op: 'verifyProfile',
          scope,
          migrationId: marker.migrationId,
          markerHash: digest(marker),
          lineage: marker,
        });
        raw.request({ op: 'inspect', scope, revisionProfile: 3 });
        assert.throws(
          () =>
            raw.request(
              { op: 'begin', scope, mode: 'AUTH', auth: { ...cap, emailHash: 'f'.repeat(64) } },
              { mutating: true },
            ),
          (e) =>
            e.code === 'POSTGRES_AUTH_AUTHORITY_CHANGED' &&
            e.transactionOpen === false &&
            !e.outcomeUnknown &&
            !e.channelPoisoned,
        );
        raw.request({ op: 'begin', scope, mode: 'AUTH', auth: cap }, { mutating: true });
        try {
          const bad = compile(
            'DELETE FROM login_limits WHERE key=?',
            { ...scope, revisionProfile: 3 },
            [cap2.clientKey],
            'run',
            db.catalog,
          );
          assert.throws(
            () =>
              raw.request({ op: 'execute', scope, plan: bad, method: 'run' }, { mutating: true }),
            (e) =>
              e.code === 'POSTGRES_AUTH_FORBIDDEN' &&
              e.transactionOpen === true &&
              !e.outcomeUnknown &&
              !e.channelPoisoned,
          );
          const change = compile(
            "UPDATE memberships SET status='revoked' WHERE organization_id=? AND account_id=?",
            { ...scope, revisionProfile: 3 },
            [cap.organizationId, cap.accountId],
            'run',
            db.catalog,
          );
          assert.throws(
            () =>
              raw.request(
                { op: 'execute', scope, plan: change, method: 'run' },
                { mutating: true },
              ),
            { code: 'POSTGRES_AUTH_FORBIDDEN' },
          );
          assert.throws(
            () => raw.request({ op: 'savepoint', scope, mode: 'READONLY', name: 'ct_sp_1' }),
            { code: 'POSTGRES_AUTH_NESTING' },
          );
        } finally {
          raw.request({ op: 'rollback', scope });
        }
        assert.equal(
          db
            .prepare('SELECT status FROM memberships WHERE account_id=? AND organization_id=?')
            .get(cap.accountId, cap.organizationId).status,
          'active',
        );
      },
    );
  },
);
