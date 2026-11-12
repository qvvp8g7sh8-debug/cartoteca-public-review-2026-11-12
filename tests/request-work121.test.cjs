const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createRequestDispatcher } = require('../src/server/infrastructure/request-dispatcher.cjs');
const {
  requestPriority,
  requestScope,
  createRequestWork,
  createPhotoWork,
} = require('../src/server/http/request-work.cjs');
const { readBody } = require('../src/server/http/responses.cjs');
const {
  createJsonBodyBudget,
  createJsonBodyScope,
} = require('../src/server/http/json-body-budget.cjs');

const owner = { accountId: 'owner', organizationId: 'org', role: 'owner', globalAdmin: false },
  calendar = { method: 'GET', path: '/api/cabinet/calendar', access: 'organization' };
function queue(options = {}) {
  const scheduled = new Map();
  let next = 0;
  const dispatcher = createRequestDispatcher({
    schedule: (run) => {
      scheduled.set(++next, run);
      return next;
    },
    cancelScheduled: (id) => scheduled.delete(id),
    ...options,
  });
  return {
    dispatcher,
    flush() {
      while (scheduled.size) {
        const [id, run] = scheduled.entries().next().value;
        scheduled.delete(id);
        run();
      }
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { resolve, promise };
}
function body(text) {
  const request = Readable.from([Buffer.from(text)]);
  request.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  };
  return request;
}

test('interactive policy is closed to small scoped reads and manual writes, not assistant or imports', () => {
  for (const path of [
    '/api/cabinet/bootstrap',
    '/api/cabinet/calendar',
    '/api/cabinet/directory',
    '/api/cabinet/patient',
    '/api/cabinet/operation',
  ])
    assert.equal(requestPriority({ ...calendar, path }), 'interactive');
  for (const [method, path] of [
    ['PATCH', '/api/cabinet/changes'],
    ['POST', '/api/cabinet/appointments'],
    ['POST', '/api/appointments/confirmation'],
    ['POST', '/api/calendar/personal-event'],
    ['DELETE', '/api/calendar/personal-event'],
  ]) {
    const route = { method, path, access: 'organization' };
    assert.equal(requestPriority(route, 256 * 1024), 'interactive');
    assert.equal(requestPriority(route, 256 * 1024 + 1), 'normal');
  }
  for (const route of [
    { ...calendar, access: 'public' },
    { ...calendar, access: 'global' },
    { ...calendar, method: 'POST', path: '/api/assistant/turn' },
    { ...calendar, method: 'POST', path: '/api/assistant/execute' },
    { ...calendar, method: 'PUT', path: '/api/cabinet' },
    { ...calendar, path: '/api/photos/example', priority: 'interactive' },
    { ...calendar, path: '/api/unlisted', headers: { 'X-Priority': 'interactive' } },
  ])
    assert.equal(requestPriority(route), 'normal');
});

test('work scope comes from authenticated identity and remains captured while queued', async () => {
  assert.equal(requestScope(owner), 'org:org');
  assert.equal(requestScope({ accountId: 'account' }), 'account:account');
  assert.equal(requestScope(null), null);
  const f = queue({ maxPending: 8, maxPendingPerScope: 1 }),
    current = { ...owner };
  const run = createRequestWork({
    dispatcher: f.dispatcher,
    route: { ...calendar, organizationId: 'untrusted', headers: { 'X-Organization': 'other' } },
    current,
    authorize: () => {},
  });
  current.organizationId = 'changed-after-work-was-created';
  const pending = run(() => 7);
  await assert.rejects(
    f.dispatcher.run(() => assert.fail('captured scope must be full'), {
      priority: 'interactive',
      scopeKey: 'org:org',
    }),
    { status: 503 },
  );
  assert.equal(f.dispatcher.workStats().scopes, 1);
  assert.equal(f.dispatcher.workStats().priorities.interactive.pending, 1);
  f.flush();
  assert.equal(await pending, 7);
  assert.equal(f.dispatcher.workStats().scopes, 0);
  f.dispatcher.close();
});

test('queued authorization and cancellation fence callbacks before any scoped work', async () => {
  const f = queue();
  let allowed = true,
    cancelled = false,
    authorizations = 0,
    effects = 0;
  const run = createRequestWork({
    dispatcher: f.dispatcher,
    route: calendar,
    current: owner,
    authorize: () => {
      authorizations++;
      if (!allowed) throw Object.assign(Error('revoked'), { status: 403 });
    },
    cancelled: () => cancelled,
  });
  const revoked = assert.rejects(
    run(() => effects++),
    { status: 403 },
  );
  allowed = false;
  f.flush();
  await revoked;
  assert.equal(authorizations, 1);
  assert.equal(effects, 0);
  const abandoned = assert.rejects(
    run(() => effects++),
    { status: 499 },
  );
  cancelled = true;
  f.flush();
  await abandoned;
  assert.equal(authorizations, 1, 'cancelled queued work does not reach authorization or callback');
  assert.equal(effects, 0);
  f.dispatcher.close();
});

test('real body parse waits for admission and keeps its reservation until both reader and handler finish', async () => {
  const f = queue(),
    budget = createJsonBodyBudget({ maxBytes: 64 }),
    scope = createJsonBodyScope('owner', budget),
    admitted = deferred();
  let parsed = 0;
  const run = createRequestWork({
    dispatcher: f.dispatcher,
    route: { method: 'PATCH', path: '/api/cabinet/changes', access: 'organization' },
    current: owner,
    authorize: () => {},
  });
  const pending = run(() =>
    readBody(
      body('{"n":3}'),
      64,
      (key, value) => {
        parsed++;
        return key === 'n' ? value + 1 : value;
      },
      {
        ...scope.options,
        runParse: (parse, bytes) => {
          assert.equal(bytes, 7);
          admitted.resolve();
          return run(parse, bytes);
        },
      },
    ),
  );
  f.flush();
  await admitted.promise;
  assert.equal(parsed, 0);
  assert.equal(budget.stats().bytes, 7);
  scope.close();
  assert.equal(budget.stats().bytes, 7, 'closing a handler cannot free a queued parse body');
  f.flush();
  assert.deepEqual(await pending, { n: 4 });
  assert.ok(parsed > 0);
  assert.equal(budget.stats().bytes, 0);
  assert.equal(budget.stats().requests, 0);
  f.dispatcher.close();
});

test('native photo context accepts query-only identity before and after queued admission', async () => {
  const f = queue(),
    query = new URLSearchParams({
      accountContext: owner.accountId,
      organizationContext: owner.organizationId,
    }),
    checks = [];
  let effects = 0;
  const run = createPhotoWork({
    dispatcher: f.dispatcher,
    requireCurrent: () => owner,
    assertRequestContext: (current, required = false, useQuery = false) => {
      checks.push({ required, useQuery });
      if (required && !useQuery)
        throw Object.assign(Error('native images have no custom headers'), { status: 428 });
      if (useQuery) {
        assert.equal(query.get('accountContext'), current.accountId);
        assert.equal(query.get('organizationContext'), current.organizationId);
      }
    },
  });
  assert.deepEqual(checks, [
    { required: false, useQuery: false },
    { required: true, useQuery: true },
  ]);
  const pending = run(() => ++effects);
  assert.equal(effects, 0);
  f.flush();
  assert.equal(await pending, 1);
  assert.equal(checks.length, 4, 'query authorization is repeated after admission');
  assert.equal(effects, 1);
  f.dispatcher.close();
});

test('queued photo authorization rejects revoked role, identity and global access before callback', async () => {
  for (const [change, status] of [
    [{ role: 'cosmetologist' }, 403],
    [{ globalAdmin: true }, 403],
    [{ accountId: 'other' }, 428],
    [{ organizationId: 'other' }, 428],
  ]) {
    const f = queue();
    let current = owner,
      effects = 0;
    const run = createPhotoWork({
      dispatcher: f.dispatcher,
      requireCurrent: () => current,
      assertRequestContext: (fresh, required, query) => {
        if (
          required &&
          query &&
          (fresh.accountId !== owner.accountId || fresh.organizationId !== owner.organizationId)
        )
          throw Object.assign(Error('URL belongs to the prior account'), { status: 428 });
      },
    });
    const rejected = assert.rejects(
      run(() => effects++),
      { status },
    );
    current = { ...owner, ...change };
    f.flush();
    await rejected;
    assert.equal(effects, 0);
    f.dispatcher.close();
  }
});

test('real full queue preserves parse-admission 503 instead of translating it to invalid JSON', async () => {
  const f = queue({ maxPending: 1 }),
    budget = createJsonBodyBudget({ maxBytes: 64 }),
    blocker = f.dispatcher.run(() => 1);
  let authorized = 0;
  const run = createRequestWork({
    dispatcher: f.dispatcher,
    route: calendar,
    current: owner,
    authorize: () => authorized++,
  });
  await assert.rejects(
    readBody(body('{'), 64, undefined, { budget, runParse: run }),
    (error) => error.status === 503 && error.retryAfter === 1,
  );
  assert.equal(authorized, 0);
  assert.equal(budget.stats().requests, 0);
  f.flush();
  assert.equal(await blocker, 1);
  f.dispatcher.close();
});

test('actual queued body cancellation preserves 499 and frees the reservation without parsing', async () => {
  const f = queue(),
    budget = createJsonBodyBudget({ maxBytes: 64 }),
    admitted = deferred();
  let cancelled = false,
    parsed = 0;
  const run = createRequestWork({
    dispatcher: f.dispatcher,
    route: calendar,
    current: owner,
    authorize: () => {},
    cancelled: () => cancelled,
  });
  const pending = readBody(body('{"n":3}'), 64, () => parsed++, {
    budget,
    runParse: (parse, bytes) => {
      admitted.resolve();
      return run(parse, bytes);
    },
  });
  const rejected = assert.rejects(pending, { status: 499 });
  await admitted.promise;
  cancelled = true;
  f.flush();
  await rejected;
  assert.equal(parsed, 0);
  assert.equal(budget.stats().bytes, 0);
  f.dispatcher.close();
});

test('invalid JSON still returns 400 once parse admission actually succeeds', async () => {
  const f = queue(),
    budget = createJsonBodyBudget({ maxBytes: 64 }),
    admitted = deferred();
  const run = createRequestWork({
    dispatcher: f.dispatcher,
    route: calendar,
    current: owner,
    authorize: () => {},
  });
  const pending = readBody(body('{'), 64, undefined, {
    budget,
    runParse: (parse, bytes) => {
      admitted.resolve();
      return run(parse, bytes);
    },
  });
  const rejected = assert.rejects(pending, { status: 400 });
  await admitted.promise;
  assert.equal(budget.stats().bytes, 1);
  f.flush();
  await rejected;
  assert.equal(budget.stats().bytes, 0);
  f.dispatcher.close();
});
