const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { postgresRevisionFixture } = require('./helpers/postgres-revision133-fixture.cjs');
const {
  preparePostgresRuntimeConfig,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
const {
  createNativeMemoryBudget,
  nativeMemoryProcess,
} = require('../src/server/infrastructure/native-memory-budget.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { readOperationStatus } = require('../src/server/infrastructure/mutation-receipts.cjs');
const {
  largePatient,
  textFingerprint,
  jsonFingerprint,
} = require('./helpers/native-memory-large139.cjs');
const MiB = 1024 * 1024;
const headers = (actor) => ({
  cookie: 'cartoteca_v2_session=' + actor.token,
  'x-cartoteca-account-id': actor.accountId,
  'x-cartoteca-organization-id': actor.organizationId,
});
async function request(base, actor, url, options = {}, timeoutMs = 15000) {
  const response = await fetch(base + url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
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
function gateway(t, processPlan) {
  const child = fork(path.join(__dirname, 'helpers/native-memory-server139.cjs'), [], {
    execArgv: [...processPlan.execArgv],
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const pending = new Map();
  let sequence = 0,
    closed = false,
    stdoutBytes = 0,
    stderrBytes = 0;
  const exit = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      closed = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(Error('Managed gateway closed before reply.'));
      }
      pending.clear();
      resolve({ code, signal });
    }),
  );
  for (const [stream, count] of [
    [child.stdout, 'stdout'],
    [child.stderr, 'stderr'],
  ]) {
    stream.on('data', (bytes) => {
      if (count === 'stdout') stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (stdoutBytes > 65536 || stderrBytes > 65536) child.kill();
    });
  }
  child.on('error', (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  });
  child.on('message', (message) => {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.type === 'failed')
      item.reject(Object.assign(Error('Managed startup refused.'), { code: message.code }));
    else item.resolve(message);
  });
  function rpc(type, config, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Managed IPC deadline.'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, type, ...(config ? { config } : {}) }, (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    });
  }
  async function close() {
    if (!closed) await rpc('close', undefined, 5000).catch(() => child.kill());
    let timer;
    try {
      const result = await Promise.race([
        exit,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 5000);
        }),
      ]);
      if (!result) {
        child.kill();
        await exit;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  t.after(close);
  return { rpc, exit, close, pid: child.pid };
}
function assertTopology(status, expectedGatewayPid, plan) {
  assert.equal(status.closeState, 'open');
  assert.equal(status.owner.state, 'ready');
  assert.equal(status.owner.commands.length, 2);
  assert.equal(status.commandLimit, 2);
  assert.equal(status.queries.readyWorkers, 2);
  assert.equal(status.queries.workers, 2);
  const gateway = status.memory.gateway;
  assert.equal(gateway.pid, expectedGatewayPid);
  assert.equal(gateway.main.threadId, 0);
  const observed = [];
  function report(value, processPlan, expectedCount) {
    assert.ok(value);
    const samples = [value.main, value.database, value.lease].filter(Boolean);
    assert.equal(samples.length, expectedCount);
    for (const sample of samples) {
      assert.equal(sample.pid, value.pid);
      assert.equal(sample.heapSizeLimitBytes, processPlan.heapCeilingMiB * MiB);
      assert.equal(Object.hasOwn(sample, 'rssBytes'), sample.threadId === 0);
      observed.push(sample);
    }
  }
  report(gateway, nativeMemoryProcess(plan, 'gateway'), 1);
  assert.equal(status.queries.memory.length, 2);
  for (const query of status.queries.memory) {
    assert.equal(query.report.pid, expectedGatewayPid);
    assert.ok(query.report.main.threadId > 0);
    assert.ok(query.report.database.threadId > 0);
    report(query.report, nativeMemoryProcess(plan, 'gateway'), 2);
  }
  const records = [status.owner.application, status.owner.background, ...status.owner.commands];
  for (const [index, identity] of ['web', 'background', 'command', 'command-1'].entries()) {
    const record = records[index],
      processPlan = nativeMemoryProcess(plan, identity);
    assert.equal(record.exited, false);
    assert.equal(record.memory.pid, record.pid);
    assert.equal(record.memory.main.threadId, 0);
    assert.deepEqual(record.memoryBudget, {
      version: 1,
      identity,
      heapSizeLimitBytes: processPlan.heapCeilingMiB * MiB,
    });
    report(record.memory, processPlan, identity === 'background' ? 3 : 2);
  }
  assert.equal(new Set([gateway.pid, ...records.map((row) => row.pid)]).size, 5);
  assert.equal(observed.length, 14);
  assert.equal(new Set(observed.map((row) => row.pid + ':' + row.threadId)).size, 14);
  const actualMiB = observed.reduce((sum, row) => sum + row.heapSizeLimitBytes / MiB, 0);
  assert.equal(actualMiB, 6740);
  assert.equal(actualMiB, plan.totals.compatibilityHeapCeilingsMiB);
  assert.equal(plan.totals.oldGenerationMiB, 6656);
  assert.equal(plan.totals.workingAllocatedMiB, 1536);
  assert.equal(plan.totals.workingUnallocatedMiB, 0);
  assert.ok(plan.totals.workingOldTargetMiB < plan.totals.oldGenerationMiB);
  assert.equal(plan.heapCeilingsOverSubscribed, true);
  assert.equal(plan.model, 'working-targets-and-compatible-ceilings-v2');
  assert.equal(status.memory.budget.rssHardCapClaim, false);
  return observed.map((row) => row.pid + ':' + row.threadId).sort();
}
test(
  'managed PostgreSQL v3 observes all fourteen actual caps and preserves auth, notes, receipt, fresh reads and atomic CAS',
  {
    timeout: 240000,
  },
  async (t) => {
    const f = await postgresRevisionFixture(t);
    await f.change();
    const prepared = await preparePostgresRuntimeConfig({
      ...f.fixture.config,
      dataDir: f.assets,
      storageBackend: 'postgres',
      postgres: f.runtime.application,
      nativeMemoryBudgetVersion: 1,
      nativeMemoryBudgetMiB: 1536,
    });
    assert.equal(prepared.postgresRevisionProfile, 3);
    const plan = createNativeMemoryBudget({ budgetMiB: 1536, commandCount: 2, postgres: true });
    const controlled = await f.owner();
    const [actor, foreign] = f.fixture.actors;
    const cabinets = f.fixture.actors.map((account) =>
      createStorage(path.join(f.assets, 'tenants', account.organizationId), {
        databaseOwner: controlled.owner,
        databaseRoot: f.assets,
        photoOrganizationId: account.organizationId,
      }),
    );
    const server = gateway(t, nativeMemoryProcess(plan, 'gateway'));
    try {
      const started = await server.rpc('start', prepared);
      assert.equal(started.type, 'ready');
      const initialTopology = assertTopology(started.status, server.pid, plan);
      const base = 'http://127.0.0.1:' + started.port;
      const [before, untouched] = cabinets.map((storage) => storage.read());
      const patientUrl = '/api/cabinet/patient?id=' + actor.patientId;
      assert.equal((await request(base, actor, '/api/auth/session')).body.user.id, actor.accountId);
      assert.equal((await request(base, actor, patientUrl)).status, 200);
      assert.equal((await request(base, foreign, patientUrl)).status, 404);
      const operation = randomUUID();
      const options = save(base, before, 'Synthetic managed notes committed', operation);
      const crossed = await request(base, actor, '/api/cabinet/changes', {
        ...options,
        headers: { ...options.headers, cookie: headers(foreign).cookie },
      });
      assert.equal(crossed.status, 428);
      assert.equal(crossed.body.code, 'AUTH_CONTEXT_CHANGED');
      assert.deepEqual(cabinets[0].read(), before);
      assert.deepEqual(readOperationStatus(cabinets[0], { ...actor, role: 'owner' }, operation), {
        status: 'unknown',
      });
      const saved = await request(base, actor, '/api/cabinet/changes', options);
      assert.equal(saved.status, 200);
      const replay = await request(base, actor, '/api/cabinet/changes', options);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.revision, saved.body.revision);
      const receiptUrl = '/api/cabinet/operation?statusOnly=1&id=' + operation;
      const receipt = await request(base, actor, receiptUrl);
      assert.equal(receipt.body.status, 'committed');
      assert.equal(receipt.body.revision, saved.body.revision);
      assert.deepEqual((await request(base, foreign, receiptUrl)).body, { status: 'unknown' });
      const fresh = await request(base, actor, patientUrl);
      assert.equal(fresh.status, 200);
      assert.equal(fresh.body.patients[0].notes, 'Synthetic managed notes committed');
      assert.equal(cabinets[0].read().patients[0].notes, fresh.body.patients[0].notes);
      const competing = ['First', 'Second'].map((name) => ({
        id: randomUUID(),
        note: 'Synthetic managed CAS ' + name,
      }));
      const baseline = cabinets[0].read();
      const outcomes = await Promise.all(
        competing.map((change) =>
          request(
            base,
            actor,
            '/api/cabinet/changes',
            save(base, baseline, change.note, change.id),
          ),
        ),
      );
      assert.equal(outcomes.filter((row) => row.status === 200).length, 1);
      const rejected = outcomes.find((row) => row.status !== 200);
      assert.ok([409, 503].includes(rejected.status));
      const winner = outcomes.findIndex((row) => row.status === 200);
      let final = cabinets[0].read();
      assert.equal(final.revision, baseline.revision + 1);
      assert.deepEqual(final, {
        ...baseline,
        revision: baseline.revision + 1,
        patients: baseline.patients.map((row, index) =>
          index === 0 ? { ...row, notes: competing[winner].note } : row,
        ),
      });
      for (const [index, change] of competing.entries()) {
        const result = await request(
          base,
          actor,
          '/api/cabinet/operation?statusOnly=1&id=' + change.id,
        );
        assert.equal(result.body.status, index === winner ? 'committed' : 'unknown');
      }
      assert.equal(
        (await request(base, actor, patientUrl)).body.patients[0].notes,
        competing[winner].note,
      );
      // COMPOUND can refuse a contending same-organization writer before BEGIN.
      // A 503 is acceptable only with one exact commit, no failed receipt, and
      // a stale original-payload retry that becomes 409 rather than a replayed 200.
      const loser = competing[1 - winner];
      const staleRetry = await request(
        base,
        actor,
        '/api/cabinet/changes',
        save(base, baseline, loser.note, loser.id),
      );
      assert.equal(staleRetry.status, 409);
      assert.deepEqual(cabinets[0].read(), final);
      assert.deepEqual(cabinets[1].read(), untouched);
      assert.deepEqual(readOperationStatus(cabinets[0], { ...actor, role: 'owner' }, loser.id), {
        status: 'unknown',
      });
      assert.deepEqual(
        assertTopology((await server.rpc('stats')).status, server.pid, plan),
        initialTopology,
      );

      // Respect the established 16 MiB writer weight and compact-receipt limits.
      const importPatient = largePatient(
        actor.patientId + '-import',
        {
          firstName: 'Synthetic',
          lastName: 'Import',
          name: 'Synthetic Import',
          createdBy: actor.accountId,
        },
        100,
      );
      for (const visit of importPatient.visits) visit.id = 'import-' + visit.id;
      const importId = randomUUID();
      const importBody = {
        revision: final.revision,
        patients: [...final.patients, importPatient],
        services: final.services,
      };
      const importOptions = {
        method: 'PUT',
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          'X-Cartoteca-Operation': importId,
        },
        body: JSON.stringify(importBody),
      };
      assert.ok(Buffer.byteLength(importOptions.body) > 4000000);
      assert.ok(Buffer.byteLength(importOptions.body) * 3 < 16 * MiB);
      assert.ok(Buffer.byteLength(importOptions.body) < 50 * MiB);
      const beforeImportStatus = (await server.rpc('stats')).status;
      const imported = await request(base, actor, '/api/cabinet', importOptions, 60000);
      if (imported.status !== 200) {
        const afterImportStatus = (await server.rpc('stats')).status;
        const publicCode =
          typeof imported.body?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(imported.body.code)
            ? imported.body.code
            : null;
        t.diagnostic(
          JSON.stringify({
            phase: 'large-import-refusal',
            method: 'PUT',
            endpoint: '/api/cabinet',
            requestBytes: Buffer.byteLength(importOptions.body),
            status: imported.status,
            publicError:
              typeof imported.body?.error === 'string' ? imported.body.error.slice(0, 256) : null,
            code: publicCode,
            outcomeUnknown:
              typeof imported.body?.outcomeUnknown === 'boolean'
                ? imported.body.outcomeUnknown
                : null,
            before: {
              work: beforeImportStatus.memory.work,
              queries: {
                started: beforeImportStatus.queries.started,
                completed: beforeImportStatus.queries.completed,
              },
              commands: beforeImportStatus.commands,
            },
            after: {
              work: afterImportStatus.memory.work,
              queries: {
                started: afterImportStatus.queries.started,
                completed: afterImportStatus.queries.completed,
              },
              commands: afterImportStatus.commands,
            },
            ownersReady: afterImportStatus.owner.state === 'ready',
            ownerExitFlags: [
              afterImportStatus.owner.application,
              afterImportStatus.owner.background,
              ...afterImportStatus.owner.commands,
            ].map((row) => row.exited),
            revisionBefore: final.revision,
            revisionAfter: cabinets[0].read().revision,
            operationStatus: readOperationStatus(cabinets[0], { ...actor, role: 'owner' }, importId)
              .status,
          }),
        );
      }
      assert.equal(imported.status, 200);
      assert.equal(imported.body.revision, final.revision + 1);
      assert.deepEqual(
        jsonFingerprint(imported.body.patients),
        jsonFingerprint(importBody.patients),
      );
      const replayedImport = await request(base, actor, '/api/cabinet', importOptions, 60000);
      // A response over 1 MiB keeps its compact commit proof, not a second
      // clinical snapshot. The same operation ID must conflict, never commit twice.
      assert.equal(replayedImport.status, 409);
      assert.equal(cabinets[0].read().revision, imported.body.revision);
      assert.deepEqual(
        jsonFingerprint(cabinets[0].read().patients),
        jsonFingerprint(imported.body.patients),
      );
      const importedReceipt = await request(
        base,
        actor,
        '/api/cabinet/operation?statusOnly=1&id=' + importId,
      );
      assert.equal(importedReceipt.status, 200);
      assert.equal(importedReceipt.body.status, 'committed');
      assert.equal(importedReceipt.body.revision, imported.body.revision);
      assert.deepEqual(
        (await request(base, foreign, '/api/cabinet/operation?statusOnly=1&id=' + importId)).body,
        { status: 'unknown' },
      );
      // Seed the valid 32 MB read fixture through the existing controlled owner
      // on this same tiny PG. Its size is not an HTTP writer-admission claim.
      const afterImport = cabinets[0].read();
      const large = largePatient(actor.patientId + '-large', {
        firstName: 'Synthetic',
        lastName: 'Large',
        name: 'Synthetic Large',
        createdBy: actor.accountId,
      });
      const largeTextSha = textFingerprint(large);
      assert.equal(
        largeTextSha,
        '7c3c56a288ce6fe5cfadb4f27d12eaf24ada9ec0ef6aeb3a7610d1f1c778406d',
      );
      let seeded = cabinets[0].write({
        revision: afterImport.revision,
        patients: [...afterImport.patients, large],
        services: afterImport.services,
      });
      assert.equal(seeded.revision, afterImport.revision + 1);
      const largeUrl = '/api/cabinet/patient?id=' + large.id;
      assert.equal((await request(base, foreign, largeUrl)).status, 404);
      const expectedLarge = jsonFingerprint(large);
      // Exercise the reclaimed owner's memory as real overlapping physical work:
      // an unchanged 32 MiB card and an accepted ~4 MiB sparse manual mutation.
      const mixedBefore = cabinets[0].readSelected([actor.patientId], []);
      const mixedPatient = largePatient(actor.patientId, mixedBefore.patients[0], 100);
      for (const visit of mixedPatient.visits) visit.id = 'mixed-' + visit.id;
      const mixedId = randomUUID();
      const mixedBody = JSON.stringify({
        revision: mixedBefore.revision,
        patients: [{ id: actor.patientId, before: mixedBefore.patients[0], after: mixedPatient }],
        services: [],
      });
      assert.ok(Buffer.byteLength(mixedBody) > 4000000);
      assert.ok(Buffer.byteLength(mixedBody) * 3 < 16 * MiB);
      let mixedReadDone = false,
        mixedWriteDone = false;
      const mixedRead = request(base, actor, largeUrl, {}, 30000)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          mixedReadDone = true;
        });
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await server.rpc('stats')).status.queries.active) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const mixedWrite = request(
        base,
        actor,
        '/api/cabinet/changes',
        {
          method: 'PATCH',
          headers: {
            Origin: base,
            'Content-Type': 'application/json',
            'X-Cartoteca-Request': '1',
            'X-Cartoteca-Operation': mixedId,
          },
          body: mixedBody,
        },
        30000,
      )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          mixedWriteDone = true;
        });
      let overlapping = false,
        peakWorkBytes = 0,
        processRssPeak = 0;
      const mixedDeadline = Date.now() + 35000;
      while ((!mixedReadDone || !mixedWriteDone) && Date.now() < mixedDeadline) {
        const status = (await server.rpc('stats')).status;
        overlapping ||= status.queries.active > 0 && status.commands.active > 0;
        peakWorkBytes = Math.max(peakWorkBytes, status.memory.work.usedBytes);
        const reports = [
          status.memory.gateway,
          status.owner.application.memory,
          status.owner.background.memory,
          ...status.owner.commands.map((row) => row.memory),
        ];
        processRssPeak = Math.max(
          processRssPeak,
          reports.reduce((sum, report) => sum + (report?.main?.rssBytes || 0), 0),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const [largeMixed, writtenMixed] = await Promise.all([mixedRead, mixedWrite]);
      assert.equal(largeMixed.error, undefined);
      assert.equal(writtenMixed.error, undefined);
      assert.equal(largeMixed.value.status, 200);
      assert.equal(writtenMixed.value.status, 200);
      assert.deepEqual(jsonFingerprint(largeMixed.value.body.patients[0]), expectedLarge);
      assert.equal(overlapping, false, 'a full history PATCH takes the exclusive work window');
      assert.equal(peakWorkBytes, 1024 * MiB);
      const mixedReceipt = await request(
        base,
        actor,
        '/api/cabinet/operation?statusOnly=1&id=' + mixedId,
      );
      assert.equal(mixedReceipt.body.status, 'committed');
      assert.equal(mixedReceipt.body.revision, writtenMixed.value.body.revision);
      assert.deepEqual(
        assertTopology((await server.rpc('stats')).status, server.pid, plan),
        initialTopology,
      );
      // Restore the small card's payload explicitly so subsequent sparse-write
      // compatibility checks still exercise their original small body.
      const mixedAfter = cabinets[0].readSelected([actor.patientId], []);
      const restore = await request(
        base,
        actor,
        '/api/cabinet/changes',
        {
          method: 'PATCH',
          headers: {
            Origin: base,
            'Content-Type': 'application/json',
            'X-Cartoteca-Request': '1',
            'X-Cartoteca-Operation': randomUUID(),
          },
          body: JSON.stringify({
            revision: mixedAfter.revision,
            patients: [
              {
                id: actor.patientId,
                before: mixedAfter.patients[0],
                after: mixedBefore.patients[0],
              },
            ],
            services: [],
          }),
        },
        30000,
      );
      assert.equal(restore.status, 200);
      seeded = { ...seeded, revision: restore.body.revision };
      t.diagnostic(
        JSON.stringify({
          fullHistoryWriteExclusive: true,
          largeReadBytes: expectedLarge.bytes,
          manualBodyBytes: Buffer.byteLength(mixedBody),
          peakWorkBytes,
          sampledProcessRssSumPeakBytes: processRssPeak,
          rssIsNotCgroupOrHardBound: true,
          physicalIsolates: 14,
          fixtureCopied: false,
        }),
      );

      const simultaneousReads = await Promise.all([
        request(base, actor, largeUrl),
        request(base, actor, largeUrl),
      ]);
      for (const read of simultaneousReads) {
        assert.equal(read.status, 200);
        assert.equal(read.body.revision, seeded.revision);
        assert.deepEqual(jsonFingerprint(read.body.patients[0]), expectedLarge);
        assert.equal(textFingerprint(read.body.patients[0]), largeTextSha);
      }
      assert.deepEqual(
        assertTopology((await server.rpc('stats')).status, server.pid, plan),
        initialTopology,
      );
      importOptions.body = '';
      final = cabinets[0].read();
      assert.equal(
        final.revision,
        seeded.revision,
        'read-only materialization must not create a commit',
      );
      assert.deepEqual(cabinets[1].read(), untouched);
      // Keep a small card's manual SAVE independent of the large-card materialization.
      const manualId = randomUUID();
      const manual = await request(
        base,
        actor,
        '/api/cabinet/changes',
        save(base, final, 'Manual SAVE remains independent', manualId),
      );
      assert.equal(manual.status, 200);
      assert.equal(manual.body.revision, final.revision + 1);
      const manualReceipt = await request(
        base,
        actor,
        '/api/cabinet/operation?statusOnly=1&id=' + manualId,
      );
      assert.equal(manualReceipt.body.status, 'committed');
      assert.equal(manualReceipt.body.revision, manual.body.revision);
      final = cabinets[0].read();
      assert.equal(final.patients[0].notes, 'Manual SAVE remains independent');
      assert.deepEqual(
        jsonFingerprint(final.patients.find((row) => row.id === large.id)),
        expectedLarge,
      );
      assert.deepEqual(
        assertTopology((await server.rpc('stats')).status, server.pid, plan),
        initialTopology,
      );

      await f.admin.query(
        "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND account_id=$2",
        [f.profile.platformStoreId, actor.accountId],
      );
      const deniedId = randomUUID();
      const denied = await request(
        base,
        actor,
        '/api/cabinet/changes',
        save(base, final, 'Must never commit after revoke', deniedId),
      );
      assert.equal(denied.status, 401);
      assert.equal((await request(base, actor, patientUrl)).status, 401);
      assert.deepEqual(cabinets[0].read(), final);
      assert.deepEqual(cabinets[1].read(), untouched);
      assert.deepEqual(readOperationStatus(cabinets[0], { ...actor, role: 'owner' }, deniedId), {
        status: 'unknown',
      });
      assert.deepEqual(
        assertTopology((await server.rpc('stats')).status, server.pid, plan),
        initialTopology,
      );
      const closed = await server.rpc('close');
      assert.equal(closed.status.closeState, 'closed');
      assert.equal(closed.status.queries.closed, true);
      assert.equal(closed.status.queries.workers, 0);
      assert.ok(
        [
          closed.status.owner.application,
          closed.status.owner.background,
          ...closed.status.owner.commands,
        ].every((row) => row.exited),
      );
      assert.deepEqual(await server.exit, { code: 0, signal: null });
    } finally {
      await server.close();
      for (const cabinet of cabinets) cabinet.close();
      await controlled.close();
    }
  },
);
