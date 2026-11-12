// Uses only the harness-owned synthetic PostgreSQL cluster and temporary assets.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { calendarFixture163 } = require('./helpers/postgres-calendar163-fixture.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  createPostgresReadOperations,
} = require('../src/server/infrastructure/postgres/read-operations145.cjs');
const { createNativeQueryKernel } = require('../src/server/infrastructure/native-query-kernel.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Synthetic166 barrier was not reached')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  '166 one query kernel overlaps two owning clients and keeps authority, caches, cancellation and counters isolated',
  { timeout: 120000 },
  async (t) => {
    const f = await calendarFixture163(t);
    let extra;
    const clients = [],
      traces = [],
      gates = [],
      actualCommit166 = new Map(),
      authorityOrder166 = [];
    let armed = null,
      commitFailure = null,
      operations,
      kernel,
      closing;
    function arm(match) {
      assert.equal(armed, null);
      const entered = deferred(),
        released = deferred();
      const gate = {
        match,
        entered: entered.promise,
        release: released.resolve,
        resolveEntered: entered.resolve,
        released: released.promise,
      };
      armed = gate;
      gates.push(gate);
      return gate;
    }
    function clearTrace() {
      for (const rows of traces) rows.length = 0;
    }
    function armSubmission166(match) {
      const gate = arm(match);
      gate.beforeSubmit166 = true;
      return gate;
    }
    function metadata(url, actor) {
      return {
        method: 'GET',
        url,
        headers: {
          host: '127.0.0.1:4174',
          cookie: 'cartoteca_v2_session=' + actor.token,
          'x-cartoteca-account-id': actor.accountId,
          'x-cartoteca-organization-id': actor.organizationId,
        },
        runtime: {
          timestamp: Date.now(),
          telegram: { configured: false, connected: false, botId: '' },
          providers: {
            telegram: { configured: false, connected: false, botId: '' },
            max: { configured: false, connected: false, botId: '' },
          },
        },
      };
    }
    async function run(url, actor = f.actors[0], cancel = null, change) {
      const request = metadata(url, actor);
      change?.(request);
      const reply = await kernel.run(request, cancel, {
        memoryClass: 'query-probe',
        requestMemoryClass: async () => {},
      });
      return { status: reply.status, body: JSON.parse(Buffer.from(reply.body).toString()) };
    }
    const tokenHash = (actor) => createHash('sha256').update(actor.token).digest('hex');
    function authorityOwners(actor) {
      return traces.flatMap((rows, index) =>
        rows.some((row) => /fence_locked/.test(row.text) && row.values?.includes(tokenHash(actor)))
          ? [index]
          : [],
      );
    }
    try {
      const tenantDirectory = path.join(f.dir, 'tenants', f.organizations[1]);
      fs.mkdirSync(tenantDirectory, { recursive: true });
      fs.writeFileSync(path.join(tenantDirectory, 'encryption.key'), randomBytes(32), {
        flag: 'wx',
      });
      extra = createStorage(tenantDirectory, {
        cabinetSchema: 2,
        databaseOwner: f.a.owner,
        databaseRoot: f.dir,
        photoOrganizationId: f.organizations[1],
      });
      extra.write({
        revision: 0,
        services: [],
        patients: [
          {
            id: 'other-patient',
            name: 'Synthetic other tenant',
            createdBy: f.actors[3].accountId,
            visits: [],
            appointments: [
              {
                id: 'other-appointment',
                date: '2035-01-02',
                time: '14:00',
                duration: 60,
                staffId: f.actors[3].accountId,
                status: 'scheduled',
                service: 'Synthetic',
              },
            ],
          },
        ],
      });
      const db = await f.open();
      const config = {
        dataDir: f.dir,
        storageBackend: 'postgres',
        postgres: f.runtime.application,
        postgresRevisionProfile: 3,
        cabinetSchema: 2,
        notificationSchema: 19,
        origin: 'http://127.0.0.1:4174',
        host: '127.0.0.1',
        port: 4174,
        production: false,
        sharedCabinetWrites: true,
        commonNotificationsEnabled: true,
        maxEnabled: false,
        pushEnabled: false,
        databaseOwner: db.owner,
      };
      operations = await createPostgresReadOperations(config, {
        readOwnerCapacity166: 2,
        createClient(options) {
          const client = new Client(options),
            query = client.query.bind(client);
          const index = clients.length;
          clients.push(client);
          traces.push([]);
          client.query = (input, ...args) => {
            const text = typeof input === 'string' ? input : input.text;
            traces[index].push({
              text,
              values: typeof input === 'object' ? input.values : args[0],
            });
            if (text === 'COMMIT' && commitFailure) {
              const failure = commitFailure;
              commitFailure = null;
              return Promise.reject(failure);
            }
            // A revoke test must pause ACTUAL postauth submission after the real
            // COMMIT, not delay a COMMIT result while pipelined auth already ran.
            if (armed?.beforeSubmit166 && armed.match(text)) {
              const gate = armed;
              armed = null;
              const committed = actualCommit166.get(index);
              assert.ok(committed, 'postauth gate owns this same client COMMIT');
              return committed.then(async (result) => {
                assert.equal(result.command, 'COMMIT');
                authorityOrder166.push(['commitACK', index]);
                gate.resolveEntered(index);
                await gate.released;
                authorityOrder166.push(['postauthSUBMIT', index]);
                return query(input, ...args);
              });
            }
            // Other barriers delay results, never BEGIN/lock submission order.
            const pending = query(input, ...args);
            if (text === 'COMMIT') actualCommit166.set(index, pending);
            if (armed && armed.match(text)) {
              const gate = armed;
              armed = null;
              return pending.then(async (result) => {
                gate.resolveEntered(index);
                await gate.released;
                return result;
              });
            }
            return pending;
          };
          return client;
        },
      });
      assert.equal(operations.capacity166, 2);
      assert.equal(
        clients.length,
        2,
        'fixed clients, no extra driver workers or per-tenant clients',
      );
      kernel = createNativeQueryKernel(config, { readOperations: operations });
      assert.equal(kernel.stats().version, 3);
      for (const field of ['hits', 'misses', 'invalidated', 'rejected', 'entries'])
        assert.equal(typeof kernel.stats().readViews.directoryResponses165[field], 'number');

      // Public borrowed wrapper cannot release a client while its SQL is pending.
      const borrowed = operations.borrow166(),
        occupied = operations.borrow166();
      const authGate = arm((sql) => /fence_locked/.test(sql));
      const pendingAuth = borrowed.authorize(f.actors[0].token, () => {});
      await bounded(authGate.entered);
      borrowed.release();
      assert.equal(operations.borrow166(), null, 'release remains deferred until SQL drains');
      await assert.rejects(
        borrowed.authorize(f.actors[0].token, () => {}),
        {
          code: 'POSTGRES_READ_OWNER_UNAVAILABLE166',
        },
      );
      authGate.release();
      assert.equal((await pendingAuth).current.accountId, f.actors[0].accountId);
      occupied.release();

      clearTrace();
      const sqlBefore = operations.sqlCalls(),
        statsBefore = kernel.stats().routes.calendar;
      const firstGate = arm((sql) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const first = run(f.url);
      const firstOwner = await bounded(firstGate.entered);
      const second = await bounded(run(f.url, f.actors[1]));
      assert.equal(second.status, 200, JSON.stringify(second));
      assert.equal(second.body.appointments.length, 1);
      firstGate.release();
      const ownerReply = await first;
      assert.equal(ownerReply.status, 200, JSON.stringify(ownerReply));
      assert.equal(ownerReply.body.appointments.length, 2);
      assert.deepEqual(authorityOwners(f.actors[0]), [firstOwner]);
      assert.deepEqual(authorityOwners(f.actors[1]), [1 - firstOwner]);
      for (const index of [0, 1])
        assert.equal(
          traces[index].filter((row) => /fence_locked/.test(row.text)).length,
          2,
          'preauthority and postauthority stay on the same leased physical client',
        );
      const statsAfter = kernel.stats().routes.calendar;
      assert.equal(
        statsAfter.operationSqlCalls - statsBefore.operationSqlCalls,
        operations.sqlCalls() - sqlBefore,
        'overlapping jobs cannot double-count aggregate SQL',
      );
      assert.equal(statsAfter.rpcCalls - statsBefore.rpcCalls, 0);

      const other = await run(f.url, f.actors[3]);
      assert.equal(other.status, 200, JSON.stringify(other));
      assert.equal(other.body.appointments.length, 1);
      assert.equal(other.body.appointments[0].patientId, 'other-patient');
      const mismatch = await run(f.url, f.actors[0], null, (request) => {
        request.headers['x-cartoteca-organization-id'] = f.organizations[1];
      });
      assert.equal(mismatch.status, 428);

      // Successive leases rotate owners; a single physical cache epoch is shared.
      const directory = '/api/cabinet/directory?q=Synthetic&today=2035-01-01&limit=1';
      const cold = await run(directory);
      assert.equal(cold.status, 200, JSON.stringify(cold));
      const hits = operations.viewStats().directoryResponses165.hits;
      clearTrace();
      assert.deepEqual(await run(directory), cold);
      assert.equal(operations.viewStats().directoryResponses165.hits, hits + 1);
      assert.ok(!traces.flat().some((row) => /cartoteca_cabinet\./.test(row.text)));
      const source = f.a.c[0]
        .prepare("SELECT value FROM cabinet_summaries WHERE patient_id='patient' AND audience='*'")
        .get().value;
      f.a.c[0]
        .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id='patient' AND audience='*'")
        .run(f.storage.encode({ ...f.storage.decode(source), visitCount: 123 }));
      assert.equal((await run(directory)).body.directory[0].visitCount, 123);
      assert.equal((await run(directory, f.actors[1])).body.directory[0].visitCount, 0);

      const cancellation = new SharedArrayBuffer(4),
        cancelView = new Int32Array(cancellation);
      const cancelGate = arm((sql) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      clearTrace();
      const cancelled = run(f.url, f.actors[0], cancellation);
      const cancelledOwner = await bounded(cancelGate.entered);
      Atomics.store(cancelView, 0, 1);
      assert.equal((await bounded(run(f.url, f.actors[1]))).status, 200);
      cancelGate.release();
      assert.equal((await cancelled).status, 499);
      assert.equal(traces[cancelledOwner].filter((row) => row.text === 'ROLLBACK').length, 1);
      assert.equal(traces[cancelledOwner].filter((row) => row.text === 'COMMIT').length, 0);
      assert.equal(
        (await run(f.url)).status,
        200,
        'a new explicit request can reuse a drained owner',
      );

      clearTrace();
      const cacheEntries = operations.viewStats().directoryResponses165.entries;
      commitFailure = Object.assign(Error('synthetic166 COMMIT failure'), { code: '08006' });
      const failed = await run('/api/cabinet/directory?q=NoMatch166&today=2035-01-01');
      assert.ok([500, 503].includes(failed.status), JSON.stringify(failed));
      assert.equal(
        traces
          .flat()
          .filter((row) => row.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length,
        1,
        'COMMIT failure cannot replay through the other owner',
      );
      assert.equal(operations.viewStats().directoryResponses165.entries, cacheEntries);
      assert.equal((await run(f.url, f.actors[1])).status, 200);

      // Real COMMIT precedes revoke, and actual postauth submission follows it.
      let commitQueued166 = false;
      const revokeGate = armSubmission166((sql) => {
        if (sql === 'COMMIT') {
          commitQueued166 = true;
          return false;
        }
        return commitQueued166 && /fence_locked/.test(sql);
      });
      const revoked = run(f.url);
      await bounded(revokeGate.entered);
      f.a.p
        .prepare(
          "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
        )
        .run(f.organizations[0], f.actors[0].accountId);
      revokeGate.release();
      assert.ok([401, 403, 428].includes((await revoked).status));
      assert.equal(authorityOrder166.length, 2);
      assert.deepEqual(
        authorityOrder166.map((row) => row[0]),
        ['commitACK', 'postauthSUBMIT'],
      );
      assert.equal(authorityOrder166[0][1], authorityOrder166[1][1]);

      // Poison an active owning client after its real BEGIN. Its sibling must
      // still complete, with no replacement client or replay of the failed read.
      clearTrace();
      const poisonGate = arm((sql) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const poisoned = run(f.url, f.actors[1]);
      const poisonedOwner = await bounded(poisonGate.entered);
      clients[poisonedOwner].emit('error', Error('synthetic166 active client error'));
      assert.equal((await bounded(run(f.url, f.actors[3]))).status, 200);
      poisonGate.release();
      assert.ok([500, 503].includes((await poisoned).status));
      assert.equal(
        traces[poisonedOwner].filter(
          (row) => row.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        ).length,
        1,
      );
      assert.equal(operations.ownerStats166().unhealthy, 1);
      assert.equal(clients.length, 2, 'poison never creates a replacement inside a job');

      const closeGate = arm((sql) => sql === 'COMMIT');
      const last = run(f.url, f.actors[1]);
      await bounded(closeGate.entered);
      let closed = false;
      closing = kernel.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false, 'shutdown cannot close a client/key cache before postauth');
      closeGate.release();
      assert.equal((await last).status, 200);
      await closing;
      assert.equal(closed, true);
      assert.equal(clients.length, 2);
    } finally {
      for (const gate of gates) gate.release();
      if (kernel) await (closing || kernel.close());
      else await operations?.close();
      try {
        extra?.close();
      } finally {
        await f.close();
      }
    }
  },
);
