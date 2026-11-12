const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  createSpeechTickets,
} = require('../src/server/modules/assistant/speech/speech-tickets.cjs');
const {
  createSpeechPermits,
} = require('../src/server/modules/assistant/speech/speech-permits.cjs');
const {
  createAssistantTaskQuota,
} = require('../src/server/modules/assistant/access/task-quota.cjs');

function fixture() {
  let instant = 1000;
  const state = {
    revision: 1,
    providers: { tts: { provider: 'timeweb', model: 'synthetic', voice: 'ru' } },
    credentials: { timeweb: 'synthetic-credential' },
    policy: { limits: { maxReplyChars: 600 } },
  };
  const member = { membershipId: 'synthetic-membership' };
  const c = (index) => ({
    current: {
      organizationId: 'synthetic-org-' + index,
      accountId: 'synthetic-account-' + index,
      sessionId: 'synthetic-session-' + index,
      role: 'owner',
      expiresAt: Date.now() + 3600000,
    },
  });
  const ticket = { id: randomUUID(), grantId: randomUUID(), attempt: 1, requestId: randomUUID() };
  const response = { text: 'Синтетический ответ.', policyVersion: 1 };
  return {
    state,
    member,
    c,
    ticket,
    response,
    now: () => instant,
    advance(ms) {
      instant += ms;
    },
    scope: () => ({ state, member }),
  };
}
const id = (url) => new URL(url, 'http://synthetic.test').searchParams.get('ticket');

test('global speech-ticket capacity rejects new audio admission while retaining ownership and single use of existing tickets', () => {
  const f = fixture(),
    tickets = createSpeechTickets({ now: f.now, capacity: 2 });
  const first = id(tickets.issue(f.c(1), f.state, f.member, 'Первый ответ'));
  const second = id(tickets.issue(f.c(2), f.state, f.member, 'Второй ответ'));
  assert.throws(() => tickets.issue(f.c(3), f.state, f.member, 'Третий ответ'), {
    status: 503,
    code: 'ASSISTANT_SPEECH_TICKET_CAPACITY',
    outcomeUnknown: false,
  });
  assert.throws(() => tickets.take(f.c(3), first, f.scope), { status: 403 });
  assert.equal(tickets.take(f.c(1), first, f.scope).ticket.text, 'Первый ответ');
  assert.throws(() => tickets.take(f.c(1), first, f.scope), { status: 410 });
  const third = id(tickets.issue(f.c(3), f.state, f.member, 'Третий ответ'));
  assert.equal(tickets.take(f.c(2), second, f.scope).ticket.text, 'Второй ответ');
  assert.equal(tickets.take(f.c(3), third, f.scope).ticket.text, 'Третий ответ');
  assert.equal(tickets.stats().rejected, 1);
  assert.equal(tickets.stats().expiryEntries, 0);
});

test('session speech-ticket capacity does not discard its first active token and expiry releases actual slots', () => {
  const f = fixture(),
    tickets = createSpeechTickets({ now: f.now, capacity: 8 });
  const issued = Array.from({ length: 4 }, () =>
    id(tickets.issue(f.c(1), f.state, f.member, 'Ответ')),
  );
  assert.throws(() => tickets.issue(f.c(1), f.state, f.member, 'Лишний ответ'), { status: 503 });
  assert.equal(tickets.take(f.c(1), issued[0], f.scope).ticket.text, 'Ответ');
  f.advance(30000);
  assert.throws(() => tickets.take(f.c(1), issued[1], f.scope), { status: 410 });
  assert.equal(tickets.stats().expired, 3);
  assert.equal(tickets.stats().active, 0);
});

test('global speech-permit backpressure retains exact text, account, session and policy ownership for admitted answers', () => {
  const f = fixture(),
    permits = createSpeechPermits({ now: f.now, capacity: 2 });
  const a = permits.issue(f.c(1), f.ticket, f.response, 600);
  const b = permits.issue(f.c(2), f.ticket, f.response, 600);
  assert.throws(() => permits.issue(f.c(3), f.ticket, f.response, 600), {
    status: 503,
    code: 'ASSISTANT_SPEECH_PERMIT_CAPACITY',
  });
  const body = { policyVersion: 1, text: f.response.text, speechToken: a.token };
  permits.requirePermit(f.c(1), f.ticket, body);
  for (const [c, extra] of [
    [f.c(2), {}],
    [f.c(1), { text: 'Посторонний ответ' }],
    [f.c(1), { policyVersion: 2 }],
  ])
    assert.throws(() => permits.requirePermit(c, f.ticket, { ...body, ...extra }), { status: 403 });
  permits.clearAccount(f.c(1).current.accountId);
  permits.requirePermit(f.c(2), f.ticket, { ...body, speechToken: b.token });
  assert.equal(permits.stats().reserved, 0);
  assert.equal(permits.stats().issued, 1);
  f.advance(600000);
  assert.throws(() => permits.requirePermit(f.c(2), f.ticket, { ...body, speechToken: b.token }), {
    status: 403,
  });
  assert.equal(permits.stats().active, 0);
});

test('a session cannot expel its own first valid permit when it reaches 32 active answers', () => {
  const f = fixture(),
    permits = createSpeechPermits({ now: f.now, capacity: 40 });
  const issued = Array.from({ length: 32 }, () => permits.issue(f.c(1), f.ticket, f.response, 600));
  assert.throws(() => permits.issue(f.c(1), f.ticket, f.response, 600), { status: 503 });
  permits.requirePermit(f.c(1), f.ticket, {
    policyVersion: 1,
    text: f.response.text,
    speechToken: issued[0].token,
  });
  assert.equal(permits.stats().active, 32);
  assert.equal(permits.stats().rejected, 1);
});

test('a reserved slot survives a long operation, converts atomically at full capacity and is not deleted by finally release', () => {
  const f = fixture(),
    permits = createSpeechPermits({ now: f.now, capacity: 1 });
  const reservation = permits.reserve(f.c(1), 1);
  assert.equal(permits.stats().reserved, 1);
  f.advance(600001);
  assert.throws(() => permits.reserve(f.c(2), 1), { status: 503 });
  const issued = permits.issue(f.c(1), f.ticket, f.response, 600, reservation);
  permits.release(reservation);
  permits.requirePermit(f.c(1), f.ticket, {
    policyVersion: 1,
    text: f.response.text,
    speechToken: issued.token,
  });
  assert.equal(permits.stats().issued, 1);
  assert.equal(permits.stats().reserved, 0);
});

test('clearing a reserved session prevents later issue and does not erase another account or retain abandoned slots', () => {
  const f = fixture(),
    permits = createSpeechPermits({ now: f.now, capacity: 2 });
  const a = permits.reserve(f.c(1), 1),
    b = permits.reserve(f.c(2), 1);
  permits.clearSession(f.c(1).current.sessionId);
  assert.throws(() => permits.issue(f.c(1), f.ticket, f.response, 600, a), { status: 403 });
  assert.equal(permits.stats().reserved, 1);
  permits.release(b);
  assert.equal(permits.stats().active, 0);
  assert.equal(permits.stats().reserved, 0);
});

function quotaFixture() {
  const f = fixture(),
    counters = { tasks: 0, provider: 0, execute: 0 };
  let revoked = false;
  const fresh = { ...f.scope(), scope: { billing: { paid: true } } };
  const scope = () => {
    if (revoked) throw Object.assign(Error('Synthetic revoked scope'), { status: 403 });
    return fresh;
  };
  const packages = {
    reserveTask() {
      counters.tasks++;
      return f.ticket;
    },
    acceptTask() {},
    rejectTask() {},
    requireAcceptedTask: () => f.ticket,
  };
  const quota = createAssistantTaskQuota({ billing: { packages } }, {}, scope, {
    speechPermitCapacity: 1,
  });
  const body = { policyVersion: 1, taskRequestId: f.ticket.requestId };
  return {
    ...f,
    counters,
    quota,
    body,
    revoke() {
      revoked = true;
    },
  };
}

test('full permit capacity blocks provider/task admission and execute before either operation starts', async () => {
  const f = quotaFixture();
  await f.quota.response(f.c(1), 1, async (owned) => {
    const task = f.quota.begin(owned, f.body, 'Синтетическая команда');
    return f.quota.complete(task, owned, f.response);
  });
  assert.equal(f.counters.tasks, 1);
  await assert.rejects(
    f.quota.response(f.c(2), 1, async (owned) => {
      f.quota.begin(owned, f.body, 'Синтетическая другая команда');
      f.counters.provider++;
    }),
    { status: 503, code: 'ASSISTANT_SPEECH_PERMIT_CAPACITY', outcomeUnknown: false },
  );
  await assert.rejects(
    f.quota.execute(f.c(2), { ...f.body, executionId: 'synthetic' }, async () => {
      f.counters.execute++;
    }),
    { status: 503, code: 'ASSISTANT_SPEECH_PERMIT_CAPACITY', outcomeUnknown: false },
  );
  assert.deepEqual(f.counters, { tasks: 1, provider: 0, execute: 0 });
});

test('errors before commit release the slot, while an admitted successful commit keeps its receipt despite competing admission', async () => {
  const f = quotaFixture();
  await assert.rejects(
    f.quota.execute(f.c(1), f.body, async () => {
      throw Object.assign(Error('Synthetic rejected before commit'), { status: 409 });
    }),
    { status: 409 },
  );
  assert.equal(f.quota.stats().active, 0);
  let finish, started;
  const entering = new Promise((resolve) => {
    started = resolve;
  });
  const result = f.quota.execute(f.c(1), f.body, async () => {
    f.counters.execute++;
    started();
    await new Promise((resolve) => {
      finish = resolve;
    });
    return { ...f.response, saved: true, receipt: 'synthetic-committed-receipt' };
  });
  await entering;
  assert.equal(f.quota.stats().reserved, 1);
  await assert.rejects(
    f.quota.response(f.c(2), 1, async () => {
      f.counters.provider++;
    }),
    { status: 503 },
  );
  finish();
  const response = await result;
  assert.equal(response.saved, true);
  assert.equal(response.receipt, 'synthetic-committed-receipt');
  assert.ok(response.speechPermit.token);
  assert.equal(f.quota.stats().reserved, 0);
  assert.equal(f.quota.stats().issued, 1);
  assert.deepEqual(f.counters, { tasks: 0, provider: 0, execute: 1 });
});

test('revocation during await keeps the fresh scope rejection and releases the reserved slot', async () => {
  const f = quotaFixture();
  let finish, started;
  const entering = new Promise((resolve) => {
    started = resolve;
  });
  const result = assert.rejects(
    f.quota.execute(f.c(1), f.body, async () => {
      started();
      await new Promise((resolve) => {
        finish = resolve;
      });
      return f.response;
    }),
    { status: 403 },
  );
  await entering;
  f.quota.clearSession(f.c(1).current.sessionId);
  f.revoke();
  finish();
  await result;
  assert.equal(f.quota.stats().reserved, 0);
  assert.equal(f.quota.stats().issued, 0);
});
