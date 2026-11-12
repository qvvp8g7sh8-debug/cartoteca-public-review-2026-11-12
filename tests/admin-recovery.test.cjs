const test = require('node:test'),
  assert = require('node:assert/strict');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createAdminEmailRuntime } = require('../src/server/modules/admin/email-queue.cjs');

function prepare(f, email = 'replacement@admin.test') {
  const body = f.command('account', f.owner.accountId, { email, identityConfirmed: true });
  return f.store.admin.prepareEmailRecovery(
    f.admin.accountId,
    f.owner.accountId,
    body,
    'https://synthetic.test',
  );
}
const tokenOf = (job) => decodeURIComponent(new URL(job.payload.link).hash.split('=')[1]);

test('pending email recovery preserves old login; confirmation preserves password and revokes stale credentials', async (t) => {
  const f = await adminFixture(t),
    original = f.database.open(
      f.database.db.prepare('SELECT value FROM accounts WHERE id=?').get(f.owner.accountId).value,
    );
  const reset = f.store.requestPasswordReset('owner@admin.test');
  const result = prepare(f);
  assert.equal(result.pending, true);
  assert.equal('token' in result || 'link' in result, false);
  assert.ok(f.store.session(f.ownerSession.token));
  const job = f.store.admin.emailQueue.claim(),
    token = tokenOf(job);
  assert.equal(f.store.admin.emailQueue.allowed(job), true);
  assert.equal(f.store.admin.confirmEmailRecovery(token).ok, true);
  assert.equal(f.store.admin.confirmEmailRecovery(token).ok, true);
  assert.equal(f.store.session(f.ownerSession.token), null);
  const fresh = f.database.open(
    f.database.db.prepare('SELECT value FROM accounts WHERE id=?').get(f.owner.accountId).value,
  );
  assert.equal(fresh.passwordHash, original.passwordHash);
  assert.equal(fresh.salt, original.salt);
  assert.equal(fresh.email, 'replacement@admin.test');
  assert.equal(fresh.emailVerified, true);
  await assert.rejects(() => f.store.resetPassword(reset, 'Other-synthetic-password-2026'), {
    status: 400,
  });
  assert.equal(
    (await f.store.login('replacement@admin.test', f.password)).account.id,
    f.owner.accountId,
  );
  await assert.rejects(() => f.store.login('owner@admin.test', f.password), { status: 401 });
});

test('recovery requires identity check, unique email and non-global target; cancellation or expiry invalidates token', async (t) => {
  const f = await adminFixture(t),
    account = f.owner.accountId;
  const body = f.command('account', account, {
    email: 'other@admin.test',
    identityConfirmed: true,
  });
  assert.throws(
    () =>
      f.store.admin.prepareEmailRecovery(
        f.admin.accountId,
        account,
        body,
        'https://synthetic.test',
      ),
    { status: 409 },
  );
  assert.throws(
    () =>
      f.store.admin.prepareEmailRecovery(
        f.admin.accountId,
        account,
        { ...body, identityConfirmed: false },
        'https://synthetic.test',
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      f.store.admin.prepareEmailRecovery(
        f.admin.accountId,
        f.admin.accountId,
        f.command('account', f.admin.accountId, {
          email: 'another@admin.test',
          identityConfirmed: true,
        }),
        'https://synthetic.test',
      ),
    { status: 403 },
  );
  prepare(f);
  const job = f.store.admin.emailQueue.claim(),
    token = tokenOf(job);
  f.store.admin.cancelEmailRecovery(f.admin.accountId, account, f.command('account', account));
  assert.throws(() => f.store.admin.confirmEmailRecovery(token), { status: 400 });
  assert.equal(f.store.admin.emailQueue.allowed(job), false);
  const next = prepare(f, 'next@admin.test');
  f.database.db
    .prepare('UPDATE admin_email_recoveries SET expires_at=1 WHERE id=?')
    .run(next.recoveryId);
  assert.equal(f.store.admin.account(f.admin.accountId, account).recovery, null);
});

test('target revision, changed uniqueness or revoked operator prevents stale recovery completion', async (t) => {
  const f = await adminFixture(t);
  prepare(f);
  const job = f.store.admin.emailQueue.claim(),
    token = tokenOf(job);
  f.store.admin.revokeSessions(
    f.admin.accountId,
    f.owner.accountId,
    f.command('account', f.owner.accountId),
  );
  assert.equal(f.store.admin.emailQueue.allowed(job), false);
  assert.throws(() => f.store.admin.confirmEmailRecovery(token), { status: 409 });
  assert.equal(
    f.store.admin.account(f.admin.accountId, f.owner.accountId).email,
    'owner@admin.test',
  );
  f.database.db.prepare("UPDATE accounts SET status='suspended' WHERE id=?").run(f.admin.accountId);
  assert.throws(() => f.store.admin.confirmEmailRecovery(token), { status: 403 });
});

test('operator reauthentication is rate-limited separately and does not change user login limits', async (t) => {
  const f = await adminFixture(t);
  await assert.rejects(
    () => f.store.admin.verifyActor(f.admin.accountId, 'wrong', 'synthetic-IP'),
    { status: 401 },
  );
  await f.store.admin.verifyActor(f.admin.accountId, f.password, 'synthetic-IP');
  assert.equal(
    f.database.db
      .prepare("SELECT count(*) n FROM login_limits WHERE key LIKE 'admin-reauth-%'")
      .get().n,
    0,
  );
  for (let index = 0; index < 4; index++)
    await assert.rejects(
      () => f.store.admin.verifyActor(f.admin.accountId, 'wrong', 'synthetic-IP'),
      { status: 401 },
    );
  await assert.rejects(
    () => f.store.admin.verifyActor(f.admin.accountId, 'wrong', 'synthetic-IP'),
    { status: 429 },
  );
  await assert.rejects(
    () => f.store.admin.verifyActor(f.admin.accountId, f.password, 'synthetic-IP'),
    { status: 429 },
  );
  assert.equal((await f.store.login('owner@admin.test', f.password)).account.id, f.owner.accountId);
});

test('confirmation budgets persist across reopen and never extend the blocking window on rejected requests', async (t) => {
  const f = await adminFixture(t);
  for (let i = 0; i < 20; i++) f.store.admin.consumeConfirmation('limited-client');
  assert.throws(() => f.store.admin.consumeConfirmation('limited-client'), { status: 429 });
  const before = f.database.db
    .prepare("SELECT blocked_until FROM login_limits WHERE key LIKE 'email-confirm-client:%'")
    .get().blocked_until;
  f.reopen();
  assert.throws(() => f.store.admin.consumeConfirmation('limited-client'), { status: 429 });
  const after = f.database.db
    .prepare("SELECT blocked_until FROM login_limits WHERE key LIKE 'email-confirm-client:%'")
    .get().blocked_until;
  assert.equal(before, after);
});

test('email leases serialize workers, retry failures durably and reject an obsolete lease', async (t) => {
  const f = await adminFixture(t);
  prepare(f);
  const queue = f.store.admin.emailQueue,
    first = queue.claim();
  assert.equal(queue.claim(), null);
  const second = queue.claim(Date.now() + 120001);
  assert.equal(second.id, first.id);
  assert.notEqual(second.leaseId, first.leaseId);
  assert.equal(queue.finish(first, 'sent'), false);
  assert.equal(queue.finish(second, 'pending', Date.now()), true);
  const messages = [];
  let failing = true;
  const runtime = createAdminEmailRuntime({
    queue,
    sendMail: async (email, link, metadata) => {
      messages.push({ email, link, metadata });
      if (failing) throw Error('Synthetic SMTP failure');
    },
  });
  await runtime.tick();
  assert.equal(queue.statuses(first.payload.recoveryId)[0].status, 'pending');
  failing = false;
  f.database.db.prepare("UPDATE admin_email_jobs SET next_at=0 WHERE status='pending'").run();
  await runtime.tick();
  assert.equal(queue.statuses(first.payload.recoveryId)[0].status, 'sent');
  assert.equal(messages.length, 2);
  assert.equal(
    f.store.admin.account(f.admin.accountId, f.owner.accountId).email,
    'owner@admin.test',
  );
});

test('email worker stops after five failures and retains an unknown stopped send if settlement storage is unavailable', async (t) => {
  const f = await adminFixture(t),
    recovery = prepare(f);
  let sends = 0;
  const runtime = createAdminEmailRuntime({
    queue: f.store.admin.emailQueue,
    sendMail: async () => {
      sends++;
      throw Error('Synthetic persistent delivery failure');
    },
  });
  for (let i = 0; i < 6; i++) {
    f.database.db.prepare("UPDATE admin_email_jobs SET next_at=0 WHERE status='pending'").run();
    await runtime.tick();
  }
  assert.equal(sends, 5);
  assert.equal(f.store.admin.emailQueue.statuses(recovery.recoveryId)[0].status, 'failed');
  f.store.admin.cancelEmailRecovery(
    f.admin.accountId,
    f.owner.accountId,
    f.command('account', f.owner.accountId),
  );
  prepare(f, 'second@admin.test');
  let resolveSend, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const queue = f.store.admin.emailQueue,
    settlements = [];
  const paused = createAdminEmailRuntime({
    queue: {
      ...queue,
      finish(...args) {
        settlements.push(args[1]);
        return queue.finish(...args);
      },
    },
    sendMail: () => {
      started();
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    },
  });
  const pending = paused.tick();
  await entered;
  assert.equal(typeof resolveSend, 'function');
  paused.stop();
  f.reopen();
  resolveSend();
  await pending;
  assert.equal(paused.status().busy, false);
  assert.deepEqual(
    settlements,
    ['sent'],
    'a failed known ACK write is never retried as transport failure',
  );
  assert.equal(
    f.database.db.prepare("SELECT count(*) n FROM admin_email_jobs WHERE status='sending'").get().n,
    1,
  );
});
