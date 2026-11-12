const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const {
  createAssistantPlaybackMetrics,
  parsePlaybackSummary,
} = require('../src/server/infrastructure/assistant-playback-metrics.cjs');
const { createRequestMetrics } = require('../src/server/infrastructure/request-metrics.cjs');
const { createRequestHandler } = require('../src/server/http/request-handler.cjs');
const { routes } = require('../src/server/modules/assistant/routes.cjs');
const current = {
  sessionId: 'private-session',
  accountId: 'private-account',
  organizationId: 'private-org',
  role: 'owner',
};
const body = () => ({
  text: 'private synthetic utterance',
  policyVersion: 0,
  taskRequestId: randomUUID(),
});
const tuple = (changes = {}) => {
  const values = [1, 0, 1, 0, 0, 0, 1, 1, 290, 2, 1, 4, 18, 3, 5, 0, 1, 0, 0, 0];
  for (const [key, value] of Object.entries(changes)) values[Number(key)] = value;
  return values.join(',');
};
test('fixed twenty integers only, bounded and malformed input ignored', () => {
  assert.ok(parsePlaybackSummary(tuple()));
  for (const header of [
    null,
    [],
    {},
    '',
    tuple() + ',0',
    ' ' + tuple(),
    tuple({ 0: 2 }),
    tuple({ 1: 3 }),
    tuple({ 2: 2 }),
    tuple({ 3: 101 }),
    tuple({ 5: 150001 }),
    tuple({ 9: 5 }),
    tuple({ 8: -1 }),
    tuple({ 8: NaN }),
    tuple({ 8: Infinity }),
    tuple({ 8: 0.5 }),
    '0'.repeat(257),
  ])
    assert.equal(parsePlaybackSummary(header), null);
});
test('numeric crossclasses, totals/max, privacy and dedup survive aggregate reset', () => {
  const m = createAssistantPlaybackMetrics(),
    request = body();
  assert.equal(m.record(current, request, tuple()), true);
  assert.equal(
    m.record(current, request, tuple({ 3: 1 })),
    false,
    'changed header on same request is duplicate',
  );
  let s = m.snapshot(true);
  assert.equal(s.samples, 1);
  assert.equal(s.falsePauseOnly, 1);
  assert.equal(s.underruns, 0);
  assert.equal(s.falsePauseTotalMs, 290);
  assert.equal(s.contextSuspended, 1);
  assert.equal(m.record(current, request, tuple()), false, 'dedup retained across reset');
  m.record(current, body(), tuple({ 3: 2, 7: 0, 8: 0, 9: 1 }));
  m.record(current, body(), tuple({ 3: 1 }));
  m.record(current, body(), tuple({ 3: 0, 7: 0, 8: 0 }));
  s = m.snapshot();
  assert.equal(s.samples, 3);
  assert.equal(s.underflowOnly, 1);
  assert.equal(s.both, 1);
  assert.equal(s.neither, 1);
  assert.equal(s.falsePauseMaxMs, 290);
  assert.ok(Object.values(s).every(Number.isSafeInteger));
  assert.doesNotMatch(
    JSON.stringify(s),
    /private|utterance|sessionId|taskRequestId|dialogue|token|hash/i,
  );
  m.close();
  assert.equal(m.record(current, body(), tuple()), false);
  assert.equal(m.snapshot().samples, 0);
});
test('dedup bounded TTL, context separation and missing stable request skips', () => {
  let now = 0;
  const m = createAssistantPlaybackMetrics({ now: () => now, capacity: 2, ttlMs: 100 }),
    request = body();
  assert.equal(m.record(current, request, tuple()), true);
  assert.equal(
    m.record({ ...current, sessionId: 'another-private-session' }, request, tuple()),
    true,
  );
  assert.equal(m.record(current, body(), tuple()), false, 'full map drops new sample');
  now = 100;
  assert.equal(m.record(current, request, tuple()), true, 'expired keys retired');
  assert.equal(m.record(current, { text: 'private' }, tuple()), false);
  assert.equal(m.record(null, request, tuple()), false);
  m.close();
});
function response() {
  return Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status, headers) {
      this.status = status;
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers);
    },
    end(value) {
      this.body = value;
      this.writableEnded = true;
      this.writableFinished = true;
      this.emit('finish');
    },
  });
}
test('existing assistant-only flush emits playback-only aggregates and combined reset retains dedup', (t) => {
  const timers = [],
    emitted = [];
  t.mock.method(global, 'setTimeout', (callback, ms) => {
    const timer = { callback, ms, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', () => {});
  const m = createRequestMetrics({
    assistantEnabled: true,
    emit: (s) => emitted.push(JSON.parse(s)),
  });
  const request = body();
  try {
    const sample = m.track({ method: 'POST', url: '/api/assistant/turn' }, response());
    sample.playback(current, request, tuple());
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 60000);
    timers[0].callback();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'assistant_metrics');
    assert.equal(emitted[0].assistantPhases.length, 0);
    assert.equal(emitted[0].playbackSummary.samples, 1);
    sample.playback(current, request, tuple());
    assert.equal(m.assistantSnapshot().playbackSummary.samples, 0);
    sample.playback(current, body(), tuple());
    assert.equal(m.snapshot({ reset: true }).playbackSummary.samples, 1);
    assert.equal(m.assistantSnapshot().playbackSummary.samples, 0);
    assert.doesNotMatch(
      JSON.stringify(emitted),
      /private|utterance|sessionId|taskRequestId|token|hash/i,
    );
  } finally {
    m.close();
  }
});
async function httpTurn(
  metrics,
  {
    request = body(),
    header = tuple(),
    authenticated = true,
    context = true,
    csrf = true,
    status = 200,
    cancel = false,
    realContext = null,
  } = {},
) {
  const actor = realContext?.current || current;
  const req = Readable.from([Buffer.from(JSON.stringify(request))]);
  Object.assign(req, {
    method: 'POST',
    url: '/api/assistant/turn',
    complete: true,
    aborted: false,
    socket: { localPort: 4174 },
    headers: {
      host: 'synthetic.invalid',
      origin: 'https://synthetic.invalid',
      'content-type': 'application/json',
      'x-cartoteca-request': csrf ? '1' : 'bad',
      'x-cartoteca-account-id': actor.accountId,
      'x-cartoteca-organization-id': context ? actor.organizationId : 'wrong-private-org',
      cookie: 'cartoteca_v2_session=private-cookie',
      'x-assistant-audio-summary': header,
    },
  });
  const res = response();
  let calls = 0;
  const handler = createRequestHandler({
    config: { origin: 'https://synthetic.invalid' },
    platform: realContext
      ? { ...realContext.platform, session: () => (authenticated ? actor : null) }
      : {
          session: () => (authenticated ? current : null),
          assistant: {
            async turn() {
              calls++;
              if (cancel) {
                req.aborted = true;
                req.emit('aborted');
              }
              if (status !== 200) throw Object.assign(Error('Synthetic refusal'), { status });
              return { ok: true };
            },
          },
        },
    pool: {
      lease: () => ({
        get: realContext
          ? realContext.tenantStore
          : () => assert.fail('telemetry must not read clinical data'),
        release() {},
      }),
    },
    routes: [routes.find((r) => r.path === '/api/assistant/turn')],
    metrics,
    requestDispatcher: { run: async (run) => run() },
    clientAddress: () => 'synthetic',
    services: {},
  });
  await handler(req, res);
  return { status: res.status, calls, reply: res.body ? JSON.parse(res.body) : null };
}
test('real HTTP auth/context/CSRF and rejected/cancelled turns cannot record; success retry records once', async () => {
  const m = createRequestMetrics({ assistantEnabled: true });
  try {
    for (const options of [
      { authenticated: false },
      { context: false },
      { csrf: false },
      { status: 403 },
      { status: 409 },
      { status: 428 },
      { cancel: true },
    ]) {
      const r = await httpTurn(m, options);
      if (options.authenticated === false || options.context === false || options.csrf === false)
        assert.equal(r.calls, 0);
      assert.equal(m.assistantSnapshot().playbackSummary.samples, 0);
    }
    const request = body();
    let result = await httpTurn(m, { request });
    assert.equal(result.status, 200);
    assert.equal(result.calls, 1);
    assert.equal(m.assistantSnapshot().playbackSummary.samples, 1);
    result = await httpTurn(m, { request });
    assert.equal(result.status, 200);
    assert.equal(m.assistantSnapshot().playbackSummary.samples, 1);
    assert.equal((await httpTurn(m, { header: 'private-invalid' })).status, 200);
    assert.equal(m.assistantSnapshot().playbackSummary.samples, 1);
  } finally {
    m.close();
  }
});

test('actual paid local turn records optional summary without another task or provider call', async (t) => {
  const { createPaidBookingFixture } = require('./helpers/assistant-paid-booking-fixture.cjs');
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  const metrics = createRequestMetrics({ assistantEnabled: true });
  t.after(() => metrics.close());
  const req = Object.assign(new EventEmitter(), {
      complete: true,
      headers: { 'x-assistant-audio-summary': tuple() },
      method: 'POST',
      url: '/api/assistant/turn',
    }),
    res = response();
  const sample = metrics.track(req, res),
    request = {
      text: 'Запиши клиента',
      policyVersion: f.scope.policyVersion,
      taskRequestId: randomUUID(),
    };
  let reply;
  await routes
    .find((r) => r.path === '/api/assistant/turn')
    .handle({
      ...f.context,
      req,
      res,
      platform: { ...f.context.platform, assistant: f.api },
      recordAssistantPlayback: sample.playback,
      readBody: async () => request,
      json(_res, status, value) {
        assert.equal(status, 200);
        reply = value;
      },
    });
  assert.ok(reply.dialogue);
  assert.equal(reply.action, null);
  assert.equal(metrics.assistantSnapshot().playbackSummary.samples, 1);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
  assert.equal(f.fixture.calls.llm, 0);
  assert.equal(f.fixture.calls.stt, 0);
  assert.equal(f.pcmCalls(), 0);
});

test('first and later failure signatures keep native-event samples separate', () => {
  const m = createAssistantPlaybackMetrics();
  m.record(current, body(), tuple({ 2: 1, 3: 1, 7: 0, 8: 0, 16: 1 }));
  m.record(current, body(), tuple({ 2: 0, 3: 0, 7: 1, 8: 290, 16: 0, 19: 1 }));
  const s = m.snapshot();
  assert.equal(s.samples, 2);
  assert.equal(s.firstUnderflowOnly, 1);
  assert.equal(s.firstFalsePauseOnly, 0);
  assert.equal(s.laterUnderflowOnly, 0);
  assert.equal(s.laterFalsePauseOnly, 1);
  assert.equal(s.firstNativeEvent, 1);
  assert.equal(s.laterNativeEvent, 1);
  for (const key of ['firstBoth', 'firstNeither', 'laterBoth', 'laterNeither'])
    assert.equal(s[key], 0);
  assert.equal(s.underruns, 1);
  assert.equal(s.falsePauseTotalMs, 290);
  assert.doesNotMatch(JSON.stringify(s), /private|taskRequestId|dialogue|sessionId|token|hash/i);
  m.close();
});

const tupleV2 = (changes = {}) => tuple({ 0: 2, 20: 1, 21: 0, 22: 0, 23: 0, ...changes });
test('v2 accepts exactly24 bounded integers while retaining exact v1', () => {
  assert.equal(parsePlaybackSummary(tuple()).length, 20);
  assert.equal(parsePlaybackSummary(tupleV2()).length, 24);
  for (const header of [
    tupleV2({ 0: 3 }),
    tupleV2({ 0: 1 }),
    tupleV2({ 20: 0 }),
    tupleV2({ 20: 4 }),
    tupleV2({ 21: 150002 }),
    tupleV2({ 22: -1 }),
    tupleV2({ 23: 0.5 }),
    tupleV2().split(',').slice(0, 23).join(','),
    tupleV2() + ',0',
    tupleV2().replace(/,0$/, ','),
    tupleV2().replace(/,0$/, ', '),
    tupleV2({ 3: 101 }),
  ])
    assert.equal(parsePlaybackSummary(header), null);
  assert.ok(parsePlaybackSummary(tupleV2({ 21: 150001, 22: 1, 23: 150001 })));
});
test('v2 fixed formats preserve first/later classes and separate reported-start offsets from counts', () => {
  const m = createAssistantPlaybackMetrics();
  m.record(current, body(), tuple()); // Published v1 producer only observed PCM.
  m.record(current, body(), tupleV2({ 20: 1, 2: 1, 3: 1, 7: 0, 16: 0, 21: 1 }));
  m.record(current, body(), tupleV2({ 20: 2, 2: 0, 3: 0, 7: 1, 16: 0, 18: 1, 22: 291, 23: 151 }));
  m.record(current, body(), tupleV2({ 20: 2, 2: 1, 3: 0, 7: 0, 16: 0 }));
  m.record(current, body(), tupleV2({ 20: 3, 2: 0, 3: 0, 7: 0, 16: 0 }));
  const s = m.snapshot();
  assert.equal(s.samples, 5);
  assert.equal(s.formatPcmSamples, 2);
  assert.equal(s.formatPcmFirstUnderflowOnly, 1);
  assert.equal(s.formatPcmFirstSamples, 2);
  assert.equal(s.formatNativeMediaLaterFalsePauseOnly, 1);
  assert.equal(s.formatNativeMediaLaterNativeEvent, 1);
  assert.equal(s.formatNativeMediaFirstSamples, 1);
  assert.equal(s.formatNativeMediaFirstNeither, 1);
  assert.equal(
    s.formatNativeMediaFirstNativeEvent,
    0,
    'native format alone does not invent an event',
  );
  assert.equal(s.formatLocalSpeechLaterNeither, 1);
  assert.equal(s.firstUnderrunAfterReportedStartSamples, 1);
  assert.equal(s.firstUnderrunAfterReportedStartTotalMs, 0, 'wire1 means observed at0ms');
  assert.equal(s.firstBargePauseAfterReportedStartSamples, 1);
  assert.equal(s.firstBargePauseAfterReportedStartTotalMs, 290);
  assert.equal(s.firstBargePauseAfterReportedStartMaxMs, 290);
  assert.equal(s.firstNativeAfterReportedStartSamples, 1);
  assert.equal(s.firstNativeAfterReportedStartTotalMs, 150);
  assert.ok(Object.values(s).every(Number.isSafeInteger));
  assert.doesNotMatch(JSON.stringify(s), /private|utterance|taskRequestId|sessionId|token|hash/i);
  m.close();
});
test('v1/v2 same accepted identity deduplicates across version, format and window reset', () => {
  const m = createAssistantPlaybackMetrics(),
    request = body();
  assert.equal(m.record(current, request, tuple()), true);
  m.snapshot(true);
  assert.equal(m.record(current, request, tupleV2({ 20: 2, 23: 100 })), false);
  const another = body();
  assert.equal(m.record(current, another, tupleV2({ 20: 3, 21: 150001, 22: 0, 23: 0 })), true);
  assert.equal(m.record(current, another, tuple()), false);
  const s = m.snapshot();
  assert.equal(s.samples, 1);
  assert.equal(s.formatLocalSpeechSamples, 1);
  assert.equal(s.firstUnderrunAfterReportedStartSamples, 1);
  assert.equal(s.firstUnderrunAfterReportedStartMaxMs, 150000);
  assert.equal(s.firstBargePauseAfterReportedStartSamples, 0);
  assert.equal(s.firstNativeAfterReportedStartSamples, 0);
  m.close();
});
test('authorized HTTP v2 succeeds, malformed v2 is nonfatal and version replay counts once', async () => {
  const m = createRequestMetrics({ assistantEnabled: true });
  try {
    const request = body();
    assert.equal(
      (await httpTurn(m, { request, header: tupleV2({ 20: 2, 7: 0, 16: 0, 18: 1, 23: 51 }) }))
        .status,
      200,
    );
    let s = m.assistantSnapshot().playbackSummary;
    assert.equal(s.samples, 1);
    assert.equal(s.formatNativeMediaFirstNativeEvent, 1);
    assert.equal(s.firstNativeAfterReportedStartTotalMs, 50);
    assert.equal((await httpTurn(m, { request, header: tuple() })).status, 200);
    assert.equal(m.assistantSnapshot().playbackSummary.samples, 1);
    assert.equal((await httpTurn(m, { header: tupleV2({ 20: 4 }) })).status, 200);
    assert.equal(m.assistantSnapshot().playbackSummary.samples, 1);
  } finally {
    m.close();
  }
});

test('accepted dialogue-only context is bounded and explicit malformed task never falls back', () => {
  const m = createAssistantPlaybackMetrics(),
    request = { dialogueId: 'private-dialogue', dialogueVersion: 0 };
  assert.equal(m.record(current, request, tupleV2()), true);
  m.snapshot(true);
  assert.equal(m.record(current, request, tupleV2()), false);
  assert.equal(m.record(current, { ...request, dialogueVersion: 1 }, tupleV2()), true);
  for (const taskRequestId of [null, '', 'malformed', 42])
    assert.equal(
      m.record(current, { ...request, dialogueVersion: 2, taskRequestId }, tupleV2()),
      false,
    );
  for (const bad of [
    {},
    { dialogueId: '', dialogueVersion: 0 },
    { dialogueId: '  ', dialogueVersion: 0 },
    { dialogueId: 'x'.repeat(65), dialogueVersion: 0 },
    { dialogueId: 'private-dialogue' },
    { dialogueId: 'private-dialogue', dialogueVersion: -1 },
    { dialogueId: 'private-dialogue', dialogueVersion: 0.5 },
  ])
    assert.equal(m.record(current, bad, tupleV2()), false);
  const paid = { ...request, taskRequestId: randomUUID() };
  assert.equal(m.record(current, paid, tupleV2()), true, 'paid UUID namespace remains separate');
  assert.equal(m.record(current, paid, tuple()), false);
  assert.doesNotMatch(
    JSON.stringify(m.snapshot()),
    /private|dialogueId|sessionId|taskRequestId|hash|token/i,
  );
  m.close();
});
test('actual HTTP test-grant continuation without task UUID records and retries once', async (t) => {
  const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
  const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
  const f = await assistantBoundariesFixture(null);
  t.after(() => f.close());
  const synthetic = dialogueFixture(),
    clinic = synthetic.c.tenantStore();
  const realContext = {
    current: f.current('owner'),
    platform: { ...f.store, ...synthetic.c.platform, assistant: f.api },
    tenantStore: () => clinic,
  };
  const m = createRequestMetrics({ assistantEnabled: true });
  t.after(() => m.close());
  const initial = await httpTurn(m, {
    realContext,
    request: { text: 'Запиши клиента', policyVersion: f.revision() },
    header: tupleV2(),
  });
  assert.equal(initial.status, 200);
  assert.ok(initial.reply.dialogue);
  assert.equal(initial.reply.taskRequestId, undefined);
  assert.equal(
    m.assistantSnapshot().playbackSummary.samples,
    0,
    'no invented initial task identity',
  );
  const request = {
    text: 'Повтори',
    policyVersion: f.revision(),
    dialogueId: initial.reply.dialogue.id,
    dialogueVersion: initial.reply.dialogue.version,
  };
  const first = await httpTurn(m, { realContext, request, header: tupleV2({ 20: 2 }) });
  assert.equal(first.status, 200);
  assert.ok(first.reply.dialogue);
  assert.equal(first.reply.taskRequestId, undefined);
  assert.equal(m.assistantSnapshot().playbackSummary.samples, 1);
  assert.equal(
    (await httpTurn(m, { realContext, request, header: tupleV2({ 20: 2 }) })).status,
    200,
  );
  assert.equal(m.assistantSnapshot().playbackSummary.samples, 1);
  m.assistantSnapshot({ reset: true });
  assert.equal(
    (await httpTurn(m, { realContext, request, header: tupleV2({ 20: 2 }) })).status,
    200,
  );
  assert.equal(m.assistantSnapshot().playbackSummary.samples, 0);
  const next = await httpTurn(m, {
    realContext,
    request: { ...request, dialogueVersion: first.reply.dialogue.version },
    header: tupleV2({ 20: 2 }),
  });
  assert.equal(next.status, 200);
  assert.equal(m.assistantSnapshot().playbackSummary.samples, 1);
  assert.equal(f.calls.llm, 0);
  assert.equal(f.calls.stt, 0);
  assert.equal(f.calls.tts, 0);
});
