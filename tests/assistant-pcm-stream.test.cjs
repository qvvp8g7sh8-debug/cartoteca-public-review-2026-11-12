const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSpeechService, speechPayload } = require('../src/server/modules/assistant/speech/speech-service.cjs');
const { createSpeechTickets, speechIdentity } = require('../src/server/modules/assistant/speech/speech-tickets.cjs');
const { createSpeechCache } = require('../src/server/modules/assistant/speech/speech-cache.cjs');
const { streamTimewebSpeech, MAX_AUDIO_BYTES } = require('../src/server/modules/assistant/providers/timeweb/timeweb-speech-stream.cjs');
const MP3 = Buffer.alloc(417);
Buffer.from([255, 251, 144, 100]).copy(MP3);
const PCM = Buffer.from([0, 0, 255, 127, 0, 128, 255, 255]);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function context(current = { accountId: 'a', organizationId: 'o', sessionId: 's', role: 'owner' }) {
  const req = new EventEmitter(), res = new EventEmitter();
  Object.assign(res, {
    headersSent: false, destroyed: false, chunks: [],
    writeHead(code, headers) { this.headersSent = true; this.status = code; this.headers = headers; },
    write(bytes) { this.chunks.push(Buffer.from(bytes)); return true; },
    end() { this.writableFinished = true; },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  return { req, res, current };
}
function fixture(fetchImpl = async () => new Response(PCM, { headers: { 'content-type': 'audio/pcm' } })) {
  const state = {
    revision: 1, providers: { tts: { provider: 'timeweb', model: 'synthetic-model', voice: 'alloy' } },
    credentials: { timeweb: 'synthetic-key' },
    policy: { limits: { maxReplyChars: 600, requestTimeoutMs: 1000 } },
    rates: { ttsInput: 81, ttsOutput: 1620 },
  };
  const member = { membershipId: 'm' }, reservations = [], settled = [];
  let allowed = true;
  const scope = (_c, version) => {
    if (!allowed) throw Object.assign(Error('revoked'), { status: 403 });
    if (version !== state.revision) throw Object.assign(Error('stale'), { status: 409 });
    return { state, member };
  };
  const api = createSpeechService({
    scope, fetchImpl,
    budget: {
      reserve(_c, _v, _kind, amount) { const r = { amount }; reservations.push(r); return r; },
      settle(reservation, amount) { settled.push({ reservation, amount }); },
    },
    invoke: async () => assert.fail('PCM must not use the buffered invocation'),
  });
  const c = context();
  return {
    c, api, state, member, scope, reservations, settled,
    revoke() { allowed = false; },
    async ticket(format = 'pcm', text = 'На какую дату?') {
      const reply = await api.speak(c, { text, policyVersion: 1, stream: true, format });
      const get = context(c.current);
      get.url = new URL(reply.streamUrl, 'https://synthetic.invalid');
      return { reply, get };
    },
  };
}

test('PCM ticket declares exact format and is free until its single streaming GET', async () => {
  let sent, calls = 0;
  const f = fixture(async (_url, options) => {
    calls++; sent = JSON.parse(options.body);
    return new Response(PCM, { headers: { 'content-type': 'audio/pcm' } });
  });
  const { reply, get } = await f.ticket();
  assert.deepEqual(Object.fromEntries(['mimeType', 'sampleRate', 'channels', 'sampleFormat', 'playbackRate'].map((k) => [k, reply[k]])),
    { mimeType: 'audio/pcm', sampleRate: 24000, channels: 1, sampleFormat: 's16le', playbackRate: 1 });
  assert.equal(calls, 0); assert.equal(f.reservations.length, 0);
  await f.api.speakAudio(get);
  assert.equal(sent.response_format, 'pcm'); assert.equal(sent.speed, 1.4);
  assert.equal(get.res.headers['Content-Type'], 'audio/pcm');
  assert.equal(get.res.headers['X-Audio-Sample-Rate'], '24000');
  assert.equal(get.res.headers['X-Audio-Channels'], '1');
  assert.equal(get.res.headers['X-Audio-Sample-Format'], 's16le');
  assert.equal(get.res.headers['Cache-Control'], 'no-store');
  assert.equal(get.res.headers['Accept-Ranges'], 'none');
  assert.deepEqual(Buffer.concat(get.res.chunks), PCM);
  const inputCost = Buffer.byteLength(JSON.stringify(speechPayload(reply.text))) * 81;
  assert.equal(f.settled[0].amount, (inputCost + 1620) / 1000000);
  assert.ok(f.reservations[0].amount >= f.settled[0].amount);
  await assert.rejects(f.api.speakAudio(get), { status: 410 });
});

test('PCM aligned samples stream before EOF, including a sample split between network chunks', async () => {
  const gate = deferred(), writes = [];
  const stream = new ReadableStream({ async start(c) {
    c.enqueue(PCM.subarray(0, 3)); await gate.promise;
    c.enqueue(PCM.subarray(3)); c.close();
  } });
  const output = {
    signal: new AbortController().signal, check() {}, wait: (p) => p,
    async write(bytes) { writes.push(Buffer.from(bytes)); gate.resolve(); },
  };
  const result = await streamTimewebSpeech({
    format: 'pcm', provider: { model: 'm', voice: 'a' }, key: 'synthetic', payload: {},
    collect: true, output, fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'audio/pcm' } }),
  });
  assert.equal(writes[0].length, 2);
  assert.ok(writes.every((bytes) => bytes.length % 2 === 0));
  assert.deepEqual(Buffer.concat(writes), PCM);
  assert.deepEqual(result.bytes, PCM);
  assert.equal(result.seconds, PCM.length / 48000);
});

test('generic MP3 and PCM generations and completed cache entries never alias', async () => {
  const bodies = [];
  const f = fixture(async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return new Response(body.response_format === 'pcm' ? PCM : MP3,
      { headers: { 'content-type': body.response_format === 'pcm' ? 'audio/pcm' : 'audio/mpeg' } });
  });
  for (const format of ['mp3', 'pcm', 'mp3', 'pcm']) {
    const ticket = await f.ticket(format);
    await f.api.speakAudio(ticket.get);
    assert.deepEqual(Buffer.concat(ticket.get.res.chunks), format === 'pcm' ? PCM : MP3);
    assert.equal(ticket.reply.mimeType, format === 'pcm' ? 'audio/pcm' : 'audio/mpeg');
  }
  assert.deepEqual(bodies.map((body) => body.response_format), ['mp3', 'pcm']);
  assert.equal(bodies[0].speed, undefined);
  assert.equal(bodies[1].speed, 1.4);
  assert.equal(f.reservations[2].amount, 0); assert.equal(f.reservations[3].amount, 0);
  assert.equal(f.settled[2].amount, 0); assert.equal(f.settled[3].amount, 0);
});

test('a generic PCM owner disconnect cannot cancel its live follower or double-charge synthesis', async () => {
  let controller, calls = 0, upstreamSignal;
  const f = fixture(async (_url, options) => {
    calls++; upstreamSignal = options.signal;
    return new Response(new ReadableStream({ start(c) { controller = c; } }),
      { headers: { 'content-type': 'audio/pcm' } });
  });
  const first = await f.ticket();
  const firstDone = f.api.speakAudio(first.get).then(() => null, (e) => e);
  await flush(); controller.enqueue(PCM.subarray(0, 3)); await flush();
  assert.deepEqual(Buffer.concat(first.get.res.chunks), PCM.subarray(0, 2));
  const second = await f.ticket(), follower = f.api.speakAudio(second.get);
  await flush(); first.get.res.destroy(); await flush();
  assert.equal(upstreamSignal.aborted, false);
  controller.enqueue(PCM.subarray(3)); controller.close();
  await follower;
  assert.equal((await firstDone).status, 499);
  assert.deepEqual(Buffer.concat(second.get.res.chunks), PCM);
  assert.equal(calls, 1);
  assert.equal(f.reservations.length, 2); assert.equal(f.reservations[1].amount, 0);
  assert.equal(f.settled.filter((row) => row.amount > 0).length, 1);
  assert.equal(f.settled.filter((row) => row.amount === 0).length, 1);
});

test('ticket snapshot binds format to session identity; GET cannot override it', async () => {
  const f = fixture(), tickets = createSpeechTickets();
  assert.notEqual(speechIdentity(f.c, f.state, f.member, 'pcm'), speechIdentity(f.c, f.state, f.member, 'mp3'));
  const url = tickets.issue(f.c, f.state, f.member, 'Синтетический ответ', 'pcm');
  const taken = tickets.take(f.c, new URL(url, 'https://synthetic.invalid').searchParams.get('ticket'), f.scope);
  assert.equal(taken.ticket.format, 'pcm');
  const issued = await f.ticket();
  issued.get.url.searchParams.set('format', 'mp3');
  await assert.rejects(f.api.speakAudio(issued.get), { status: 400 });
  issued.get.url.searchParams.delete('format');
  await f.api.speakAudio(issued.get);
});

test('strict PCM options reject unsupported or coerced input without outbound or budget work', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response(PCM); });
  for (const body of [
    { format: 'wav', stream: true }, { format: ['pcm'], stream: true },
    { format: null, stream: true }, { format: 'pcm', stream: false },
    { format: 'pcm' }, { format: 'pcm', stream: true, speed: 2 },
    { format: 'pcm', stream: true, sampleRate: 16000 },
  ])
    await assert.rejects(f.api.speak(f.c, { text: 'Ответ', policyVersion: 1, ...body }), { status: 400 });
  f.state.providers.tts.provider = 'local';
  await assert.rejects(f.api.speak(f.c, { text: 'Ответ', policyVersion: 1, stream: true, format: 'pcm' }), { status: 400 });
  assert.equal(calls, 0); assert.equal(f.reservations.length, 0);
});

test('empty or truncated PCM does not enter cache and is not credited as successful speech', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 0, 1])]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++; return new Response(bytes, { headers: { 'content-type': 'audio/pcm' } });
    });
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(f.api.speakAudio((await f.ticket()).get), { status: 502 });
    assert.equal(calls, 2, 'failed EOF must not become a completed generic cache hit');
    assert.ok(f.settled.every((row) => row.amount === null), 'outbound failures retain conservative accounting');
  }
});

test('PCM rejects mismatched content types and oversized declared bodies before sending samples', async () => {
  for (const [mime, length] of [
    ['audio/mpeg;codec=mp3'], ['audio/wav'], ['application/json'], ['application/octet-stream'],
    ['audio/pcm;rate=16000'], ['audio/pcm', String(MAX_AUDIO_BYTES + 1)],
  ]) {
    const f = fixture(async () => new Response(PCM, { headers: {
      'content-type': mime, ...(length ? { 'content-length': length } : {}),
    } }));
    const { get } = await f.ticket();
    await assert.rejects(f.api.speakAudio(get), { status: 502 });
    assert.equal(get.res.chunks.length, 0);
  }
});

test('revocation during the PCM stream stops further writes and cannot populate generic cache', async () => {
  let controller;
  const f = fixture(async () => new Response(new ReadableStream({ start(c) { controller = c; } }),
    { headers: { 'content-type': 'audio/pcm' } }));
  const { get } = await f.ticket();
  const done = f.api.speakAudio(get).then(() => null, (e) => e);
  await flush(); controller.enqueue(PCM.subarray(0, 2)); await flush();
  f.revoke(); controller.enqueue(PCM.subarray(2));
  assert.equal((await done).status, 403);
  assert.deepEqual(Buffer.concat(get.res.chunks), PCM.subarray(0, 2));
  assert.equal(get.res.destroyed, true);
});

test('arbitrary personalized answers never create either PCM or MP3 cache entries', () => {
  const f = fixture(), cache = createSpeechCache();
  assert.equal(cache.claim(f.state, 'o', 'Синтетический клиент завтра в12:00', 'pcm'), null);
  assert.equal(cache.claim(f.state, 'o', 'Синтетический клиент завтра в12:00', 'mp3'), null);
  assert.throws(() => cache.claim(f.state, 'o', 'На какую дату?', {}), { status: 400 });
});


test('only the fixed Timeweb PCM request accepts mislabeled raw samples after the bounded prefix guard', async () => {
  const bytes = Buffer.concat([PCM, PCM, PCM, PCM]), writes = [], gate = deferred();
  const stream = new ReadableStream({ async start(c) {
    c.enqueue(bytes.subarray(0, 3)); c.enqueue(bytes.subarray(3, 15));
    await Promise.resolve(); assert.equal(writes.length, 0);
    c.enqueue(bytes.subarray(15, 17)); await gate.promise;
    c.enqueue(bytes.subarray(17)); c.close();
  } });
  const result = await streamTimewebSpeech({
    format: 'pcm', provider: { model: 'm', voice: 'a' }, key: 'synthetic', payload: {}, collect: true,
    output: { signal: new AbortController().signal, check() {}, wait: (p) => p,
      async write(value) { writes.push(Buffer.from(value)); gate.resolve(); } },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.timeweb.ai/v1/audio/speech');
      const body = JSON.parse(options.body); assert.equal(body.response_format, 'pcm'); assert.equal(body.speed, 1.4);
      return new Response(stream, { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  assert.equal(writes[0].length, 16);
  assert.deepEqual(Buffer.concat(writes), bytes);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.seconds, bytes.length / 48000);
  const f = fixture(async () => new Response(PCM, { headers: { 'content-type': 'audio/mpeg' } }));
  const { get } = await f.ticket(); await f.api.speakAudio(get);
  assert.equal(get.res.headers['Content-Type'], 'audio/pcm'); assert.deepEqual(Buffer.concat(get.res.chunks), PCM);
});

test('mislabeled real MP3 and text never reach PCM clients or populate the generic cache', async () => {
  for (const bytes of [MP3, Buffer.from('{"error":"provider unavailable"}'), Buffer.from('Provider temporarily unavailable')]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { get } = await f.ticket();
      await assert.rejects(f.api.speakAudio(get), { status: 502 });
      assert.equal(get.res.chunks.length, 0); assert.equal(get.res.headersSent, false);
    }
    assert.equal(calls, 2);
    assert.ok(f.settled.every((row) => row.amount === null));
  }
});
