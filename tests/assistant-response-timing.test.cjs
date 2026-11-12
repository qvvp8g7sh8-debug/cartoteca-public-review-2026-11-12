const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const {
  createAssistantResponseTiming,
} = require('../src/server/http/assistant-timing-response.cjs');
const { createRequestHandler } = require('../src/server/http/request-handler.cjs');

function response() {
  return Object.assign(new EventEmitter(), {
    headers: {},
    headersSent: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      if (headers && typeof headers === 'object') Object.assign(this.headers, headers);
      this.headersSent = true;
      return this;
    },
    end(value) {
      this.body = value;
      this.writableEnded = true;
      this.emit('finish');
    },
  });
}

test('request timing exports only bounded fixed numeric phases, sums repeated spans and ignores private labels', () => {
  let clock = 10;
  const res = response();
  const timing = createAssistantResponseTiming(
    { method: 'POST', url: '/api/assistant/turn?private' },
    res,
    undefined,
    { now: () => clock },
  );
  const end = timing.begin('access', 'turn', 'none');
  clock = 15;
  end();
  end();
  const second = timing.begin('access', 'turn', 'none');
  clock = 22;
  second();
  timing.begin('private-patient-name', 'turn', 'none')();
  timing.begin('domain', 'turn', 'private-provider')();
  const read = timing.begin('data-read', 'turn', 'none');
  clock = 200000;
  read();
  const result = res.writeHead(200, { 'Content-Type': 'application/json' });
  assert.equal(result, res);
  assert.equal(
    res.headers['Server-Timing'],
    'ct_request;dur=150000.0, ct_access;dur=12.0, ct_data_read;dur=150000.0',
  );
  assert.doesNotMatch(res.headers['Server-Timing'], /private|patient|provider|query|token|id|desc/);
});

test('two requests stay independent and stream headers do not pretend future settlement was measured', () => {
  let clock = 0;
  const observed = [];
  const aggregate = { begin: (stage) => (outcome) => observed.push({ stage, outcome }) };
  const a = response(),
    b = response();
  const first = createAssistantResponseTiming(
    { method: 'GET', url: '/api/assistant/speak-audio?ticket=private' },
    a,
    aggregate,
    { now: () => clock },
  );
  clock = 3;
  const second = createAssistantResponseTiming(
    { method: 'POST', url: '/api/assistant/turn' },
    b,
    aggregate,
    { now: () => clock },
  );
  const provider = first.begin('provider-first-byte', 'tts', 'timeweb');
  clock = 10;
  provider();
  const settlement = first.begin('settlement', 'tts', 'timeweb');
  a.writeHead(200);
  assert.equal(a.headers['Server-Timing'], 'ct_request;dur=10.0, ct_provider_first_byte;dur=7.0');
  clock = 40;
  settlement();
  const read = second.begin('data-read', 'turn', 'none');
  clock = 42;
  read();
  b.writeHead(200);
  assert.equal(b.headers['Server-Timing'], 'ct_request;dur=39.0, ct_data_read;dur=2.0');
  assert.doesNotMatch(a.headers['Server-Timing'], /settlement/);
  assert.deepEqual(
    observed.map((x) => x.stage),
    ['provider-first-byte', 'settlement', 'data-read'],
  );
});

test('unrelated routes never start a clock and denied/failed assistant responses disclose no timing header', () => {
  const aggregate = { begin() {} };
  for (const [method, url] of [
    ['GET', '/api/assistant/turn'],
    ['POST', '/api/assistant/turn-more'],
    ['GET', '/api/assistant/scope'],
    ['POST', '/api/admin/voice-assistant/settings'],
  ]) {
    const res = response(),
      original = res.writeHead;
    assert.equal(
      createAssistantResponseTiming({ method, url }, res, aggregate, {
        now: () => assert.fail('Unrelated timing clock'),
      }),
      aggregate,
    );
    assert.equal(res.writeHead, original);
  }
  for (const status of [401, 403, 409, 429, 500, 503]) {
    const res = response();
    createAssistantResponseTiming({ method: 'POST', url: '/api/assistant/turn' }, res, aggregate);
    res.writeHead(status);
    assert.equal(res.headers['Server-Timing'], undefined);
  }
});

test('clock, aggregate and header observer failures never change response behavior', () => {
  const res = response();
  let reads = 0;
  const timing = createAssistantResponseTiming(
    { method: 'POST', url: '/api/assistant/speak' },
    res,
    {
      begin() {
        throw Error('Observer unavailable');
      },
    },
    {
      now() {
        if (++reads > 2) throw Error('Clock unavailable');
        return 3;
      },
    },
  );
  const end = timing.begin('domain', 'turn', 'none');
  assert.doesNotThrow(end);
  assert.equal(res.writeHead(200), res);
  assert.equal(res.status, 200);
  const broken = response();
  createAssistantResponseTiming({ method: 'POST', url: '/api/assistant/speak' }, broken);
  broken.setHeader = () => {
    throw Error('Header observer unavailable');
  };
  assert.equal(broken.writeHead(200), broken);
  assert.equal(broken.status, 200);
});

async function routed({
  path = '/api/assistant/turn',
  method = 'POST',
  authenticated = true,
  denied = false,
} = {}) {
  const current = {
    accountId: 'synthetic-account',
    organizationId: 'synthetic-org',
    role: 'owner',
    globalAdmin: false,
  };
  const req = Object.assign(Readable.from([]), {
    method,
    url:
      path +
      (method === 'GET'
        ? '?accountContext=synthetic-account&organizationContext=synthetic-org'
        : ''),
    complete: true,
    aborted: false,
    socket: { localPort: 4197 },
    headers: {
      host: '127.0.0.1:4197',
      origin: 'http://127.0.0.1:4197',
      'x-cartoteca-request': '1',
      'x-cartoteca-account-id': current.accountId,
      'x-cartoteca-organization-id': current.organizationId,
      cookie: 'cartoteca_v2_session=synthetic-session',
      'content-type': 'application/json',
    },
  });
  const res = response(),
    noop = () => {};
  const handler = createRequestHandler({
    config: { origin: 'http://127.0.0.1:4197' },
    platform: { session: () => (authenticated ? current : null) },
    pool: { lease: () => ({ get: noop, release: noop }) },
    metrics: { track: () => ({ route: noop, stage: noop, phase: noop, failure: noop }) },
    requestDispatcher: { run: (fn) => Promise.resolve().then(fn) },
    clientAddress: () => '127.0.0.1',
    services: {},
    routes: [
      {
        method,
        path,
        access: 'organization',
        async handle(c) {
          const end = c.assistantTiming.begin('data-read', 'turn', 'none');
          await Promise.resolve();
          end();
          c.assertCurrent();
          if (denied) throw Object.assign(Error('Feature disabled'), { status: 403 });
          return c.json(c.res, 200, { ok: true });
        },
      },
    ],
  });
  await handler(req, res);
  return res;
}

test('real request-handler wiring emits successful local headers with global metrics off, preserves authorization/errors', async () => {
  for (const [method, path] of [
    ['POST', '/api/assistant/transcribe'],
    ['POST', '/api/assistant/turn'],
    ['POST', '/api/assistant/speak'],
    ['GET', '/api/assistant/speak-audio'],
  ]) {
    const res = await routed({ method, path });
    assert.equal(res.status, 200);
    assert.match(
      res.headers['Server-Timing'],
      /^ct_request;dur=\d+\.\d, ct_data_read;dur=\d+\.\d$/,
    );
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.doesNotMatch(res.headers['Server-Timing'], /synthetic|session|account|org/);
  }
  for (const options of [{ authenticated: false }, { denied: true }]) {
    const res = await routed(options);
    assert.equal(res.status, options.denied ? 403 : 401);
    assert.equal(res.headers['Server-Timing'], undefined);
  }
});
