const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const { defaults } = require('../src/server/modules/workspace/policy.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const { routes } = require('../src/server/modules/assistant/routes.cjs');

// Synthetic HTTP emitters and an intentionally non-cooperative provider: no port,
// live credentials, browser, real provider calls, or clinical mutation endpoints.
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let index = 0; index < 3; index++) await new Promise(setImmediate);
};
function wav() {
  const bytes = Buffer.alloc(32044);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
const llm = (content) =>
  Buffer.from(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }),
  );
const patch = (service) => ({
  operation: 'patch',
  fields: { client: null, staff: null, service, date: null, time: null, duration: null },
  choice: null,
  field: null,
});
function fakeProvider() {
  const plans = [],
    calls = [];
  function enqueue(bytes, phase = 'normal', mimeType = 'application/json') {
    const headers = gate(),
      body = gate();
    const plan = {
      bytes,
      phase,
      mimeType,
      headers,
      body,
      cancelled: 0,
      reads: 0,
      readPending: false,
      signal: null,
      released: false,
    };
    plan.release = () => {
      plan.released = true;
      headers.resolve();
      body.resolve();
    };
    plans.push(plan);
    return plan;
  }
  async function fetchImpl(_url, options) {
    const plan = plans.shift();
    assert.ok(plan, 'Every synthetic outbound call must have an explicit response plan');
    calls.push(plan);
    plan.signal = options.signal;
    if (plan.phase === 'headers') await plan.headers.promise;
    let cancelled = false;
    const cancel = async () => {
      plan.cancelled++;
      cancelled = true;
      plan.body.resolve();
    };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': plan.mimeType }),
      body: {
        cancel,
        getReader() {
          return {
            cancel,
            async read() {
              plan.reads++;
              if (plan.reads > 1 || cancelled) return { done: true };
              if (plan.phase === 'body') {
                plan.readPending = true;
                await plan.body.promise;
                plan.readPending = false;
              }
              return cancelled ? { done: true } : { done: false, value: plan.bytes };
            },
          };
        },
      },
    };
  }
  return {
    enqueue,
    fetchImpl,
    calls,
    releaseAll() {
      for (const plan of [...calls, ...plans]) plan.release();
    },
  };
}
const adminCommand = (revision, values) => ({
  expectedRevision: revision,
  requestId: randomUUID(),
  reason: 'Synthetic disconnect regression',
  ...values,
});
async function fixture(t) {
  const f = await adminFixture(t),
    provider = fakeProvider(),
    clinic = dialogueFixture();
  const adminId = f.admin.accountId,
    ownerId = f.owner.accountId;
  let view = f.store.assistant.admin.view(adminId);
  view = f.store.assistant.admin.settings(
    adminId,
    adminCommand(view.revision, {
      policy: { mode: 'selected' },
      timewebApiKey: 'synthetic-disconnect-provider-key',
      providers: Object.fromEntries(
        ['llm', 'stt', 'tts'].map((kind) => [kind, { provider: 'timeweb' }]),
      ),
    }),
  );
  f.store.assistant.admin.setMember(
    adminId,
    adminCommand(view.revision, {
      organizationId: f.owner.organizationId,
      accountId: ownerId,
      enabled: true,
    }),
  );
  clinic.members[0].accountId = ownerId;
  clinic.services[0].staffId = ownerId;
  clinic.services.push({ id: 'massage', name: 'Массаж', duration: 45, staffId: ownerId });
  clinic.patients[0].createdBy = ownerId;
  const api = createAssistant(
    { ...f.database, organizationTimeZone: () => 'Europe/Moscow' },
    {
      directory: f.platformDirectory,
      fetchImpl: provider.fetchImpl,
    },
  );
  const current = f.store.session(f.ownerSession.token);
  const policyVersion = api.access(current).policyVersion,
    tasks = [];
  const clinical = () => JSON.stringify([clinic.patients, clinic.services, clinic.busy]);
  const before = clinical();
  const platform = {
    ...f.store,
    assistant: api,
    workspaceMembers: () => clinic.members,
    workspaceSettings: () => defaults(ownerId),
    bookingRequests: clinic.c.platform.bookingRequests,
    personalEvents: clinic.c.platform.personalEvents,
    workSchedules: clinic.c.platform.workSchedules,
  };
  function request(path, values, { readBody, assistantTiming } = {}) {
    const req = Object.assign(new EventEmitter(), {
      complete: true,
      aborted: false,
      destroyed: false,
    });
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableFinished: false,
      writableEnded: false,
      destroyed: false,
    });
    const result = { req, res, json: [], done: false, outcome: null };
    const c = {
      req,
      res,
      platform,
      current: { ...current },
      token: f.ownerSession.token,
      assistantTiming,
      url: new URL(path, 'http://synthetic.invalid'),
      tenantStore: clinic.c.tenantStore,
      assertCurrent() {
        const fresh = f.store.session(f.ownerSession.token);
        if (
          !fresh ||
          fresh.accountId !== current.accountId ||
          fresh.role !== current.role ||
          fresh.organizationId !== current.organizationId ||
          fresh.sessionId !== current.sessionId
        )
          throw Object.assign(Error('Synthetic session changed'), { status: 403 });
      },
      readBody: readBody || (async () => ({ policyVersion, ...values })),
      json(response, status, data) {
        result.json.push({ status, data, delivered: !response.destroyed });
        if (!response.destroyed) {
          response.headersSent = response.writableEnded = response.writableFinished = true;
          response.emit('finish');
        }
        return data;
      },
    };
    const route = routes.find((row) => row.method === 'POST' && row.path === path);
    assert.ok(route, 'The actual buffered organization route must exist');
    result.promise = Promise.resolve()
      .then(() => route.handle(c))
      .then(
        (value) => {
          result.done = true;
          return (result.outcome = { value });
        },
        (error) => {
          result.done = true;
          return (result.outcome = { error });
        },
      );
    result.disconnect = () => {
      res.destroyed = true;
      res.emit('close');
    };
    result.clean = () => {
      for (const emitter of [req, res])
        for (const name of emitter.eventNames())
          assert.equal(emitter.listenerCount(name), 0, 'Owned HTTP listeners must be removed');
    };
    tasks.push(result);
    return result;
  }
  f.cleanup(async () => {
    provider.releaseAll();
    await Promise.all(tasks.map((task) => task.promise));
    assert.equal(clinical(), before, 'Assistant routes must not mutate clinical records');
  });
  return {
    f,
    api,
    clinic,
    provider,
    request,
    policyVersion,
    usage: () => api.admin.view(adminId).usage,
    async booking() {
      // This setup intentionally uses interpretation. The shorter imperative
      // is covered by the local144 grammar and must not leave an unused fake
      // response in front of the continuation transport being exercised below.
      const initialPlan = provider.enqueue(
        llm({ intent: 'prepareAppointment', query: 'Анна Семёнова' }),
      );
      const initial = request('/api/assistant/turn', { text: 'Хочу записать Анну Семёнову' });
      await initial.promise;
      assert.equal(initial.outcome.error, undefined);
      assert.equal(
        provider.calls.at(-1),
        initialPlan,
        'The provider-bound setup consumes its exact response plan',
      );
      assert.ok(initialPlan.reads > 0);
      const reply = initial.json[0]?.data;
      assert.equal(reply?.dialogue?.step, 'service');
      assert.equal(reply.action, null);
      initial.clean();
      return {
        policyVersion,
        dialogueId: reply.dialogue.id,
        dialogueVersion: reply.dialogue.version,
        text: 'Мне нужна услуга Чистка',
      };
    },
  };
}
function endpoint(f, kind) {
  if (kind === 'turn')
    return {
      // This fixture must enter the provider; the full read command now resolves locally.
      path: '/api/assistant/turn',
      body: { text: 'Календарь' },
      bytes: llm({ intent: 'calendar' }),
      mime: 'application/json',
    };
  if (kind === 'transcribe')
    return {
      path: '/api/assistant/transcribe',
      body: { mimeType: 'audio/wav', audioBase64: wav().toString('base64') },
      bytes: Buffer.from(
        JSON.stringify({
          text: 'Синтетическая фраза',
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      ),
      mime: 'application/json',
    };
  return {
    path: '/api/assistant/speak',
    body: { text: 'На какую дату?' },
    bytes: wav(),
    mime: 'audio/wav',
  };
}
test('remote STT does not repeat full scope lookup between WAV validation and provider admission', async (t) => {
  const f = await fixture(t);
  const { path, body, bytes, mime } = endpoint(f, 'transcribe');
  f.provider.enqueue(bytes, 'normal', mime);
  let accesses = 0, beforeAdmission;
  const request = f.request(path, body, {
    assistantTiming: {
      begin(stage) {
        if (stage === 'access') accesses++;
        if (stage === 'admission') beforeAdmission = accesses;
        return () => {};
      },
    },
  });
  const reply = await request.promise;
  assert.equal(reply.value?.text, 'Синтетическая фраза');
  assert.equal(beforeAdmission, 2);
  assert.ok(accesses > beforeAdmission, 'The outbound and return guards still run');
  assert.equal(f.provider.calls.length, 1);
  request.clean();
});

function noTransportListeners(plan) {
  assert.equal(
    getEventListeners(plan.signal, 'abort').length,
    0,
    'No transport/timeout abort listener may retain the completed provider operation',
  );
}
function settledAbort(f, plan, request, reserved, before) {
  assert.equal(plan.signal.aborted, true, 'Leaving the last waiter must abort the outbound signal');
  assert.equal(
    request.done,
    true,
    'An owned disconnect must finish without waiting for a stubborn fetch',
  );
  assert.equal(request.json.length, 0, 'An aborted waiter must not receive or attempt late JSON');
  assert.equal(f.usage().reservedRub, 0, 'Cancellation must settle the owned reservation promptly');
  assert.ok(
    Math.abs(f.usage().spentRub - before.spentRub - reserved) < 1e-8,
    'An already-sent attempt keeps exactly its conservative reservation charge',
  );
}

for (const kind of ['turn', 'transcribe', 'speak']) {
  for (const phase of ['headers', 'body']) {
    test(`buffered ${kind}: disconnect during provider ${phase} aborts and cleans the owned request`, async (t) => {
      const f = await fixture(t),
        e = endpoint(f, kind),
        before = f.usage();
      const plan = f.provider.enqueue(e.bytes, phase, e.mime);
      const request = f.request(e.path, e.body);
      await flush();
      assert.equal(f.provider.calls.length, 1);
      assert.equal(plan.signal.aborted, false);
      if (phase === 'body') assert.equal(plan.readPending, true);
      const reserved = f.usage().reservedRub;
      assert.ok(reserved > 0);
      request.disconnect();
      await flush();
      // Capture cancellation before releasing the intentionally stubborn fake.
      const observed = {
        aborted: plan.signal.aborted,
        done: request.done,
        cancelled: plan.cancelled,
        usage: f.usage(),
        json: request.json.length,
      };
      plan.release();
      await request.promise;
      await flush();
      assert.equal(observed.aborted, true);
      assert.equal(observed.done, true);
      assert.equal(observed.json, 0);
      assert.equal(observed.usage.reservedRub, 0);
      if (phase === 'body')
        assert.ok(observed.cancelled > 0, 'Pending reader must be explicitly cancelled');
      settledAbort(f, plan, request, reserved, before);
      assert.ok(plan.cancelled > 0, 'A late or active provider body must be disposed');
      request.clean();
      noTransportListeners(plan);
    });
  }
  test(`buffered ${kind}: complete req.close and normal res.finish do not cancel the provider`, async (t) => {
    const f = await fixture(t),
      e = endpoint(f, kind);
    const plan = f.provider.enqueue(e.bytes, 'headers', e.mime);
    const request = f.request(e.path, e.body);
    await flush();
    request.req.destroyed = true;
    request.req.emit('close');
    await flush();
    assert.equal(
      plan.signal.aborted,
      false,
      'A completed POST body is not a disconnected response',
    );
    plan.release();
    await request.promise;
    assert.equal(request.outcome.error, undefined);
    assert.equal(request.json.length, 1);
    assert.equal(request.json[0].status, 200);
    request.res.emit('close');
    assert.equal(
      plan.signal.aborted,
      false,
      'Normal completed response cleanup must not signal cancellation',
    );
    assert.equal(f.usage().reservedRub, 0);
    assert.equal(f.provider.calls.length, 1);
    request.clean();
    noTransportListeners(plan);
  });
}

test('disconnect before outbound or an incomplete req.close admits no reservation or provider call', async (t) => {
  for (const incomplete of [false, true])
    await t.test(incomplete ? 'incomplete request' : 'closed response', async (t) => {
      const f = await fixture(t),
        read = gate(),
        before = f.usage();
      const request = f.request('/api/assistant/turn', {}, { readBody: () => read.promise });
      await flush();
      if (incomplete) {
        request.req.complete = false;
        request.req.destroyed = request.req.aborted = true;
        request.req.emit('close');
      } else request.disconnect();
      read.resolve({ policyVersion: f.policyVersion, text: 'Покажи расписание' });
      await request.promise;
      assert.equal(f.provider.calls.length, 0);
      assert.equal(request.json.length, 0);
      assert.deepEqual(f.usage(), before);
      request.clean();
    });
});

test('coalesced continuation: first waiter disconnect leaves the live waiter and its single reservation intact', async (t) => {
  const f = await fixture(t),
    body = await f.booking(),
    baselineCalls = f.provider.calls.length;
  const plan = f.provider.enqueue(llm(patch('Чистка')), 'body');
  const first = f.request('/api/assistant/turn', body);
  const second = f.request('/api/assistant/turn', structuredClone(body));
  await flush();
  assert.equal(f.provider.calls.length, baselineCalls + 1);
  const held = f.usage().reservedRub;
  first.disconnect();
  await flush();
  assert.equal(
    plan.signal.aborted,
    false,
    'A live coalesced waiter still owns the shared operation',
  );
  assert.equal(plan.cancelled, 0);
  assert.equal(first.done, true);
  assert.equal(first.json.length, 0);
  assert.equal(second.done, false);
  assert.equal(f.usage().reservedRub, held);
  plan.release();
  await Promise.all([first.promise, second.promise]);
  assert.equal(second.outcome.error, undefined);
  assert.equal(second.json[0]?.data.dialogue.step, 'date');
  assert.equal(second.json[0]?.data.action, null);
  assert.equal(f.usage().reservedRub, 0);
  const replay = f.request('/api/assistant/turn', body);
  await replay.promise;
  assert.deepEqual(replay.json[0]?.data.dialogue, second.json[0].data.dialogue);
  assert.equal(f.provider.calls.length, baselineCalls + 1);
  for (const request of [first, second, replay]) request.clean();
  noTransportListeners(plan);
});

test('all coalesced waiters leaving cancels the pending reader and freezes the exact sent attempt', async (t) => {
  const f = await fixture(t),
    body = await f.booking(),
    before = f.usage();
  const plan = f.provider.enqueue(llm(patch('Чистка')), 'body');
  const first = f.request('/api/assistant/turn', body);
  const second = f.request('/api/assistant/turn', structuredClone(body));
  await flush();
  const reserved = f.usage().reservedRub,
    calls = f.provider.calls.length;
  first.disconnect();
  await flush();
  assert.equal(plan.signal.aborted, false);
  second.disconnect();
  await flush();
  const observed = { aborted: plan.signal.aborted, cancelled: plan.cancelled, usage: f.usage() };
  const retry = f.request('/api/assistant/turn', structuredClone(body));
  await flush();
  const retryWasDone = retry.done;
  plan.release();
  await Promise.all([first.promise, second.promise, retry.promise]);
  assert.equal(observed.aborted, true);
  assert.ok(observed.cancelled > 0);
  assert.equal(observed.usage.reservedRub, 0);
  assert.equal(retryWasDone, true, 'Exact frozen-body retry must not wait on abandoned work');
  assert.ok(
    retry.outcome.error,
    'Sent cancellation is an error receipt, never a replayed proposal',
  );
  assert.equal(retry.json.length, 0);
  assert.equal(
    f.provider.calls.length,
    calls,
    'A frozen sent retry must not create a second paid attempt',
  );
  settledAbort(f, plan, first, reserved, before);
  assert.equal(second.json.length, 0);
  for (const request of [first, second, retry]) request.clean();
  noTransportListeners(plan);
});

test('a corrected answer may start after last-waiter abort; late old headers cannot apply or erase its coalescing record', async (t) => {
  const f = await fixture(t),
    body = await f.booking(),
    baselineCalls = f.provider.calls.length;
  const old = f.provider.enqueue(llm(patch('Чистка')), 'headers');
  const abandoned = f.request('/api/assistant/turn', body);
  await flush();
  abandoned.disconnect();
  await flush();
  const correctedBody = { ...body, text: 'Мне нужна услуга Массаж' };
  const fresh = f.provider.enqueue(llm(patch('Массаж')), 'body');
  const corrected = f.request('/api/assistant/turn', correctedBody);
  await flush();
  const freshStarted = f.provider.calls.length === baselineCalls + 2;
  old.release();
  await flush();
  const coalesced = f.request('/api/assistant/turn', structuredClone(correctedBody));
  await flush();
  const callsBeforeCompletion = f.provider.calls.length;
  fresh.release();
  await Promise.all([abandoned.promise, corrected.promise, coalesced.promise]);
  assert.equal(old.signal.aborted, true);
  assert.equal(
    freshStarted,
    true,
    'Corrected body must not remain locked behind an abandoned pending record',
  );
  assert.equal(fresh.signal.aborted, false);
  assert.equal(
    callsBeforeCompletion,
    baselineCalls + 2,
    'Late old completion must not erase the new single-flight record',
  );
  assert.equal(abandoned.json.length, 0);
  assert.equal(corrected.outcome.error, undefined);
  assert.equal(coalesced.outcome.error, undefined);
  const reply = corrected.json[0]?.data;
  assert.equal(reply?.dialogue.step, 'date');
  assert.equal(reply?.dialogue.fields.find((row) => row.key === 'service')?.value, 'Массаж');
  assert.deepEqual(coalesced.json[0]?.data.dialogue, reply.dialogue);
  assert.equal(reply.action, null);
  assert.equal(f.usage().reservedRub, 0);
  for (const request of [abandoned, corrected, coalesced]) request.clean();
  noTransportListeners(old);
  noTransportListeners(fresh);
});

for (const clear of ['clearAccount', 'clearSession']) {
  test(`${clear} cancels an owned pending continuation without waiting for provider headers`, async (t) => {
    const f = await fixture(t),
      body = await f.booking();
    const plan = f.provider.enqueue(llm(patch('Чистка')), 'headers');
    const request = f.request('/api/assistant/turn', body);
    await flush();
    const current = f.f.store.session(f.f.ownerSession.token);
    f.api[clear](current[clear === 'clearAccount' ? 'accountId' : 'sessionId']);
    await flush();
    const observed = { aborted: plan.signal.aborted, done: request.done, usage: f.usage() };
    plan.release();
    await request.promise;
    assert.equal(observed.aborted, true);
    assert.equal(observed.done, true);
    assert.equal(observed.usage.reservedRub, 0);
    assert.ok(request.outcome.error);
    assert.equal(request.json.length, 0);
    request.clean();
    noTransportListeners(plan);
  });
}

for (const revoke of ['grant', 'session']) {
  test(`fresh ${revoke} rejection after provider await cannot deliver a stale continuation`, async (t) => {
    const f = await fixture(t),
      body = await f.booking();
    const plan = f.provider.enqueue(llm(patch('Чистка')), 'headers');
    const request = f.request('/api/assistant/turn', body);
    await flush();
    if (revoke === 'session') f.f.store.logout(f.f.ownerSession.token);
    else {
      const view = f.api.admin.view(f.f.admin.accountId);
      f.api.admin.setMember(
        f.f.admin.accountId,
        adminCommand(view.revision, {
          organizationId: f.f.owner.organizationId,
          accountId: f.f.owner.accountId,
          enabled: false,
        }),
      );
    }
    plan.release();
    await request.promise;
    assert.equal(request.outcome.error?.status, 403);
    assert.equal(request.json.length, 0);
    assert.equal(f.usage().reservedRub, 0);
    assert.ok(
      plan.cancelled > 0,
      'Unread late provider body must not retain resources after a fresh ACL failure',
    );
    request.clean();
    noTransportListeners(plan);
  });
}

// Additional closure cases. Everything above this line is the frozen original19.
test('coalesced continuation: the follower may disconnect while its creator completes once', async (t) => {
  const f = await fixture(t),
    body = await f.booking(),
    baselineCalls = f.provider.calls.length;
  const plan = f.provider.enqueue(llm(patch('Чистка')), 'body');
  const creator = f.request('/api/assistant/turn', body);
  const follower = f.request('/api/assistant/turn', structuredClone(body));
  await flush();
  const held = f.usage();
  follower.disconnect();
  await flush();
  assert.equal(follower.done, true);
  assert.equal(follower.json.length, 0);
  assert.equal(creator.done, false);
  assert.equal(plan.signal.aborted, false);
  assert.equal(plan.cancelled, 0);
  assert.deepEqual(f.usage(), held);
  plan.release();
  await Promise.all([creator.promise, follower.promise]);
  assert.equal(creator.outcome.error, undefined);
  assert.equal(creator.json[0]?.data.dialogue.step, 'date');
  assert.equal(creator.json[0]?.data.action, null);
  assert.equal(f.provider.calls.length, baselineCalls + 1);
  assert.equal(f.usage().reservedRub, 0);
  for (const request of [creator, follower]) request.clean();
  noTransportListeners(plan);
});

test('a preclosed retry cannot join, cancel or charge an already healthy shared operation', async (t) => {
  const f = await fixture(t),
    body = await f.booking(),
    baselineCalls = f.provider.calls.length;
  const plan = f.provider.enqueue(llm(patch('Чистка')), 'body');
  const live = f.request('/api/assistant/turn', body);
  await flush();
  const held = f.usage();
  const closed = f.request('/api/assistant/turn', structuredClone(body));
  closed.disconnect();
  await closed.promise;
  assert.equal(closed.done, true);
  assert.equal(closed.json.length, 0);
  assert.equal(live.done, false);
  assert.equal(plan.signal.aborted, false);
  assert.equal(plan.cancelled, 0);
  assert.equal(f.provider.calls.length, baselineCalls + 1);
  assert.deepEqual(f.usage(), held);
  plan.release();
  await live.promise;
  assert.equal(live.outcome.error, undefined);
  assert.equal(live.json[0]?.data.dialogue.step, 'date');
  assert.equal(f.usage().reservedRub, 0);
  for (const request of [live, closed]) request.clean();
  noTransportListeners(plan);
});

test('buffered transport cleanup preserves pre-existing foreign HTTP listeners', async (t) => {
  for (const disconnect of [false, true])
    await t.test(disconnect ? 'disconnect' : 'normal completion', async (t) => {
      const f = await fixture(t),
        e = endpoint(f, 'turn');
      const plan = f.provider.enqueue(e.bytes, 'headers', e.mime);
      const request = f.request(e.path, e.body);
      const foreign = [
        [request.req, 'aborted', () => {}],
        [request.req, 'close', () => {}],
        [request.res, 'close', () => {}],
        [request.res, 'finish', () => {}],
      ];
      for (const [emitter, event, listener] of foreign) emitter.on(event, listener);
      t.after(() => {
        for (const [emitter, event, listener] of foreign) emitter.removeListener(event, listener);
      });
      await flush();
      if (disconnect) request.disconnect();
      plan.release();
      await request.promise;
      await flush();
      assert.equal(request.json.length, disconnect ? 0 : 1);
      assert.equal(f.usage().reservedRub, 0);
      for (const [emitter, event, listener] of foreign) {
        assert.deepEqual(
          emitter.listeners(event),
          [listener],
          'Only the owned listeners may be removed',
        );
        emitter.removeListener(event, listener);
      }
      request.clean();
      noTransportListeners(plan);
    });
});

test('a seventeenth shared waiter is rejected without a second outbound or reservation', async (t) => {
  const f = await fixture(t),
    body = await f.booking(),
    baselineCalls = f.provider.calls.length;
  const plan = f.provider.enqueue(llm(patch('Чистка')), 'body');
  const waiters = Array.from({ length: 16 }, () =>
    f.request('/api/assistant/turn', structuredClone(body)),
  );
  await flush();
  assert.ok(waiters.every((request) => !request.done));
  assert.equal(f.provider.calls.length, baselineCalls + 1);
  const held = f.usage();
  const overflow = f.request('/api/assistant/turn', structuredClone(body));
  await overflow.promise;
  assert.equal(overflow.outcome.error?.status, 429);
  assert.equal(overflow.json.length, 0);
  assert.equal(plan.signal.aborted, false);
  assert.deepEqual(f.usage(), held);
  assert.equal(f.provider.calls.length, baselineCalls + 1);
  plan.release();
  await Promise.all(waiters.map((request) => request.promise));
  for (const request of waiters) {
    assert.equal(request.outcome.error, undefined);
    assert.equal(request.json[0]?.data.dialogue.step, 'date');
    assert.equal(request.json[0]?.data.action, null);
    request.clean();
  }
  overflow.clean();
  assert.equal(f.provider.calls.length, baselineCalls + 1);
  assert.equal(f.usage().reservedRub, 0);
  noTransportListeners(plan);
});

// New append-only provider/context: the original19 fixture and fakeProvider stay unchanged.
async function stubbornCancelFixture(t, phase) {
  const base = await fixture(t),
    headers = gate(),
    body = gate(),
    tasks = [];
  const cancellation = gate(),
    neverCancelled = cancellation.promise;
  const provider = { signal: null, cancelled: 0, reads: 0, readPending: false, calls: 0 };
  const cancel = () => {
    provider.cancelled++;
    return neverCancelled;
  };
  const api = createAssistant(
    { ...base.f.database, organizationTimeZone: () => 'Europe/Moscow' },
    {
      directory: base.f.platformDirectory,
      async fetchImpl(_url, options) {
        provider.calls++;
        provider.signal = options.signal;
        if (phase === 'headers') await headers.promise;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          body: {
            cancel,
            getReader() {
              return {
                cancel,
                async read() {
                  if (++provider.reads > 1) return { done: true };
                  provider.readPending = true;
                  await body.promise;
                  provider.readPending = false;
                  return { done: false, value: wav() };
                },
              };
            },
          },
        };
      },
    },
  );
  const current = base.f.store.session(base.f.ownerSession.token);
  function request() {
    const req = Object.assign(new EventEmitter(), {
      complete: true,
      aborted: false,
      destroyed: false,
    });
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableFinished: false,
      writableEnded: false,
      destroyed: false,
    });
    const result = { req, res, json: [], done: false, outcome: null };
    const c = {
      req,
      res,
      current: { ...current },
      platform: { ...base.f.store, assistant: api },
      token: base.f.ownerSession.token,
      url: new URL('http://synthetic.invalid/api/assistant/speak'),
      tenantStore: base.clinic.c.tenantStore,
      assertCurrent() {
        const fresh = base.f.store.session(base.f.ownerSession.token);
        if (
          !fresh ||
          fresh.accountId !== current.accountId ||
          fresh.organizationId !== current.organizationId ||
          fresh.role !== current.role ||
          fresh.sessionId !== current.sessionId
        )
          throw Object.assign(Error('Synthetic session changed'), { status: 403 });
      },
      readBody: async () => ({ policyVersion: base.policyVersion, text: 'На какую дату?' }),
      json(response, status, data) {
        result.json.push({ status, data });
        if (!response.destroyed) {
          response.headersSent = response.writableEnded = response.writableFinished = true;
          response.emit('finish');
        }
        return data;
      },
    };
    const route = routes.find(
      (row) => row.method === 'POST' && row.path === '/api/assistant/speak',
    );
    result.promise = Promise.resolve()
      .then(() => route.handle(c))
      .then(
        (value) => {
          result.done = true;
          return (result.outcome = { value });
        },
        (error) => {
          result.done = true;
          return (result.outcome = { error });
        },
      );
    result.disconnect = () => {
      res.destroyed = true;
      res.emit('close');
    };
    result.clean = () => {
      for (const emitter of [req, res])
        for (const event of emitter.eventNames()) assert.equal(emitter.listenerCount(event), 0);
    };
    tasks.push(result);
    return result;
  }
  const release = () => {
    headers.resolve();
    body.resolve();
  };
  base.f.cleanup(async () => {
    // Cancellation stays pending throughout assertions; teardown can rescue a broken implementation.
    release();
    cancellation.resolve();
    await Promise.all(tasks.map((request) => request.promise));
  });
  return { provider, request, release, usage: () => api.admin.view(base.f.admin.accountId).usage };
}

for (const phase of ['headers', 'body']) {
  test(
    'buffered disconnect settles even when provider ' + phase + ' cancellation never resolves',
    async (t) => {
      const f = await stubbornCancelFixture(t, phase),
        before = f.usage();
      const request = f.request();
      await flush();
      assert.equal(f.provider.calls, 1);
      if (phase === 'body') assert.equal(f.provider.readPending, true);
      const reserved = f.usage().reservedRub;
      assert.ok(reserved > 0);
      request.disconnect();
      await flush();
      assert.equal(f.provider.signal.aborted, true);
      assert.equal(request.done, true, 'Never-settling cancellation cannot retain HTTP ownership');
      assert.equal(request.json.length, 0);
      assert.equal(f.usage().reservedRub, 0);
      assert.ok(Math.abs(f.usage().spentRub - before.spentRub - reserved) < 1e-8);
      if (phase === 'body') assert.equal(f.provider.cancelled, 1);
      request.clean();
      noTransportListeners(f.provider);
      // Headers arriving after termination still release their body, without awaiting its cancel.
      f.release();
      await request.promise;
      await flush();
      assert.equal(f.provider.cancelled, 1);
      assert.equal(request.json.length, 0);
      assert.equal(f.provider.calls, 1);
      assert.equal(f.usage().reservedRub, 0);
      request.clean();
      noTransportListeners(f.provider);
    },
  );
}
