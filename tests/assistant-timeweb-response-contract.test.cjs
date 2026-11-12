const test = require('node:test');
const assert = require('node:assert/strict');
const { callTimeweb } = require('../src/server/modules/assistant/providers/timeweb/timeweb.cjs');
const { parseContinuation } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const { wavAudio } = require('../src/server/modules/assistant/speech/audio.cjs');
const key = 'synthetic-timeweb-response-key';
function wav() {
  const bytes = Buffer.alloc(64044);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
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
function call(kind, response, extra = {}) {
  return callTimeweb({
    kind,
    provider: { model: 'synthetic-model', voice: 'synthetic-voice' },
    key,
    payload:
      kind === 'tts'
        ? { input: 'Синтетический ответ.' }
        : { messages: [{ role: 'user', content: 'Синтетическое уточнение.' }], max_tokens: 500 },
    timeoutMs: 2000,
    guard() {},
    fetchImpl: async (url, init) => {
      assert.equal(
        url,
        'https://api.timeweb.ai/v1/' + (kind === 'tts' ? 'audio/speech' : 'chat/completions'),
      );
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer ' + key);
      if (kind === 'tts') assert.equal(JSON.parse(init.body).response_format, 'wav');
      return response;
    },
    ...extra,
  });
}
const audio = (bytes, mime = 'audio/wav') =>
  new Response(bytes, { headers: { 'content-type': mime } });
const json = (content, finish = 'stop', message = {}) =>
  Response.json({
    choices: [{ finish_reason: finish, message: { content, ...message } }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: finish === 'length' ? 500 : 30,
      completion_tokens_details: { reasoning_tokens: finish === 'length' ? 500 : 10 },
    },
  });
const limitError = (error) =>
  error.status === 502 &&
  /лимит/iu.test(error.message) &&
  /не примен[её]н/iu.test(error.message) &&
  !error.message.includes(key);
test('Timeweb returns verified unchanged PCM WAV despite its known audio/mpeg mislabel', async () => {
  const bytes = wav(),
    result = await call('tts', audio(bytes, 'audio/mpeg'));
  assert.equal(result.mimeType, 'audio/wav');
  assert.deepEqual(
    Buffer.from(result.audioBase64, 'base64'),
    bytes,
    'No decoding or conversion changes the proven WAV',
  );
  assert.equal(result.usage.output_tokens, 2);
  assert.equal(result.usageEstimated, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-timeweb-response-key/u);
});
test('Timeweb MIME token case and surrounding whitespace normalize without allowing arbitrary media', async () => {
  for (const mime of [
    'Audio/WAV ; charset=binary',
    ' AUDIO/X-WAV ',
    'Audio/MPEG ; charset=binary',
    'application/octet-stream',
  ]) {
    const result = await call('tts', audio(wav(), mime));
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.usage.output_tokens, 2);
  }
  for (const mime of ['audio/mp3', 'video/mp4', 'text/plain'])
    await assert.rejects(call('tts', audio(wav(), mime)), { status: 502 });
});
test('genuine MP3 ID3 and MPEG frames, unrelated bytes and empty bodies remain rejected', async () => {
  for (const bytes of [
    Buffer.from('ID3-synthetic-mp3-content'),
    Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]),
    Buffer.from('synthetic-not-audio'),
    Buffer.alloc(0),
  ]) {
    for (const mime of ['audio/mpeg', 'audio/wav'])
      await assert.rejects(call('tts', audio(bytes, mime)), { status: 502 });
  }
});
test('RIFF/WAVE markers never bypass the existing strict PCM and data-chunk validation', async () => {
  const malformed = [];
  malformed.push(wav().subarray(0, 12), wav().subarray(0, 64040));
  const stereo = wav();
  stereo.writeUInt16LE(2, 22);
  malformed.push(stereo);
  const floating = wav();
  floating.writeUInt16LE(3, 20);
  malformed.push(floating);
  const lowRate = wav();
  lowRate.writeUInt32LE(8000, 24);
  malformed.push(lowRate);
  const eightBits = wav();
  eightBits.writeUInt16LE(8, 34);
  malformed.push(eightBits);
  const badRate = wav();
  badRate.writeUInt32LE(1, 28);
  malformed.push(badRate);
  const noData = wav().subarray(0, 44);
  noData.writeUInt32LE(0, 40);
  malformed.push(noData);
  for (const bytes of malformed)
    await assert.rejects(call('tts', audio(bytes, 'audio/mpeg')), { status: 502 });
});
test('streaming WAV unknown length remains supported under the same strict PCM checks', async () => {
  const bytes = wav();
  bytes.writeUInt32LE(0xffffffff, 4);
  bytes.writeUInt32LE(0xffffffff, 40);
  const value = await call('tts', audio(bytes, 'audio/mpeg'));
  const completed = Buffer.from(value.audioBase64, 'base64');
  assert.equal(completed.readUInt32LE(4), completed.length - 8);
  assert.equal(completed.readUInt32LE(40), completed.length - 44);
  assert.deepEqual(completed.subarray(44), bytes.subarray(44));
  assert.equal(bytes.readUInt32LE(4), 0xffffffff);
  assert.equal(bytes.readUInt32LE(40), 0xffffffff);
  assert.equal(value.usage.output_tokens, 2);
});
test('length exhaustion is rejected before returning empty, partial or even complete valid JSON', async () => {
  const complete = JSON.stringify({
    operation: 'patch',
    fields: { client: null, staff: null, service: null, date: null, time: '14:30', duration: null },
    choice: null,
    field: null,
  });
  for (const content of ['', '{"operation":', complete, '{"intent":"calendar"}'])
    await assert.rejects(call('llm', json(content, 'length')), limitError);
});
test('stop responses retain their exact JSON content and numeric usage unchanged', async () => {
  const text = '{"intent":"calendar"}',
    result = await call('llm', json(text));
  assert.equal(result.text, text);
  assert.deepEqual(result.usage, {
    prompt_tokens: 20,
    completion_tokens: 30,
    completion_tokens_details: { reasoning_tokens: 10 },
  });
});
test('empty or whitespace-only stopped content is rejected without presenting a JSON parsing error', async () => {
  for (const text of ['', ' \n\t '])
    await assert.rejects(
      call('llm', json(text)),
      (error) => error.status === 502 && /(?:текст|пуст)/iu.test(error.message),
    );
});
test('missing legacy finish metadata stays compatible while tool calls stay rejected', async () => {
  const result = await call(
    'llm',
    Response.json({ choices: [{ message: { content: '{"intent":"help"}' } }] }),
  );
  assert.equal(result.text, '{"intent":"help"}');
  await assert.rejects(
    call('llm', json('{"intent":"help"}', 'stop', { tool_calls: [{ id: 'synthetic-tool' }] })),
    { status: 502 },
  );
});
test('the adapter does not strip fences, repair JSON or bypass the common continuation validator', async () => {
  const fence = String.fromCharCode(96).repeat(3),
    text = fence + 'json\n{"operation":"patch"}\n' + fence;
  const result = await call('llm', json(text));
  assert.equal(result.text, text);
  assert.throws(() => parseContinuation(result.text), { status: 502 });
});
test('provider status, byte bounds and late scope guards remain in force for the exception', async () => {
  await assert.rejects(
    call('tts', audio(Buffer.alloc(4 * 1024 * 1024 + 1), 'audio/mpeg')),
    (error) => error.status === 502 && /ограничени/iu.test(error.message),
  );
  await assert.rejects(
    call('llm', new Response(Buffer.alloc(65537))),
    (error) => error.status === 502 && /ограничени/iu.test(error.message),
  );
  await assert.rejects(call('llm', new Response(null, { status: 429 })), { status: 429 });
  let guards = 0;
  await assert.rejects(
    call('tts', audio(wav(), 'audio/mpeg'), {
      guard() {
        if (++guards === 3) throw Object.assign(Error('Synthetic revoked scope'), { status: 403 });
      },
    }),
    { status: 403 },
  );
});

test('complete buffered provider WAV repairs only sentinel lengths and preserves every PCM byte', async () => {
  for (const fields of [[4], [40], [4, 40]]) {
    const input = wav();
    input.writeInt16LE(12345, 44);
    input.writeInt16LE(-23456, input.length - 2);
    for (const offset of fields) input.writeUInt32LE(0xffffffff, offset);
    const before = Buffer.from(input);
    const result = await call('tts', audio(input, 'audio/mpeg'));
    const completed = Buffer.from(result.audioBase64, 'base64');
    assert.equal(completed.readUInt32LE(4), completed.length - 8);
    assert.equal(completed.readUInt32LE(40), completed.length - 44);
    for (let index = 0; index < input.length; index++)
      if (!fields.some((offset) => index >= offset && index < offset + 4))
        assert.equal(
          completed[index],
          before[index],
          'Only declared sentinel length fields may change',
        );
    assert.deepEqual(input, before, 'The incoming provider buffer is never mutated');
    assert.equal(
      wavAudio({ mimeType: 'audio/wav', audioBase64: result.audioBase64 }, 3).seconds,
      2,
    );
  }
});
test('the observed mono24k PCM streaming-header shape becomes a valid strict inbound WAV', async () => {
  const bytes = Buffer.alloc(189644);
  wav().copy(bytes, 0, 0, 44);
  bytes.writeUInt32LE(0xffffffff, 4);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt32LE(0xffffffff, 40);
  bytes.writeInt16LE(1234, 44);
  bytes.writeInt16LE(-4321, bytes.length - 2);
  const original = bytes.toString('base64');
  assert.throws(() => wavAudio({ mimeType: 'audio/wav', audioBase64: original }, 4), {
    status: 400,
  });
  const value = await call('tts', audio(bytes, 'audio/mpeg'));
  const parsed = wavAudio({ mimeType: value.mimeType, audioBase64: value.audioBase64 }, 4);
  assert.equal(parsed.seconds, 3.95);
  assert.equal(parsed.bytes.readUInt32LE(24), 24000);
  assert.equal(parsed.bytes.readUInt16LE(20), 1);
  assert.equal(parsed.bytes.readUInt16LE(22), 1);
  assert.equal(parsed.bytes.readUInt16LE(34), 16);
  assert.deepEqual(parsed.bytes.subarray(44), bytes.subarray(44));
  assert.equal(bytes.toString('base64'), original);
});
test('streaming sentinel lengths never repair malformed PCM, truncated blocks or alter the TTS request', async () => {
  const stereo = wav();
  stereo.writeUInt32LE(0xffffffff, 4);
  stereo.writeUInt32LE(0xffffffff, 40);
  stereo.writeUInt16LE(2, 22);
  const truncated = wav().subarray(0, 42);
  truncated.writeUInt32LE(0xffffffff, 4);
  for (const bytes of [stereo, truncated])
    await assert.rejects(call('tts', audio(bytes, 'audio/mpeg')), { status: 502 });
  let request;
  await call('tts', audio(wav(), 'audio/mpeg'), {
    fetchImpl: async (url, init) => {
      request = JSON.parse(init.body);
      return audio(wav(), 'audio/mpeg');
    },
  });
  assert.deepEqual(request, {
    model: 'synthetic-model',
    input: 'Синтетический ответ.',
    voice: 'synthetic-voice',
    response_format: 'wav',
  });
});

test('WAV completion locates the data chunk after legal padded metadata instead of assuming a44-byte header', async () => {
  const ordinary = wav(),
    junk = Buffer.alloc(10);
  junk.write('JUNK');
  junk.writeUInt32LE(1, 4);
  junk[8] = 7;
  const incoming = Buffer.concat([ordinary.subarray(0, 12), junk, ordinary.subarray(12)]);
  incoming.writeUInt32LE(0xffffffff, 4);
  incoming.writeUInt32LE(0xffffffff, 50);
  const value = await call('tts', audio(incoming, 'audio/mpeg'));
  const parsed = wavAudio({ mimeType: value.mimeType, audioBase64: value.audioBase64 }, 3);
  assert.equal(parsed.bytes.readUInt32LE(4), parsed.bytes.length - 8);
  assert.equal(parsed.bytes.readUInt32LE(50), 64000);
  assert.deepEqual(parsed.bytes.subarray(54), ordinary.subarray(44));
  assert.deepEqual(parsed.bytes.subarray(12, 22), junk);
  assert.equal(parsed.seconds, 2);
});
