const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createPackageStore } = require('../src/server/modules/billing/package-store.cjs');
const { packageSchema } = require('../src/server/modules/billing/package-schema.cjs');
const {
  serviceConnectionSchema,
} = require('../src/server/modules/billing/entitlements-schema.cjs');
const { createAssistantTaskQuota } = require('../src/server/modules/assistant/access/task-quota.cjs');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `PRAGMA foreign_keys=ON;CREATE TABLE accounts(id TEXT PRIMARY KEY,global_admin INTEGER,status TEXT);CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);CREATE TABLE subscriptions(organization_id TEXT PRIMARY KEY,status TEXT);CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT);INSERT INTO accounts VALUES('admin',1,'active'),('owner',0,'active');INSERT INTO organizations VALUES('org','active');INSERT INTO subscriptions VALUES('org','active');INSERT INTO memberships VALUES('org','owner','owner','active');`,
  );
  db.exec(serviceConnectionSchema + packageSchema);
  let instant = Date.parse('2026-01-01T12:00:00Z');
  const transaction = (cb) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = cb();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const context = {
    db,
    transaction,
    seal: (value) => Buffer.from(JSON.stringify(value)),
    open: (value) => JSON.parse(Buffer.from(value).toString('utf8')),
    now: () => instant,
  };
  const packages = createPackageStore(context);
  context.billing = { packages };
  const command = (extra) => ({
    requestId: crypto.randomUUID(),
    reason: 'Synthetic quota setup',
    ...extra,
  });
  packages.savePackage(
    'admin',
    command({
      id: 'one-task',
      title: 'Synthetic one task',
      priceKopecks: 1000,
      taskLimit: 1,
      enabled: true,
      expectedRevision: 0,
    }),
  );
  packages.grantTrial('admin', command({ orgId: 'org', packageId: 'one-task' }));
  const entry = { version: 0, complete: false, cancelled: false };
  const dialogues = {
    get(c, member, state, id) {
      if (id !== 'synthetic-dialogue')
        throw Object.assign(Error('Synthetic missing dialogue'), { status: 409 });
      return entry;
    },
  };
  const fresh = { scope: { billing: { paid: true } }, member: {}, state: { revision: 1 } };
  const scope = () => fresh;
  const quota = createAssistantTaskQuota(context, dialogues, scope),
    c = {
      current: {
        organizationId: 'org',
        accountId: 'owner',
        sessionId: 'synthetic-session',
        role: 'owner',
      },
    };
  const body = () => ({ policyVersion: 1, taskRequestId: crypto.randomUUID() });
  t.after(() => db.close());
  return {
    packages,
    quota,
    c,
    entry,
    fresh,
    body,
    setNow: (value) => {
      instant = Date.parse(value);
    },
  };
}
const status = (code) => (error) => error.status === code;
test('legacy pilot never touches a package store and retains existing unmetered command shape', () => {
  const quota = createAssistantTaskQuota({}, null, () => ({ scope: {} })),
    c = {};
  assert.equal(quota.begin(c, { policyVersion: 1 }, 'Synthetic command'), null);
  quota.authorizeSpeech(c, { policyVersion: 1 });
  quota.transcribe(c, {}, { scope: {} });
  assert.deepEqual(quota.complete(null, c, { text: 'Synthetic' }), { text: 'Synthetic' });
});
test('last task is counted once and its continuation returns the original anchored request id', (t) => {
  const f = fixture(t),
    body = f.body(),
    task = f.quota.begin(f.c, body, 'Synthetic command');
  f.quota.outbound(task);
  const response = f.quota.complete(task, f.c, {
    policyVersion: 1,
    dialogue: { id: 'synthetic-dialogue' },
  });
  assert.equal(response.taskRequestId, body.taskRequestId);
  assert.equal(f.packages.status('org').remainingTasks, 0);
  assert.equal(f.packages.status('org').usedTasks, 1);
  assert.equal(
    f.quota.continuation(f.c, { ...f.body(), dialogueId: 'synthetic-dialogue' }, f.entry),
    body.taskRequestId,
  );
  assert.throws(
    () => f.quota.begin(f.c, body, 'Synthetic command'),
    (error) => error.code === 'TASK_ALREADY_COUNTED',
  );
  assert.throws(() => f.quota.begin(f.c, f.body(), 'A separate task'), status(402));
});
test('zero remaining quota blocks initial recognition but allows the owned unfinished dialogue', (t) => {
  const f = fixture(t),
    body = f.body(),
    task = f.quota.begin(f.c, body, 'Synthetic command');
  f.quota.outbound(task);
  f.quota.complete(task, f.c, { policyVersion: 1, dialogue: { id: 'synthetic-dialogue' } });
  assert.throws(() => f.quota.transcribe(f.c, f.body(), f.fresh), status(402));
  f.quota.transcribe(
    f.c,
    { policyVersion: 1, dialogueId: 'synthetic-dialogue', dialogueVersion: 0 },
    f.fresh,
  );
  assert.throws(
    () =>
      f.quota.transcribe(
        f.c,
        { policyVersion: 1, dialogueId: 'synthetic-dialogue', dialogueVersion: 1 },
        f.fresh,
      ),
    status(409),
  );
  f.entry.complete = true;
  assert.throws(
    () =>
      f.quota.transcribe(
        f.c,
        { policyVersion: 1, dialogueId: 'synthetic-dialogue', dialogueVersion: 0 },
        f.fresh,
      ),
    status(409),
  );
});
test('speech after the last task accepts only the exact issued answer and owned session', (t) => {
  const f = fixture(t),
    body = f.body(),
    task = f.quota.begin(f.c, body, 'Synthetic command');
  f.quota.outbound(task);
  const response = f.quota.complete(task, f.c, {
    text: 'Синтетический ответ.',
    policyVersion: 1,
    dialogue: { id: 'synthetic-dialogue' },
  });
  const speech = {
    ...body,
    text: response.speechPermit.answerableText,
    speechToken: response.speechPermit.token,
  };
  f.quota.authorizeSpeech(f.c, speech);
  assert.throws(
    () => f.quota.authorizeSpeech(f.c, { ...speech, text: 'Произвольный другой текст.' }),
    status(403),
  );
  assert.throws(
    () => f.quota.authorizeSpeech(f.c, { ...speech, speechToken: undefined }),
    status(403),
  );
  assert.throws(() => f.quota.authorizeSpeech(f.c, { ...speech, ...f.body() }), status(402));
  assert.throws(
    () =>
      f.quota.authorizeSpeech(
        { current: { ...f.c.current, sessionId: 'foreign-session' } },
        speech,
      ),
    status(402),
  );
  assert.equal(f.packages.status('org').usedTasks, 1);
});

test('failure before outbound releases the unit while uncertain outbound consumes exactly one', (t) => {
  const f = fixture(t),
    body = f.body(),
    first = f.quota.begin(f.c, body, 'Synthetic command');
  f.quota.failed(first);
  assert.equal(f.packages.status('org').remainingTasks, 1);
  const second = f.quota.begin(f.c, body, 'Synthetic command');
  assert.equal(second.ticket.attempt, 2);
  f.quota.outbound(second);
  f.quota.failed(second);
  f.quota.failed(second);
  assert.equal(f.packages.status('org').usedTasks, 1);
  assert.equal(
    f.packages.requireAcceptedTask({ current: f.c.current, requestId: body.taskRequestId }).state,
    'uncertain',
  );
});
test('an accepted task cannot authorize speech or continuation after its calendar period expires', (t) => {
  const f = fixture(t),
    body = f.body(),
    task = f.quota.begin(f.c, body, 'Synthetic command');
  f.quota.outbound(task);
  f.quota.complete(task, f.c, { policyVersion: 1, dialogue: { id: 'synthetic-dialogue' } });
  f.setNow('2026-02-01T12:00:00Z');
  assert.throws(() => f.quota.authorizeSpeech(f.c, body), status(402));
  assert.throws(() => f.quota.continuation(f.c, { policyVersion: 1 }, f.entry), status(402));
});

test('execution proof survives outbound acceptance and produces final speech only after commit', async (t) => {
  const f = fixture(t),
    body = f.body(),
    task = f.quota.begin(f.c, body, 'Synthetic command');
  f.quota.outbound(task);
  f.quota.complete(task, f.c, {
    text: 'Проверьте запись.',
    policyVersion: 1,
    action: { type: 'createAppointment', executionId: 'synthetic-dialogue' },
  });
  const proof = f.packages.requireAcceptedTask({
    current: f.c.current,
    dialogueId: 'synthetic-dialogue',
  });
  assert.equal(proof.requestId, body.taskRequestId);
  let committed = false;
  const response = await f.quota.execute(
    f.c,
    { policyVersion: 1, executionId: 'synthetic-dialogue' },
    async () => {
      committed = true;
      return {
        saved: true,
        text: 'Запись сохранена.',
        policyVersion: 1,
        action: { type: 'calendar' },
      };
    },
  );
  assert.equal(committed, true);
  assert.equal(response.speechPermit.handoffText, 'Запись сохранена.');
  f.quota.authorizeSpeech(f.c, {
    ...body,
    text: response.speechPermit.handoffText,
    speechToken: response.speechPermit.token,
  });
  assert.equal(f.packages.status('org').usedTasks, 1);
  await assert.rejects(
    f.quota.execute(
      { current: { ...f.c.current, sessionId: 'foreign-session' } },
      { policyVersion: 1, executionId: 'synthetic-dialogue' },
      async () => assert.fail('Must not execute'),
    ),
    status(402),
  );
});

test('session cleanup revokes speech without releasing already accepted quota', (t) => {
  const f = fixture(t),
    body = f.body(),
    task = f.quota.begin(f.c, body, 'Synthetic command');
  f.quota.outbound(task);
  const response = f.quota.complete(task, f.c, { text: 'Синтетический ответ.', policyVersion: 1 });
  f.quota.clearSession(f.c.current.sessionId);
  assert.throws(
    () =>
      f.quota.authorizeSpeech(f.c, {
        ...body,
        text: response.text,
        speechToken: response.speechPermit.token,
      }),
    status(403),
  );
  assert.equal(f.packages.status('org').usedTasks, 1);
});
