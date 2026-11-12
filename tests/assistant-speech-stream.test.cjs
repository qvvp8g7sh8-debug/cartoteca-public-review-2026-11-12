const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createSpeechService,
  speechPayload,
} = require('../src/server/modules/assistant/speech/speech-service.cjs');
const {
  createSpeechOutput,
  streamTimewebSpeech,
  MAX_AUDIO_BYTES,
} = require('../src/server/modules/assistant/providers/timeweb/timeweb-speech-stream.cjs');
const MP3 = Buffer.alloc(417);
Buffer.from([255, 251, 144, 100]).copy(MP3);
function response(bytes = MP3, type = 'audio/mpeg') {
  return new Response(bytes, { headers: { 'content-type': type } });
}
function context(current) {
  const req = new EventEmitter(),
    res = new EventEmitter();
  Object.assign(res, {
    headersSent: false,
    destroyed: false,
    chunks: [],
    writeHead(status, headers) {
      this.headersSent = true;
      this.status = status;
      this.headers = headers;
    },
    write(bytes) {
      this.chunks.push(Buffer.from(bytes));
      return true;
    },
    end() {
      this.writableFinished = true;
    },
    destroy() {
      this.destroyed = true;
      this.emit('close');
    },
  });
  return {
    req,
    res,
    current: current || { accountId: 'a', organizationId: 'o', sessionId: 's', role: 'owner' },
  };
}
function fixture({
  fetchImpl = async () => response(),
  provider = 'timeweb',
  authorizeSpeech,
  ticketCapacity,
} = {}) {
  const state = {
    revision: 1,
    providers: { tts: { provider, model: 'test-tts', voice: 'alloy' } },
    credentials: { timeweb: 'synthetic-key' },
    policy: { limits: { maxReplyChars: 600, requestTimeoutMs: 1000 } },
    rates: { ttsInput: 81, ttsOutput: 1620 },
  };
  let allowed = true;
  const reservations = [],
    settled = [];
  const scope = (_c, version) => {
    if (!allowed) throw Object.assign(new Error('Synthetic access revoked'), { status: 403 });
    if (version !== state.revision)
      throw Object.assign(new Error('Synthetic stale policy'), { status: 409 });
    return { state, member: { membershipId: 'm' } };
  };
  const budget = {
    reserve(_c, _v, _k, amount) {
      const r = { amount };
      reservations.push(r);
      return r;
    },
    settle(r, amount) {
      settled.push({ reservation: r, amount });
    },
  };
  const api = createSpeechService({
    scope,
    budget,
    fetchImpl,
    authorizeSpeech,
    ticketCapacity,
    invoke: async (_c, _v, _k, _s, _p, _r, demo) => ({ ...demo(), demo: true, usage: {} }),
  });
  const c = context();
  return {
    api,
    c,
    state,
    reservations,
    settled,
    revoke() {
      allowed = false;
    },
    async ticket(text = 'На какую дату?') {
      const result = await api.speak(c, { text, policyVersion: 1, stream: true });
      const get = context(c.current);
      get.url = new URL(result.streamUrl, 'http://localhost');
      return { result, get };
    },
  };
}
test('direct PCM streams without a ticket and shares the existing generic cache and settlement', async () => {
  let calls = 0;
  const pcm = Buffer.alloc(4800, 1);
  const f = fixture({
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).response_format, 'pcm');
      return response(pcm, 'audio/pcm');
    },
  });
  const body = { text: 'На какую дату?', policyVersion: 1, format: 'pcm' };
  await f.api.speakPcm(f.c, body);
  assert.equal(f.c.res.headers['Content-Type'], 'audio/pcm');
  assert.equal(f.c.res.headers['X-Audio-Sample-Rate'], '24000');
  assert.equal(f.c.res.headers['X-Assistant-Policy-Version'], '1');
  assert.deepEqual(Buffer.concat(f.c.res.chunks), pcm);
  assert.equal(f.c.res.writableFinished, true);
  assert.equal(f.api.stats().active, 0);
  assert.ok(f.settled[0].amount > 0);
  const second = context(f.c.current);
  await f.api.speakPcm(second, body);
  assert.equal(calls, 1);
  assert.equal(f.reservations[1].amount, 0);
  assert.equal(f.settled[1].amount, 0);
  assert.deepEqual(Buffer.concat(second.res.chunks), pcm);
});
test('direct PCM route reads bounded JSON and keeps normal completed request close from cancelling output', async () => {
  const { routes } = require('../src/server/modules/assistant/routes.cjs');
  const route = routes.find(
    (row) => row.method === 'POST' && row.path === '/api/assistant/speak-audio',
  );
  assert.equal(route.access, 'organization');
  const c = context();
  c.req.complete = true;
  c.readBody = async (_req, limit) => {
    assert.equal(limit, 8192);
    return { text: 'Синтетический ответ.', policyVersion: 1, format: 'pcm' };
  };
  c.json = () => assert.fail('a completed audio response must not get a second JSON response');
  c.platform = {
    assistant: {
      async speakPcm(owned, body) {
        assert.equal(body.format, 'pcm');
        owned.req.emit('close');
        assert.equal(owned.transportAbortSignal.aborted, false);
        owned.res.end();
        owned.res.writableEnded = true;
      },
    },
  };
  await route.handle(c);
  assert.equal(c.res.writableFinished, true);
});
test('direct PCM refuses invalid mode, stale access and invalid speech proof before spend', async () => {
  let calls = 0;
  const f = fixture({
    fetchImpl: async () => {
      calls++;
      return response(Buffer.alloc(4800), 'audio/pcm');
    },
    authorizeSpeech(_c, proof) {
      assert.equal(proof.text, 'На какую дату?');
      if (proof.speechToken !== 'synthetic-permit')
        throw Object.assign(new Error('Synthetic invalid permit'), { status: 403 });
    },
  });
  const body = { text: 'На какую дату?', policyVersion: 1, format: 'pcm' };
  await assert.rejects(f.api.speakPcm(f.c, { ...body, format: 'mp3' }), { status: 400 });
  await assert.rejects(f.api.speakPcm(f.c, { ...body, policyVersion: 0 }), { status: 409 });
  await assert.rejects(f.api.speakPcm(f.c, body), { status: 403 });
  f.revoke();
  await assert.rejects(f.api.speakPcm(f.c, { ...body, speechToken: 'synthetic-permit' }), {
    status: 403,
  });
  assert.equal(calls, 0);
  assert.equal(f.reservations.length, 0);
});
test('direct PCM bounds active session/global ingress before spend and releases leases after completion', async () => {
  for (const capacity of [1, 8]) {
    const count = capacity === 1 ? 1 : 4;
    const upstream = [];
    let arrived;
    const f = fixture({
      ticketCapacity: capacity,
      fetchImpl: async () => {
        const result = new Promise((resolve) => upstream.push(resolve));
        arrived();
        return result;
      },
    });
    const body = { text: 'Синтетический ответ.', policyVersion: 1, format: 'pcm' };
    const running = [];
    for (let index = 0; index < count; index++) {
      const entered = new Promise((resolve) => {
        arrived = resolve;
      });
      running.push(f.api.speakPcm(context(f.c.current), body));
      await entered;
    }
    const overflow = context({ ...f.c.current, sessionId: capacity === 1 ? 'other' : 's' });
    await assert.rejects(f.api.speakPcm(overflow, body), {
      status: 503,
      code: 'ASSISTANT_DIRECT_SPEECH_CAPACITY',
    });
    assert.equal(f.reservations.length, count);
    assert.equal(upstream.length, count);
    for (const resolve of upstream) resolve(response(Buffer.alloc(4800), 'audio/pcm'));
    await Promise.all(running);
    const entered = new Promise((resolve) => {
      arrived = resolve;
    });
    const next = f.api.speakPcm(context(f.c.current), body);
    await entered;
    upstream.at(-1)(response(Buffer.alloc(4800), 'audio/pcm'));
    await next;
    assert.equal(f.reservations.length, count + 1);
  }
});
test('direct PCM validates live scope after provider wait before sending bytes', async () => {
  let f;
  f = fixture({
    fetchImpl: async () => {
      f.revoke();
      return response(Buffer.alloc(4800), 'audio/pcm');
    },
  });
  await assert.rejects(
    f.api.speakPcm(f.c, { text: 'На какую дату?', policyVersion: 1, format: 'pcm' }),
    { status: 403 },
  );
  assert.equal(f.c.res.chunks.length, 0);
  assert.equal(f.c.res.headersSent, false);
  assert.equal(f.settled.length, 1);
});
test('direct PCM stops on disconnect without replaying the provider request', async () => {
  let calls = 0;
  const f = fixture({
    fetchImpl: async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
        queueMicrotask(() => f.c.res.destroy());
      });
    },
  });
  await assert.rejects(
    f.api.speakPcm(f.c, { text: 'Синтетический ответ.', policyVersion: 1, format: 'pcm' }),
    { status: 499 },
  );
  assert.equal(calls, 1);
  assert.equal(f.c.res.chunks.length, 0);
  assert.equal(f.settled.length, 1);
});
test('stream ticket is free until GET; success settles actual bytes and a new ticket uses cache without provider', async () => {
  let calls = 0;
  const f = fixture({
    fetchImpl: async () => {
      calls++;
      return response();
    },
  });
  const first = await f.ticket();
  assert.equal(calls, 0);
  assert.equal(f.reservations.length, 0);
  await f.api.speakAudio(first.get);
  assert.equal(calls, 1);
  assert.equal(first.get.res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(first.get.res.headers['Cache-Control'], 'no-store');
  assert.ok(f.settled[0].amount > 0);
  const expected =
    (Buffer.byteLength(JSON.stringify(speechPayload('На какую дату?'))) * 81 + 1620) / 1000000;
  assert.equal(f.settled[0].amount, expected);
  assert.ok(f.settled[0].amount < f.reservations[0].amount);
  await assert.rejects(f.api.speakAudio(first.get), { status: 410 });
  await f.api.speakAudio((await f.ticket()).get);
  assert.equal(calls, 1);
  assert.equal(f.reservations[1].amount, 0);
  assert.equal(f.settled[1].amount, 0);
});
test('fresh access is required even for cached speech and before provider outbound', async () => {
  let calls = 0;
  const f = fixture({
    fetchImpl: async () => {
      calls++;
      return response();
    },
  });
  await f.api.speakAudio((await f.ticket()).get);
  const second = await f.ticket();
  f.revoke();
  await assert.rejects(f.api.speakAudio(second.get), { status: 403 });
  assert.equal(calls, 1);
  assert.equal(f.reservations.length, 1);
});
test('stream URLs preserve the issuing actor and exact query parameters before native playback', async () => {
  const f = fixture();
  f.c.current.accountId = 'synthetic account/А';
  f.c.current.organizationId = 'synthetic org/&';
  const { result, get } = await f.ticket();
  assert.deepEqual(
    [...get.url.searchParams.keys()],
    ['ticket', 'accountContext', 'organizationContext'],
  );
  assert.equal(get.url.searchParams.get('accountContext'), f.c.current.accountId);
  assert.equal(get.url.searchParams.get('organizationContext'), f.c.current.organizationId);
  assert.match(result.streamUrl, /accountContext=synthetic%20account%2F/);
  await f.api.speakAudio(get);
  assert.equal(get.res.status, 200);
});
test('ambiguous native query parameters are refused without consuming the ticket or reserving provider spend', async () => {
  for (const change of [
    (url) => url.searchParams.delete('accountContext'),
    (url) => url.searchParams.delete('organizationContext'),
    (url) => url.searchParams.append('ticket', 'a'.repeat(43)),
    (url) => url.searchParams.append('accountContext', 'a'),
    (url) => url.searchParams.append('organizationContext', 'o'),
    (url) => url.searchParams.append('extra', '1'),
  ]) {
    let outbound = 0;
    const f = fixture({
      fetchImpl: async () => {
        outbound++;
        return response();
      },
    });
    const { get } = await f.ticket(),
      original = get.url.href;
    change(get.url);
    await assert.rejects(f.api.speakAudio(get), { status: 400 });
    assert.equal(outbound, 0);
    assert.equal(f.reservations.length, 0);
    get.url = new URL(original);
    await f.api.speakAudio(get);
    assert.equal(outbound, 1, 'malformed request did not consume the issuing account ticket');
  }
});
test('a borrowed native URL cannot consume its ticket in another account or organization', async () => {
  for (const property of ['accountId', 'organizationId']) {
    let outbound = 0;
    const f = fixture({
      fetchImpl: async () => {
        outbound++;
        return response();
      },
    });
    const { get } = await f.ticket();
    const original = get.current;
    get.current = { ...original, [property]: 'synthetic-other' };
    await assert.rejects(f.api.speakAudio(get), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      outcomeUnknown: false,
    });
    assert.equal(outbound, 0);
    assert.equal(f.reservations.length, 0);
    get.current = original;
    await f.api.speakAudio(get);
    assert.equal(outbound, 1);
  }
});
test('legacy/demo speak remains buffered even if stream was requested', async () => {
  const f = fixture({ provider: 'demo' });
  const reply = await f.api.speak(f.c, { text: 'Ответ', policyVersion: 1, stream: true });
  assert.equal(reply.demo, true);
  assert.equal(reply.audioBase64, null);
  assert.equal(reply.streamUrl, undefined);
});
test('provider MP3 is emitted before EOF and requested in MP3 format', async () => {
  let finish,
    outbound = 0,
    body;
  const tail = new Promise((resolve) => {
      finish = resolve;
    }),
    writes = [];
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(MP3);
      await tail;
      controller.enqueue(MP3);
      controller.close();
    },
  });
  const output = {
    signal: new AbortController().signal,
    check() {},
    wait: (p) => p,
    async write(bytes) {
      writes.push(bytes);
      finish();
    },
  };
  const result = await streamTimewebSpeech({
    provider: { model: 'm', voice: 'alloy' },
    key: 'synthetic',
    payload: { input: 'На какую дату?' },
    output,
    collect: true,
    onOutbound: () => {
      outbound++;
    },
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(stream, { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  assert.equal(body.response_format, 'mp3');
  assert.equal(outbound, 1);
  assert.equal(writes.length, 2);
  assert.equal(result.byteLength, MP3.length * 2);
  assert.equal(result.bytes.length, MP3.length * 2);
});
test('WAV, JSON and oversized provider responses fail before any client audio bytes', async () => {
  for (const [bytes, type, length] of [
    [Buffer.from('RIFFxxxxWAVE'), 'audio/mpeg'],
    [Buffer.from('{"error":"synthetic"}'), 'application/json'],
    [MP3, 'audio/mpeg', String(MAX_AUDIO_BYTES + 1)],
  ]) {
    const writes = [],
      output = {
        signal: new AbortController().signal,
        check() {},
        wait: (p) => p,
        async write(b) {
          writes.push(b);
        },
      };
    await assert.rejects(
      streamTimewebSpeech({
        provider: { model: 'm', voice: 'a' },
        key: 'synthetic',
        payload: {},
        output,
        fetchImpl: async () =>
          new Response(bytes, {
            headers: { 'content-type': type, ...(length ? { 'content-length': length } : {}) },
          }),
      }),
      { status: 502 },
    );
    assert.equal(writes.length, 0);
  }
});
test('client disconnect aborts upstream and backpressure resumes only on drain', async () => {
  const c = context();
  let checks = 0;
  c.res.write = () => false;
  const output = createSpeechOutput(
    c,
    () => {
      checks++;
    },
    1000,
  );
  try {
    let completed = false;
    const write = output.write(MP3).then(() => {
      completed = true;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    c.res.emit('drain');
    await write;
    assert.equal(completed, true);
    assert.ok(checks >= 2);
    c.res.emit('close');
    assert.equal(output.signal.aborted, true);
    assert.throws(output.check, { status: 499 });
  } finally {
    output.dispose();
  }
});

test('paid streaming keeps exact speech proof until GET and refuses a changed package before spend', async () => {
  const {
    createSpeechPermits,
  } = require('../src/server/modules/assistant/speech/speech-permits.cjs');
  const permits = createSpeechPermits(),
    ticket = { id: 'task', grantId: 'grant', attempt: 1 };
  let calls = 0,
    authorized = 0;
  const f = fixture({
    fetchImpl: async () => {
      calls++;
      return response();
    },
    authorizeSpeech(c, body) {
      authorized++;
      permits.requirePermit(c, ticket, body);
      return { ticket, outbound: true };
    },
  });
  const permit = permits.issue(f.c, ticket, { text: 'На какую дату?', policyVersion: 1 }, 600),
    body = {
      text: 'На какую дату?',
      policyVersion: 1,
      stream: true,
      speechToken: permit.token,
      taskRequestId: 'synthetic-task-request',
    };
  await assert.rejects(f.api.speak(f.c, { ...body, text: 'Посторонний текст' }), { status: 403 });
  const first = await f.api.speak(f.c, body),
    get = context(f.c.current);
  get.url = new URL(first.streamUrl, 'http://localhost');
  await f.api.speakAudio(get);
  assert.equal(calls, 1);
  assert.ok(authorized > 2);
  const second = await f.api.speak(f.c, body),
    stale = context(f.c.current);
  stale.url = new URL(second.streamUrl, 'http://localhost');
  ticket.grantId = 'new-package';
  await assert.rejects(f.api.speakAudio(stale), { status: 403 });
  assert.equal(calls, 1);
  assert.equal(f.reservations.length, 1);
});
