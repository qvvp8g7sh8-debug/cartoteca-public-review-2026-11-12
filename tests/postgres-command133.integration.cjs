const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { postgresRevisionFixture } = require('./helpers/postgres-revision133-fixture.cjs');
const {
  preparePostgresRuntimeConfig,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  createNativeCommandServer,
} = require('../src/server/infrastructure/native-command-server.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const headers = (actor) => ({
  cookie: 'cartoteca_v2_session=' + actor.token,
  'x-cartoteca-account-id': actor.accountId,
  'x-cartoteca-organization-id': actor.organizationId,
});
async function request(base, actor, url, options = {}) {
  const response = await fetch(base + url, {
    ...options,
    headers: { ...headers(actor), ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}
function save(base, before, note, operation) {
  const patient = before.patients[0];
  return {
    method: 'PATCH',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Cartoteca-Request': '1',
      'X-Cartoteca-Operation': operation,
    },
    body: JSON.stringify({
      revision: before.revision,
      patients: [{ id: patient.id, before: patient, after: { ...patient, notes: note } }],
      services: [],
    }),
  };
}
async function finite(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(Error('Independent organization save was blocked by the first command owner.')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
test(
  'actual PostgreSQL v3 uses two command PIDs: a real row wait in one organization does not block another manual save',
  { timeout: 150000 },
  async (t) => {
    const f = await postgresRevisionFixture(t);
    await f.change();
    const prepared = await preparePostgresRuntimeConfig({
      ...f.fixture.config,
      dataDir: f.assets,
      storageBackend: 'postgres',
      postgres: f.runtime.application,
    });
    const control = await f.owner(),
      [actor, foreign] = f.fixture.actors;
    const cabinets = f.fixture.actors.map((account) =>
      createStorage(path.join(f.assets, 'tenants', account.organizationId), {
        databaseOwner: control.owner,
        databaseRoot: f.assets,
        photoOrganizationId: account.organizationId,
      }),
    );
    // Command composition has no administrative projection to reconcile.
    // A held policy fence proves the real constructor performs no IMMEDIATE
    // admission; the ordinary web composition keeps its full admin factory.
    const narrow = await f.owner();
    let narrowServer;
    await f.admin.query('BEGIN');
    try {
      await f.admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.policy]);
      narrowServer = createNativeCommandServer(
        { ...prepared, databaseOwner: narrow.owner, internalIngressSecret: 'a'.repeat(64) },
        { telegram: {}, providers: { telegram: {}, max: {} } },
      );
      narrowServer.listen(0, '127.0.0.1');
      await once(narrowServer, 'listening');
      assert.equal(narrowServer.backgroundStatus().active, false);
    } finally {
      await f.admin.query('ROLLBACK');
      if (narrowServer)
        await new Promise((resolve, reject) =>
          narrowServer.close((error) => (error ? reject(error) : resolve())),
        );
      await narrow.close();
    }
    let server,
      held = false,
      first;
    try {
      server = await createIsolatedServer(prepared);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = 'http://127.0.0.1:' + server.address().port,
        topology = server.isolationStatus();
      assert.equal(topology.owner.commands.length, 2);
      assert.equal(
        new Set([
          topology.owner.application.pid,
          topology.owner.background.pid,
          ...topology.owner.commands.map((c) => c.pid),
        ]).size,
        4,
      );
      assert.equal(topology.commands.activeLimit, 2);
      assert.equal(topology.commands.pendingLimit, 16);
      assert.ok(
        topology.commands.owners.every(
          (owner) => owner.activeLimit === 1 && owner.pendingLimit === 0,
        ),
      );
      const before = cabinets.map((storage) => storage.read()),
        firstId = randomUUID(),
        secondId = randomUUID();
      await f.admin.query('BEGIN');
      held = true;
      await f.admin.query(
        "UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key='revision'",
        [actor.organizationId],
      );
      const xid = (await f.admin.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
      let firstCompleted = false;
      first = request(
        base,
        actor,
        '/api/cabinet/changes',
        save(base, before[0], 'Synthetic held owner', firstId),
      ).then((result) => {
        firstCompleted = true;
        return result;
      });
      const deadline = Date.now() + 4000;
      for (;;) {
        const blocked = (
          await f.app.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='transactionid' AND NOT granted AND transactionid::text=$1) AS blocked",
            [xid],
          )
        ).rows[0].blocked;
        if (blocked) break;
        assert.ok(
          Date.now() < deadline,
          'first manual save did not reach the actual native row lock',
        );
        await delay(20);
      }
      const secondOptions = save(base, before[1], 'Synthetic independent owner', secondId);
      const second = await finite(
        request(base, foreign, '/api/cabinet/changes', secondOptions),
        2000,
      );
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(
        firstCompleted,
        false,
        'the first command is still physically blocked while the second commits',
      );
      assert.equal(cabinets[1].read().patients[0].notes, 'Synthetic independent owner');
      assert.equal(
        (await request(base, foreign, '/api/cabinet/operation?statusOnly=1&id=' + secondId)).body
          .status,
        'committed',
      );
      assert.deepEqual(
        (await request(base, actor, '/api/cabinet/operation?statusOnly=1&id=' + secondId)).body,
        { status: 'unknown' },
      );
      await f.admin.query('ROLLBACK');
      held = false;
      const saved = await first;
      first = null;
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(cabinets[0].read().patients[0].notes, 'Synthetic held owner');
      const replay = await request(base, foreign, '/api/cabinet/changes', secondOptions);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.revision, second.body.revision);
      assert.equal(
        cabinets[1].read().revision,
        second.body.revision,
        'a different free process resolves the same receipt without a second commit',
      );
      assert.ok(server.isolationStatus().commands.owners.every((owner) => owner.active <= 1));
      // Abort while the native PID is blocked. HTTP failure must not release
      // that physical owner before its authenticated handler-finally ACK.
      const abortedId = randomUUID(),
        abort = new AbortController();
      await f.admin.query('BEGIN');
      held = true;
      await f.admin.query(
        "UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key='revision'",
        [actor.organizationId],
      );
      const abortedXid = (await f.admin.query('SELECT pg_current_xact_id()::text AS xid')).rows[0]
        .xid;
      const aborted = request(base, actor, '/api/cabinet/changes', {
        ...save(base, cabinets[0].read(), 'Synthetic interrupted handler', abortedId),
        signal: abort.signal,
      }).then(
        (result) => result,
        (error) => error,
      );
      let waitUntil = Date.now() + 4000;
      for (;;) {
        const blocked = (
          await f.app.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='transactionid' AND NOT granted AND transactionid::text=$1) AS blocked",
            [abortedXid],
          )
        ).rows[0].blocked;
        if (blocked) break;
        assert.ok(Date.now() < waitUntil, 'aborted request did not reach the native row wait');
        await delay(20);
      }
      abort.abort();
      await aborted;
      waitUntil = Date.now() + 2000;
      while (server.isolationStatus().commands.owners.some((owner) => owner.active !== 0)) {
        assert.ok(Date.now() < waitUntil, 'client transport did not close');
        await delay(20);
      }
      assert.equal(
        server.isolationStatus().commands.active,
        1,
        'physical slot remains occupied after transport abort',
      );
      const independent = await finite(
        request(
          base,
          foreign,
          '/api/cabinet/changes',
          save(base, cabinets[1].read(), 'Synthetic progress while sibling aborted', randomUUID()),
        ),
        2000,
      );
      assert.equal(independent.status, 200, JSON.stringify(independent.body));
      await f.admin.query('ROLLBACK');
      held = false;
      waitUntil = Date.now() + 3000;
      while (server.isolationStatus().commands.active !== 0) {
        assert.ok(
          Date.now() < waitUntil,
          'handler-finally ACK did not release the physical command slot',
        );
        await delay(20);
      }
      const receipt = await request(
        base,
        actor,
        '/api/cabinet/operation?statusOnly=1&id=' + abortedId,
      );
      assert.ok(['committed', 'unknown'].includes(receipt.body.status));
      const resumed = await request(
        base,
        actor,
        '/api/cabinet/changes',
        save(base, cabinets[0].read(), 'Synthetic owner reused after completion', randomUUID()),
      );
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    } finally {
      if (held) await f.admin.query('ROLLBACK');
      await first?.catch(() => {});
      if (server)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      for (const cabinet of cabinets) cabinet.close();
      await control.close();
    }
  },
);
