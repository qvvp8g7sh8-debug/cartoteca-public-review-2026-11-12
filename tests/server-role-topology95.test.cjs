// Finite synthetic child-process proof, not a capacity or latency benchmark.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { mixed95Fixture } = require('./helpers/mixed95-fixture.cjs');
const { spawnRole, command, api, waitFor, stopPair } = require('./helpers/mixed95-children.cjs');
const { aggregate } = require('../scripts/benchmark-mixed95-server.cjs');
const { editable } = require('../src/server/modules/cabinet/changes.cjs');
const { socketPath } = require('../scripts/benchmark-mixed95-profile.cjs');

async function pair(f, backgroundFirst = false) {
  if (f.job.topology === 'combined') {
    const sut = spawnRole(f, 'sut');
    await sut.ready;
    return { web: sut, background: sut };
  }
  const first = backgroundFirst ? 'background' : 'api',
    second = backgroundFirst ? 'api' : 'background';
  const a = spawnRole(f, first);
  await a.ready;
  const b = spawnRole(f, second);
  await b.ready;
  return first === 'api' ? { web: a, background: b } : { web: b, background: a };
}
async function startPair(f) {
  await command(f, f.job.topology === 'combined' ? 'sut' : 'api', 'start');
  if (f.job.topology === 'split') await command(f, 'background', 'start');
}
function count(f, table, clause = '') {
  return f.database.db.prepare('SELECT count(*) n FROM ' + table + ' ' + clause).get().n;
}
const successfulChannels = (f) =>
  ['telegram', 'max'].every(
    (channel) =>
      f.database.db
        .prepare(
          "SELECT count(*) n FROM notification_channel_jobs WHERE channel=? AND status='sent'",
        )
        .get(channel).n > 0,
  );
async function saveAndReplay(f) {
  const actor = f.fixture.actors[0],
    state = await api(f, '/api/cabinet/patient?id=' + actor.patient);
  assert.equal(state.status, 200);
  const before = editable(state.body).patients[0],
    after = structuredClone(before);
  after.appointments[0].notes = 'Synthetic95 manual edit';
  const body = {
      revision: state.body.revision,
      patients: [{ id: actor.patient, before, after }],
      services: [],
    },
    operationId = randomUUID();
  const saved = await api(f, '/api/cabinet/changes', { method: 'PATCH', body, operationId });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const replay = await api(f, '/api/cabinet/changes', { method: 'PATCH', body, operationId });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, saved.body);
  const receipt = await api(f, '/api/cabinet/operation?id=' + operationId);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.status, 'committed');
  assert.equal(receipt.body.result.patients[0].appointments[0].notes, after.appointments[0].notes);
  const foreign = await api(f, '/api/cabinet/patient?id=' + f.fixture.actors[3].patient);
  assert.ok(
    [403, 404].includes(foreign.status),
    'Cross-organization patient lookup must remain denied',
  );
  const own = await api(f, '/api/cabinet/patient?id=' + actor.patient);
  assert.equal(own.body.patients[0].appointments[0].notes, after.appointments[0].notes);
}
async function webhook(f, event) {
  const result = await fetch(f.base + '/api/max/webhook', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: {
      'Content-Type': 'application/json',
      'X-Max-Bot-Api-Secret': 'synthetic-notification-harness-secret-00000001',
    },
    body: JSON.stringify(event),
  });
  return { status: result.status, body: await result.json() };
}
async function confirm(f, child, retry) {
  const sent = await waitFor(() =>
    child.messages.find((value) => value.event === 'mixed95-functional-max-send'),
  );
  const event = {
    update_type: 'message_callback',
    timestamp: Date.now(),
    callback: {
      callback_id: randomUUID(),
      payload: 'confirm_' + sent.token,
      user: { user_id: sent.userId, is_bot: false },
    },
    message: { recipient: { chat_type: 'dialog', user_id: sent.userId }, body: { mid: sent.mid } },
  };
  const accepted = await webhook(f, event);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.repeated, false);
  await waitFor(() => count(f, 'notification_confirmations') === 1);
  if (retry)
    await waitFor(() =>
      f.database.db
        .prepare('SELECT status,attempt FROM max_event_inbox')
        .all()
        .some((row) => row.status === 'pending' && row.attempt === 1),
    );
  await waitFor(() => count(f, 'max_event_inbox', "WHERE status='done'") === 1, 14000);
  assert.equal(count(f, 'notification_confirmations'), 1);
  assert.equal(count(f, 'platform_audit', "WHERE event='notification_appointment_confirmed'"), 1);
  const duplicate = await webhook(f, event);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.repeated, true);
  const conflict = await webhook(f, { ...event, timestamp: event.timestamp + 1 });
  assert.equal(conflict.status, 409);
  assert.equal(count(f, 'notification_confirmations'), 1);
  const client = f.manifest.clients.find((row) => row.max === sent.userId),
    actor = f.fixture.actors.find((row) => row.org === client.organization && row.role === 'owner');
  const card = await api(f, '/api/cabinet/patient?id=' + actor.patient, { actor });
  assert.equal(card.status, 200);
  assert.ok(card.body.patients[0].appointments[0].notificationConfirmedAt);
  assert.equal(card.body.patients[0].appointments[0].notificationConfirmedChannel, 'max');
}
function validateStopped(f, receipts) {
  const result = aggregate(f.job, receipts.web.snapshot, receipts.background.snapshot);
  assert.equal(result.rolesCorrect, true);
  assert.equal(result.notifications.inFlight, 0);
  assert.ok(Object.hasOwn(result.notificationQueue.queues, 'max_event_inbox'));
  assert.equal(result.roles.background.applicationListening, f.job.topology === 'combined');
  return result;
}

test(
  'actual split children: API-first, manual commit/replay, native MAX inbox, real Push timer and HTTP after finite stop',
  { timeout: 60000 },
  async (t) => {
    const f = await mixed95Fixture(t),
      children = await pair(f);
    const readyWeb = await command(f, 'api', 'ready'),
      readyBg = await command(f, 'background', 'ready');
    assert.notEqual(readyWeb.pid, readyBg.pid);
    assert.equal(readyBg.applicationListening, false);
    assert.equal(readyBg.background.active, true);
    assert.equal(readyWeb.background.active, false);
    assert.deepEqual(readyWeb.providerIdentity, readyBg.providerIdentity);
    await saveAndReplay(f);
    await startPair(f);
    await confirm(f, children.background, false);
    await waitFor(
      () => successfulChannels(f) && count(f, 'staff_push_jobs', "WHERE status='sent'") > 0,
      24000,
    );
    const result = validateStopped(f, await stopPair(f));
    assert.ok(result.notifications.counters.push.acknowledged > 0);
    assert.equal(
      result.roles.background.notificationQueue.queues.max_event_inbox.find(
        (row) => row.status === 'done',
      ).jobs,
      1,
    );
    assert.equal((await api(f, '/api/auth/session')).status, 200);
    assert.equal(
      (await api(f, '/api/cabinet/patient?id=' + f.fixture.actors[0].patient)).status,
      200,
    );
    await assert.rejects(command(f, 'background', 'start'), /Background control failed/);
    f.complete();
  },
);

test(
  'actual split background-first: durable MAX callback result retries answer without a second confirmation',
  { timeout: 40000 },
  async (t) => {
    const f = await mixed95Fixture(t, 'split', 'max-answer-retry'),
      children = await pair(f, true);
    await startPair(f);
    await confirm(f, children.background, true);
    const result = validateStopped(f, await stopPair(f));
    assert.equal(result.roles.background.transportProof.faults, 1);
    assert.equal(result.roles.background.transportProof.answers, 2);
    assert.equal(
      result.roles.background.notificationQueue.queues.max_event_inbox.find(
        (row) => row.status === 'done',
      ).jobs,
      1,
    );
    f.complete();
  },
);

test(
  'actual combined child uses identical coordinator and deduplicates process accounting while HTTP survives stop',
  { timeout: 40000 },
  async (t) => {
    const f = await mixed95Fixture(t, 'combined');
    await pair(f);
    await saveAndReplay(f);
    await startPair(f);
    await waitFor(
      () => successfulChannels(f) && count(f, 'staff_push_jobs', "WHERE status='sent'") > 0,
      24000,
    );
    const result = validateStopped(f, await stopPair(f));
    assert.equal(result.aggregateCPU.uniqueProcesses, 1);
    assert.equal(result.roles.colocated, true);
    assert.ok(result.notifications.counters.telegram.acknowledged > 0);
    assert.ok(result.notifications.counters.max.acknowledged > 0);
    assert.equal((await api(f, '/api/auth/session')).status, 200);
    f.complete();
  },
);

test(
  'actual split cancellation and fresh membership revoke suppress stale jobs; synthetic429 preserves real pacing',
  { timeout: 40000 },
  async (t) => {
    const f = await mixed95Fixture(t, 'split', 'telegram429');
    await pair(f);
    const actor = f.fixture.actors[0],
      staff = f.fixture.actors[2],
      state = await api(f, '/api/cabinet/patient?id=' + actor.patient);
    const appointment = editable(state.body).patients[0].appointments[0];
    const cancelled = await api(f, '/api/cabinet/appointments', {
      method: 'POST',
      operationId: randomUUID(),
      body: {
        revision: state.body.revision,
        patientId: actor.patient,
        changes: [
          {
            id: appointment.id,
            before: appointment,
            after: { ...appointment, status: 'cancelled' },
          },
        ],
      },
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    await f.createRequest('synthetic-fifo-one');
    await f.createRequest('synthetic-fifo-two');
    f.database.db
      .prepare("UPDATE memberships SET status='suspended' WHERE account_id=? AND organization_id=?")
      .run(staff.id, staff.org);
    assert.ok(
      [401, 403].includes(
        (await api(f, '/api/cabinet/patient?id=' + staff.patient, { actor: staff })).status,
      ),
    );
    await startPair(f);
    await waitFor(
      () =>
        successfulChannels(f) &&
        count(f, 'staff_notification_jobs', "WHERE status='cancelled'") >= 2,
      18000,
    );
    const result = validateStopped(f, await stopPair(f)),
      proof = result.roles.background.transportProof;
    assert.equal(proof.faults, 1);
    const starts = proof.trace.filter(
      (row) => row.channel === 'telegram' && row.kind === 'sends' && row.outcome === 'started',
    );
    assert.ok(starts.length >= 2);
    assert.ok(
      starts[1].timeMs - starts[0].timeMs >= 950,
      '429 must retain genuine shared channel pause',
    );
    // Staff messages may legitimately share the owner's recipient. Check the
    // authoritative client queue rather than conflating those separate deliveries.
    assert.equal(
      f.database.db
        .prepare(
          "SELECT count(*) n FROM notification_channel_jobs WHERE organization_id=? AND patient_id=? AND status='sent'",
        )
        .get(actor.org, actor.patient).n,
      0,
    );
    const deniedRecipient = require('../scripts/benchmark-mixed95-profile.cjs').digest(
      f.manifest.staffReceivers.find((row) => row.channel === 'max' && row.accountId === staff.id)
        .recipient,
    );
    assert.equal(
      proof.trace.some(
        (row) =>
          row.channel === 'max' &&
          row.recipientHash === deniedRecipient &&
          row.outcome === 'completed',
      ),
      false,
    );
    f.complete();
  },
);

test(
  'actual background child loses the native lease, retains diagnostic and cannot acquire authority from delayed work',
  { timeout: 40000 },
  async (t) => {
    const f = await mixed95Fixture(t, 'split', 'slow-telegram'),
      children = await pair(f);
    const duplicate = spawnRole(f, 'background');
    await assert.rejects(duplicate.ready, /exited before ready/);
    assert.equal(
      (await command(f, 'background', 'ready')).background.active,
      true,
      'A refused duplicate cannot release or replace the original owner lease',
    );
    await startPair(f);
    await waitFor(() => count(f, 'notification_channel_jobs', "WHERE status='sending'") > 0);
    f.database.db
      .prepare("DELETE FROM telegram_runtime WHERE key='application-process-roles'")
      .run();
    await waitFor(
      () =>
        children.background.messages.some((row) => row.event === 'mixed95-functional-lease-lost'),
      18000,
    );
    const lost = JSON.parse(
      fs.readFileSync(path.join(f.controlDirectory, 'background-lease-lost.json')),
    ).value;
    assert.equal(lost.background.state, 'lease-lost');
    assert.equal(lost.background.active, false);
    await f.createRequest('synthetic-after-lease-loss');
    await sleep(600);
    const receipts = await stopPair(f),
      snapshot = receipts.background.snapshot;
    assert.equal(snapshot.background.state, 'lease-lost');
    assert.equal(snapshot.transportProof.sends, lost.transportProof.sends);
    assert.equal(snapshot.transportProof.polls, lost.transportProof.polls);
    assert.equal(snapshot.transportProof.active, 0);
    assert.equal((await api(f, '/api/auth/session')).status, 200);
    f.complete();
  },
);

test(
  'actual slow outbound is aborted by finite owner stop before it can acknowledge or start new work',
  { timeout: 30000 },
  async (t) => {
    const f = await mixed95Fixture(t, 'split', 'slow-telegram');
    await pair(f);
    await startPair(f);
    await waitFor(() => count(f, 'notification_channel_jobs', "WHERE status='sending'") > 0);
    const receipts = await stopPair(f),
      result = validateStopped(f, receipts),
      proof = result.roles.background.transportProof;
    assert.equal(proof.active, 0);
    assert.equal(result.notifications.counters.telegram.acknowledged, 0);
    assert.ok(
      proof.trace.some((row) => row.channel === 'telegram' && row.outcome === 'error-AbortError'),
    );
    assert.equal((await api(f, '/api/auth/session')).status, 200);
    f.complete();
  },
);

test(
  'partial combined startup closes HTTP and its native lease when the owned control endpoint is occupied',
  { timeout: 25000 },
  async (t) => {
    const f = await mixed95Fixture(t, 'combined'),
      occupied = net.createServer();
    await new Promise((resolve) => occupied.listen(socketPath(f.job, 'sut'), resolve));
    try {
      const child = spawnRole(f, 'sut');
      await assert.rejects(child.ready, /exited before ready/);
      assert.equal(
        f.database.db
          .prepare("SELECT 1 FROM telegram_runtime WHERE key='application-process-roles'")
          .get(),
        undefined,
      );
      await assert.rejects(
        fetch(f.base + '/api/auth/session', { signal: AbortSignal.timeout(2000) }),
      );
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
    f.complete();
  },
);
