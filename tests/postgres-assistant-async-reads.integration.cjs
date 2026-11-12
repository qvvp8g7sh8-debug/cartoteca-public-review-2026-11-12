const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { hotDirectoryFixture170 } = require('./helpers/postgres-hot-directory170-fixture.cjs');
const {
  createAssistantReads,
} = require('../src/server/infrastructure/postgres/assistant-reads.cjs');
const {
  createReadOperationClient,
} = require('../src/server/infrastructure/postgres/read-operation-client145.cjs');
const {
  resolveClient,
} = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const { createAssistantStore } = require('../src/server/modules/assistant/access/store.cjs');

test(
  'assistant uses bounded asynchronous native PG reads with fresh authority and a live event loop',
  { timeout: 120000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t);
    let reads,
      delay = false,
      delayStarted,
      afterCommit,
      finishBarrier;
    const trace = [];
    try {
      reads = createAssistantReads(f.config, {
        createReadOperationClient(config) {
          return createReadOperationClient(config, {
            createClient(options) {
              const client = new Client(options),
                query = client.query.bind(client);
              client.query = (input, ...args) => {
                const sql = typeof input === 'string' ? input : input.text;
                trace.push(sql);
                if (finishBarrier && sql.includes('fence_locked')) {
                  const wait = finishBarrier;
                  finishBarrier = null;
                  return wait.then(() => query(input, ...args));
                }
                if (delay && sql.includes('WITH auth_guard AS MATERIALIZED')) {
                  delay = false;
                  delayStarted?.();
                  return query('SELECT pg_sleep(0.15)').then(() => query(input, ...args));
                }
                const result = query(input, ...args);
                if (sql === 'COMMIT' && afterCommit) {
                  const callback = afterCommit;
                  afterCommit = null;
                  finishBarrier = result.then(async (value) => {
                    await callback();
                    return value;
                  });
                  return finishBarrier;
                }
                return result;
              };
              return client;
            },
          });
        },
      });
      const actor = f.actors[0];
      const sessionId = f.a.p
        .prepare('SELECT id FROM platform_sessions WHERE token_hash=?')
        .get(f.database.tokenHash(actor.token)).id;
      const c = {
        current: { ...actor, sessionId, globalAdmin: false },
        token: actor.token,
        assertCurrent() {},
        assertAssistantReadCurrent() {},
      };
      c.assistantReads = reads.bind(c);
      const bootstrapStarted = performance.now(),
        bootstrapSql = trace.length;
      assert.equal(await c.assistantReads.timeZone(), 'Europe/Moscow');
      t.diagnostic(
        JSON.stringify({
          actualPostgres: true,
          phase: 'first native reader open',
          ms: performance.now() - bootstrapStarted,
          sqlCalls: trace.length - bootstrapSql,
          includes:
            'lazy connection, schema/asset validation and one timezone read; not warm business latency',
        }),
      );
      const result = await c.assistantReads.directory('Synthetic Patient', 50);
      assert.equal(result.matched, 1);
      assert.equal(result.directory[0].id, 'patient');
      assert.equal((await c.assistantReads.summaries(['patient']))[0].id, 'patient');
      assert.equal((await c.assistantReads.selected(['patient'])).patients[0].id, 'patient');
      assert.equal((await c.assistantReads.appointmentContext()).members.length, 3);
      assert.equal((await c.assistantReads.serviceGroups()).groups[0].id, 'other');
      const available = await c.assistantReads.availability({
        staffIds: [actor.accountId],
        from: '2035-01-02',
        to: '2035-01-02',
        now: Date.now(),
      });
      assert.equal(available.appointments.length, 2);
      assert.ok(available.schedules instanceof Map);
      assert.equal(available.schedules.size, 1);
      assert.equal(
        (
          await c.assistantReads.availability({
            staffIds: [],
            from: '2035-01-02',
            to: '2035-01-02',
            now: Date.now(),
          })
        ).schedules.size,
        0,
      );
      assert.equal(
        (await c.assistantReads.calendar('2035-01-01', '2035-01-03', {})).appointments.length,
        2,
      );
      assert.ok(
        (
          await c.assistantReads.calendar('2035-01-02', '2035-01-02', {
            overview: { from: '2035-01-01', to: '2035-01-31' },
          })
        ).overview,
      );
      await assert.rejects(
        c.assistantReads.calendar('2035-01-02', '2035-01-02', {
          overview: { from: '2035-01-01', to: '2036-01-01' },
        }),
        { status: 400 },
      );
      assert.ok(Number.isSafeInteger(await c.assistantReads.revision()));
      assert.equal((await resolveClient(c, 'Synthetic Patient')).matches.length, 1);
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now(),
          before = trace.length;
        await c.assistantReads.directory('Synthetic Patient', 50);
        samples.push({ ms: performance.now() - start, sqlCalls: trace.length - before });
      }
      t.diagnostic(JSON.stringify({ actualPostgres: true, method: 'warm directory', samples }));
      const renamed = f.storage.read();
      renamed.patients[0].name = 'Алексей Петрович Иванов';
      renamed.patients[0].firstName = 'Алексей';
      renamed.patients[0].middleName = 'Петрович';
      renamed.patients[0].lastName = 'Иванов';
      f.storage.write(renamed);
      assert.equal((await c.assistantReads.directory('Synthetic Patient', 50)).matched, 0);
      assert.equal((await resolveClient(c, 'Иванову Алексею Петровичу')).matches[0].id, 'patient');
      assert.equal(
        (await c.assistantReads.summaries(['patient'], { predicate: () => false })).length,
        0,
      );
      assert.equal(
        (await c.assistantReads.directory('Иванов', 50, { predicate: () => false })).matched,
        0,
      );
      const directory = path.join(f.dir, 'platform');
      const membership = f.a.p
        .prepare('SELECT created_at FROM memberships WHERE organization_id=? AND account_id=?')
        .get(actor.organizationId, actor.accountId);
      const membershipId = createHash('sha256')
        .update(JSON.stringify([actor.organizationId, actor.accountId, membership.created_at]))
        .digest('base64url');
      const stateStore = createAssistantStore({ ...f.database, directory });
      stateStore.update((state) => {
        state.policy.mode = 'selected';
        state.grants = [
          { organizationId: actor.organizationId, accountId: actor.accountId, membershipId },
        ];
      });
      const baseContext = {
        ...f.database,
        fail: require('../src/shared/errors.cjs').fail,
        billing: { hasServiceConnection: () => false, isServiceEnabled: () => false },
      };
      Object.assign(
        baseContext,
        require('../src/server/modules/organizations/time-zone.cjs').createOrganizationTimeZone(
          baseContext,
        ),
      );
      const syncPlatform = {
        ...baseContext,
        ...require('../src/server/modules/workspace/service.cjs').createWorkspace(baseContext),
        ...require('../src/server/modules/services/groups.cjs').createServiceGroups(baseContext),
      };
      const syncContext = {
        ...c,
        assistantReads: undefined,
        tenantStore: () => f.storage,
        platform: syncPlatform,
      };
      const apiOptions = {
        directory,
        fetchImpl: async () => {
          throw Error('No external provider expected');
        },
      };
      const legacyApi = createAssistant(baseContext, apiOptions);
      const asyncApi = createAssistant({ ...baseContext, assistantReads: reads }, apiOptions);
      const ungrouped = {
        bind(context) {
          const bound = reads.bind(context);
          return { ...bound, snapshot: (callback) => callback() };
        },
      };
      const previousAsyncApi = createAssistant(
        { ...baseContext, assistantReads: ungrouped },
        apiOptions,
      );
      const measuredApis = [
        ['legacy-sync', legacyApi],
        ['native-separate', previousAsyncApi],
        ['native-grouped', asyncApi],
      ];
      for (const [command, target] of [
        ['Открой календарь на завтра', 'calendar'],
        ['Открой карточку Алексея Петровича Иванова', 'clientCard'],
      ]) {
        const measurements = new Map(measuredApis.map(([name]) => [name, []]));
        for (let repeat = 0; repeat < 7; repeat++)
          for (const [name, api] of measuredApis) {
            const start = performance.now(),
              before = trace.length,
              beforeSync = f.a.owner.stats().calls;
            const reply = await api.turn(syncContext, { policyVersion: 0, text: command });
            assert.equal(reply.action.type, target);
            if (repeat >= 2)
              measurements.get(name).push({
                ms: performance.now() - start,
                asyncSql: trace.length - before,
                syncDispatch: f.a.owner.stats().calls - beforeSync,
              });
          }
        for (const [name, samples] of measurements) {
          const ordered = samples.map((sample) => sample.ms).sort((a, b) => a - b);
          t.diagnostic(
            JSON.stringify({
              actualPostgres: true,
              businessService: name,
              target,
              samples,
              medianMs: ordered[2],
              p95Ms: ordered[4],
              sampling: 'interleaved; 2 warmup + 5 measured per path; no load',
              excludes: 'HTTP authentication, speech, external model, network',
            }),
          );
        }
      }
      const groupedStart = trace.length;
      await c.assistantReads.snapshot(async () => {
        const rows = await c.assistantReads.directory('Иванов', 50);
        assert.equal(rows.matched, 1);
        rows.directory[0].name = 'Caller mutation';
        const again = await c.assistantReads.summaries(['patient']);
        assert.equal(again[0].name, 'Алексей Петрович Иванов');
        const context = await c.assistantReads.appointmentContext();
        context.members.length = 0;
        assert.equal((await c.assistantReads.appointmentContext()).members.length, 3);
      });
      assert.equal(
        trace
          .slice(groupedStart)
          .filter((sql) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length,
        1,
      );
      assert.equal(trace.slice(groupedStart).filter((sql) => sql === 'COMMIT').length, 1);
      // A concurrent real cabinet commit cannot mix snapshots inside one phase.
      const beforeRename = f.storage.read();
      await c.assistantReads.snapshot(async () => {
        const first = await c.assistantReads.summaries(['patient']);
        const changed = structuredClone(beforeRename);
        changed.patients[0].name = 'Борис Петрович Иванов';
        changed.patients[0].firstName = 'Борис';
        f.storage.write(changed);
        assert.equal((await c.assistantReads.summaries(['patient']))[0].name, first[0].name);
      });
      assert.equal(
        (await c.assistantReads.summaries(['patient']))[0].name,
        'Борис Петрович Иванов',
      );
      f.storage.write({ ...beforeRename, revision: f.storage.get('revision') });
      const foreign = reads.bind({
        ...c,
        current: { ...c.current, accountId: f.actors[1].accountId },
        token: f.actors[1].token,
      });
      await c.assistantReads.snapshot(async () => {
        await c.assistantReads.timeZone();
        await assert.rejects(foreign.summaries(['patient']), { status: 403 });
      });
      const frameCancellation = new AbortController();
      const cancelledReads = reads.bind({ ...c, transportAbortSignal: frameCancellation.signal });
      await assert.rejects(
        cancelledReads.snapshot(async () => {
          await cancelledReads.summaries(['patient']);
          frameCancellation.abort();
          await cancelledReads.summaries(['patient']);
        }),
        { code: 'ASSISTANT_REQUEST_ABORTED' },
      );
      assert.equal((await c.assistantReads.summaries(['patient']))[0].id, 'patient');
      const booking = await asyncApi.turn(syncContext, {
        policyVersion: 0,
        text: 'Запиши клиента',
      });
      assert.ok(booking.dialogue);
      const answered = await asyncApi.turn(syncContext, {
        policyVersion: 0,
        dialogueId: booking.dialogue.id,
        dialogueVersion: booking.dialogue.version,
        text: 'Алексей Петрович Иванов',
      });
      assert.ok(answered.dialogue);
      assert.equal(answered.action?.type === 'executeAppointment', false, 'saving stays manual');
      // Real service + native reader: a retry owns its own connection lifetime.
      const controller = new AbortController();
      let sawRead;
      const readStarted = new Promise((resolve) => {
        sawRead = resolve;
      });
      delay = true;
      delayStarted = sawRead;
      const repeatBody = {
        policyVersion: 0,
        dialogueId: answered.dialogue.id,
        dialogueVersion: answered.dialogue.version,
        text: 'Повтори вопрос',
      };
      const disconnected = asyncApi.turn(
        { ...syncContext, transportAbortSignal: controller.signal },
        repeatBody,
      );
      await readStarted;
      const liveRetry = asyncApi.turn(syncContext, repeatBody);
      controller.abort();
      await assert.rejects(disconnected, { code: 'ASSISTANT_REQUEST_ABORTED' });
      const repeated = await liveRetry;
      assert.ok(repeated.dialogue);
      let sawSecondRead;
      const secondReadStarted = new Promise((resolve) => {
        sawSecondRead = resolve;
      });
      delay = true;
      delayStarted = sawSecondRead;
      const interrupted = asyncApi.turn(syncContext, {
        ...repeatBody,
        dialogueVersion: repeated.dialogue.version,
        text: 'Ещё раз',
      });
      await secondReadStarted;
      const cancelled = await asyncApi.turn(syncContext, {
        policyVersion: 0,
        dialogueId: repeated.dialogue.id,
        cancel: true,
      });
      assert.equal(cancelled.dialogue, null);
      await assert.rejects(interrupted, { status: 409 });
      delayStarted = null;
      let serviceTicks = 0;
      const serviceTimer = setInterval(() => serviceTicks++, 5);
      delay = true;
      try {
        const reply = await asyncApi.turn(syncContext, {
          policyVersion: 0,
          text: 'Открой карточку Алексея Петровича Иванова',
        });
        assert.equal(reply.action.type, 'clientCard');
      } finally {
        clearInterval(serviceTimer);
      }
      assert.ok(
        serviceTicks >= 5,
        'whole assistant service keeps its event loop live during native SQL',
      );
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 5);
      delay = true;
      const started = performance.now();
      try {
        await c.assistantReads.directory('Иванов', 50);
      } finally {
        clearInterval(ticker);
      }
      assert.ok(ticks >= 5, 'actual delayed PostgreSQL leaves event loop running');
      t.diagnostic(
        JSON.stringify({
          actualPostgres: true,
          artificialSqlDelayMs: 150,
          elapsedMs: performance.now() - started,
          eventLoopTicks: ticks,
          sqlCalls: trace.length,
        }),
      );
      let stale = false;
      c.assertAssistantReadCurrent = () => {
        if (stale) throw Object.assign(Error('stale turn'), { status: 409 });
      };
      delay = true;
      delayStarted = () => {
        setTimeout(() => {
          stale = true;
        }, 20);
      };
      await assert.rejects(c.assistantReads.directory('Patient', 50), { status: 409 });
      stale = false;
      delayStarted = null;
      const projectionKey =
        require('../src/server/infrastructure/cabinet-directory-projection164.cjs').projectionKey(
          'patient',
          '*',
        );
      const originalProjection = f.a.c[0]
        .prepare('SELECT value FROM meta WHERE key=?')
        .get(projectionKey)?.value;
      const summaryCipher = f.a.c[0]
        .prepare("SELECT value FROM cabinet_summaries WHERE patient_id=? AND audience='*'")
        .get('patient').value;
      const keyBytes = require('node:fs').readFileSync(path.join(f.dir, 'encryption.key'));
      const projected =
        originalProjection ||
        require('../src/server/infrastructure/cabinet-directory-projection164.cjs').encodeProjection(
          f.storage.decode(summaryCipher),
          '*',
          summaryCipher,
          {
            encode: f.storage.encode,
            hash: (value) =>
              require('node:crypto').createHmac('sha256', keyBytes).update(value).digest('hex'),
          },
        );
      keyBytes.fill(0);
      try {
        for (const change of [
          (value) => ({ ...value, sourceHash: 'f'.repeat(64) }),
          (value) => ({ ...value, row: { ...value.row, phone: '79991112233' } }),
        ]) {
          f.a.c[0]
            .prepare(
              'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            )
            .run(projectionKey, f.storage.encode(change(f.storage.decode(projected))));
          await assert.rejects(
            c.assistantReads.snapshot(async () => {
              await c.assistantReads.summaries(['patient']);
              return c.assistantReads.directory('Иванов', 50);
            }),
            { status: 503 },
          );
        }
      } finally {
        if (originalProjection)
          f.a.c[0]
            .prepare('UPDATE meta SET value=? WHERE key=?')
            .run(originalProjection, projectionKey);
        else f.a.c[0].prepare('DELETE FROM meta WHERE key=?').run(projectionKey);
      }
      assert.equal((await c.assistantReads.directory('Иванов', 50)).matched, 1);
      afterCommit = () =>
        f.admin.query(
          "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND account_id=$2",
          [f.platform.storeId, actor.accountId],
        );
      await assert.rejects(
        c.assistantReads.snapshot(async () => {
          const found = await c.assistantReads.directory('Иванов', 50);
          return c.assistantReads.summaries([found.directory[0].id]);
        }),
        { status: 401 },
      );
    } finally {
      await reads?.close();
      await f.close();
    }
  },
);
