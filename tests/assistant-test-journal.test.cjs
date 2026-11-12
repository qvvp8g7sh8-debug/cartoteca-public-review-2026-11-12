'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createAssistantTestJournal } = require('./helpers/assistant-test-journal.cjs');
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function fixture(t, handler, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-journal-test-'));
  fs.chmodSync(directory, 0o700);
  const launch = path.join(directory, 'manual-stand-reports', 'launch-synthetic');
  fs.mkdirSync(launch, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, '.cartoteca-timeweb-manual-stand.json'),
    JSON.stringify({
      identity: 'CARTOTECA-TIMEWEB-SYNTHETIC-MANUAL-WRITES-20261016',
      directory,
      syntheticOnly: true,
      manualWritesEnabled: true,
      noActualSave: false,
      state: 'running',
      uid: process.getuid?.(),
    }),
    { mode: 0o600 },
  );
  const options = {
    directory: path.join(launch, 'voice-journal'),
    dataDirectory: directory,
    sourceHash: 'a'.repeat(64),
    production: false,
    testOnly: true,
    host: '127.0.0.1',
    port: 0,
    ...extra,
  };
  const journal = createAssistantTestJournal(options);
  const writes = [],
    ends = [];
  const server = http.createServer((req, res) => {
    const originalWrite = res.write,
      originalEnd = res.end;
    res.write = function (...args) {
      const value = Reflect.apply(originalWrite, this, args);
      writes.push(value);
      return value;
    };
    res.end = function (...args) {
      const value = Reflect.apply(originalEnd, this, args);
      ends.push(value);
      return value;
    };
    const previous = { push: req.push, write: res.write, end: res.end };
    const attached = journal.attach(req, res);
    Promise.resolve(handler(req, res, { journal, attached, previous, writes, ends })).catch(
      (error) => {
        if (!res.headersSent) json(res, { error: error.message }, 500);
        else res.destroy(error);
      },
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    journal.close();
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    assert(
      path.basename(directory).startsWith('cartoteca-journal-test-') &&
        !fs.lstatSync(directory).isSymbolicLink(),
    );
    fs.rmSync(directory, { recursive: true });
  });
  function request(route, chunks = ['{}'], headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: route.startsWith('/api/assistant/speak-audio') ? 'GET' : 'POST',
          path: route,
          agent: false,
          headers,
        },
        (res) => {
          const received = [];
          res.on('data', (chunk) => received.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(received) }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  }
  function events() {
    return fs
      .readdirSync(journal.directory)
      .filter((name) => /^assistant-\d+\.ndjson$/u.test(name))
      .sort()
      .flatMap((name) =>
        fs
          .readFileSync(path.join(journal.directory, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse),
      );
  }
  function allText() {
    return fs
      .readdirSync(journal.directory)
      .map((name) => fs.readFileSync(path.join(journal.directory, name), 'utf8'))
      .join('\n');
  }
  return { directory, options, journal, port, request, events, allText, writes, ends };
}

test('chunked request and fragmented UTF8 JSON reply preserve bytes, return values and callbacks', async (t) => {
  const text = JSON.stringify({
    text: 'Запиши Аллу Семёнову',
    dialogueId: 'd',
    choice: 'Алла',
    cancel: false,
  });
  const reply = Buffer.from(
    JSON.stringify({
      text: 'Алла Семёнова, верно?',
      dialogue: {
        step: 'clientChoice',
        fields: [{ key: 'date', value: '2026-12-20' }],
        options: [{ id: 'x', label: 'Алла' }],
      },
      action: null,
    }),
  );
  let callbackRan = false;
  const f = await fixture(t, async (req, res, ctx) => {
    // A passive observer must not start flowing before the application consumes.
    assert.equal(req.readableFlowing, null);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal((await body(req)).toString(), text);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const a = res.write(reply.subarray(0, 31));
    assert.equal(a, ctx.writes.at(-1));
    const b = res.write(new Uint8Array(reply.subarray(31, 45)));
    assert.equal(b, ctx.writes.at(-1));
    const returned = res.end(reply.subarray(45), () => {
      callbackRan = true;
    });
    assert.equal(returned, res);
  });
  const result = await f.request('/api/assistant/turn', [
    text.slice(0, 8),
    text.slice(8, 21),
    text.slice(21),
  ]);
  assert.deepEqual(result.raw, reply);
  assert.equal(callbackRan, true);
  const rows = f.events(),
    start = rows.find((r) => r.kind === 'request-start'),
    request = rows.find((r) => r.kind === 'request-body'),
    response = rows.find((r) => r.kind === 'response');
  assert.deepEqual(request.body.value, JSON.parse(text));
  assert.deepEqual(response.response.value, JSON.parse(reply));
  assert.equal(start.requestId, request.requestId);
  assert.equal(start.requestId, response.requestId);
  assert.equal(response.complete, true);
  assert(rows.every((r, index) => !index || r.seq > rows[index - 1].seq));
  assert.equal(f.journal.status().bufferedBytes, 0);
});

test('write backpressure and end encoding/callback signatures are forwarded unchanged', async (t) => {
  const huge = Buffer.from(JSON.stringify({ text: 'я'.repeat(150000) }));
  let returnedFalse = false,
    callbacks = 0;
  const f = await fixture(t, async (req, res, ctx) => {
    await body(req);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('?big')) {
      const value = res.write(huge);
      assert.equal(value, ctx.writes.at(-1));
      returnedFalse = !value;
      assert.equal(res.end(), res);
    } else {
      assert.equal(
        res.end('{"text":"Привет"}', 'utf8', () => {
          callbacks++;
        }),
        res,
      );
    }
  });
  assert.deepEqual((await f.request('/api/assistant/turn?big')).raw, huge);
  assert.equal((await f.request('/api/assistant/turn')).raw.toString(), '{"text":"Привет"}');
  assert.equal(returnedFalse, true);
  assert.equal(callbacks, 1);
  assert(f.events().some((r) => r.kind === 'response' && r.response.state === 'body-overflow'));
});

test('transcription logs recognized JSON but never buffers audio request; speak logs actual rendered text only', async (t) => {
  const audio = 'AUDIO_CANARY'.repeat(24000),
    speech = 'Семёнова. Двадцатое декабря, шестнадцать тридцать.';
  const f = await fixture(t, async (req, res, ctx) => {
    const input = JSON.parse((await body(req)).toString());
    if (req.url === '/api/assistant/transcribe') {
      assert.equal(input.audioBase64, audio);
      assert.equal(ctx.journal.status().bufferedBytes, 0);
      json(res, { text: 'Двадцать ноль одна.', policyVersion: 12 });
    } else {
      assert.equal(input.text, speech);
      json(res, {
        audioBase64: 'DO_NOT_CAPTURE_SPEECH_BASE64',
        streamUrl: '/api/assistant/speak-audio?ticket=PRIVATE',
        text: speech,
      });
    }
  });
  await f.request('/api/assistant/transcribe', [
    JSON.stringify({ audioBase64: audio, mimeType: 'audio/wav' }),
  ]);
  await f.request('/api/assistant/speak', [
    JSON.stringify({ text: speech, policyVersion: 12, stream: true, format: 'pcm' }),
  ]);
  const rows = f.events();
  assert(
    rows.some((r) => r.kind === 'response' && r.response.value?.text === 'Двадцать ноль одна.'),
  );
  assert(rows.some((r) => r.kind === 'request-body' && r.body.value?.text === speech));
  assert(!f.allText().includes('AUDIO_CANARY'));
  assert(!f.allText().includes('DO_NOT_CAPTURE_SPEECH_BASE64'));
  assert(!f.allText().includes('ticket=PRIVATE'));
});

test('audio streaming and excluded authentication/admin routes have no mirrors or retained queries/headers', async (t) => {
  const first = defer(),
    allowEnd = defer();
  const pcm = Buffer.from([1, 0, 123, 0, 255, 255]);
  const f = await fixture(t, async (req, res, ctx) => {
    assert.equal(ctx.attached, false);
    assert.equal(req.push, ctx.previous.push);
    assert.equal(res.write, ctx.previous.write);
    assert.equal(res.end, ctx.previous.end);
    await body(req);
    if (req.url.startsWith('/api/assistant/speak-audio')) {
      res.writeHead(200, { 'Content-Type': 'audio/pcm' });
      res.write(pcm.subarray(0, 2));
      first.resolve();
      await allowEnd.promise;
      res.end(pcm.subarray(2));
    } else json(res, { password: 'AUTH_BODY_CANARY' });
  });
  const response = f.request('/api/assistant/speak-audio?ticket=TICKET_CANARY', []);
  await first.promise;
  allowEnd.resolve();
  assert.deepEqual((await response).raw, pcm);
  await f.request('/api/auth/login', ['{"password":"REQUEST_PASSWORD_CANARY"}'], {
    Cookie: 'SESSION_CANARY',
  });
  await f.request('/api/admin/voice-assistant/settings', ['{"timewebApiKey":"KEY_CANARY"}']);
  assert.equal(f.events().filter((r) => r.requestId).length, 0);
  for (const secret of [
    'TICKET_CANARY',
    'AUTH_BODY_CANARY',
    'REQUEST_PASSWORD_CANARY',
    'SESSION_CANARY',
    'KEY_CANARY',
  ])
    assert(!f.allText().includes(secret));
});

test('unknown request fields and nested credentials are omitted while full error/dialogue values remain', async (t) => {
  const f = await fixture(t, async (req, res) => {
    await body(req);
    res.setHeader('Set-Cookie', 'HEADER_CANARY');
    json(
      res,
      {
        error: 'Время записи должно быть с шагом 5 минут.',
        code: 'CLOCK_GRID',
        dialogue: { step: 'time', fields: [{ key: 'time', value: '20:01' }] },
        credentials: { timeweb: 'RESPONSE_KEY_CANARY' },
        headers: { Authorization: 'RESPONSE_AUTH_CANARY' },
      },
      400,
    );
  });
  await f.request(
    '/api/assistant/turn',
    [
      JSON.stringify({
        text: '20:01',
        password: 'PASSWORD_CANARY',
        choice: { id: 'x', headers: { Cookie: 'NESTED_COOKIE_CANARY' } },
      }),
    ],
    { Authorization: 'REQUEST_AUTH_CANARY' },
  );
  const response = f.events().find((r) => r.kind === 'response');
  assert.equal(response.status, 400);
  assert.equal(response.response.value.error, 'Время записи должно быть с шагом 5 минут.');
  assert.equal(response.response.value.dialogue.fields[0].value, '20:01');
  const request = f.events().find((r) => r.kind === 'request-body');
  assert.equal(request.body.value.text, '20:01');
  assert.equal(request.body.omittedFields, 1);
  assert.equal(request.body.value.choice.id, 'x');
  for (const secret of [
    'HEADER_CANARY',
    'RESPONSE_KEY_CANARY',
    'RESPONSE_AUTH_CANARY',
    'PASSWORD_CANARY',
    'NESTED_COOKIE_CANARY',
    'REQUEST_AUTH_CANARY',
  ])
    assert(!f.allText().includes(secret));
});

test('malformed JSON and body overflow leave explicit metadata without changing application payloads', async (t) => {
  const response = JSON.stringify({ text: 'r'.repeat(300) });
  const f = await fixture(
    t,
    async (req, res) => {
      const raw = await body(req);
      res.setHeader('Content-Type', 'application/json');
      res.end(raw.toString().startsWith('bad') ? 'not-json-SECRET_CANARY' : response);
    },
    { bodyBytes: 64 },
  );
  assert.equal(
    (await f.request('/api/assistant/turn', ['bad-json-SECRET_CANARY'])).raw.toString(),
    'not-json-SECRET_CANARY',
  );
  const input = JSON.stringify({ text: 'z'.repeat(400) });
  assert.equal(
    (await f.request('/api/assistant/turn', [input.slice(0, 80), input.slice(80)])).raw.toString(),
    response,
  );
  const rows = f.events();
  assert(rows.some((r) => r.body?.state === 'malformed-json'));
  assert(rows.some((r) => r.response?.state === 'malformed-json'));
  assert(
    rows.some(
      (r) => r.body?.state === 'body-overflow' && r.body.bytes === Buffer.byteLength(input),
    ),
  );
  assert(rows.some((r) => r.response?.state === 'body-overflow'));
  assert(!f.allText().includes('SECRET_CANARY'));
  assert.equal(f.journal.status().bufferedBytes, 0);
  assert(f.journal.status().maximumBufferedBytes <= 128);
});

test('concurrent reverse completion retains separate request correlation and body values', async (t) => {
  const entered = defer(),
    release = defer();
  const f = await fixture(t, async (req, res) => {
    const v = JSON.parse((await body(req)).toString());
    if (v.text === 'first') {
      entered.resolve();
      await release.promise;
    }
    json(res, { text: v.text });
  });
  const a = f.request('/api/assistant/turn', ['{"text":"first"}']);
  await entered.promise;
  const b = await f.request('/api/assistant/turn', ['{"text":"second"}']);
  release.resolve();
  await a;
  assert.equal(JSON.parse(b.raw).text, 'second');
  const rows = f.events(),
    starts = rows.filter((r) => r.kind === 'request-start'),
    responses = rows.filter((r) => r.kind === 'response');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].requestId, starts[1].requestId);
  assert.equal(responses[0].requestId, starts[1].requestId);
  assert.equal(responses[0].response.value.text, 'second');
  assert.equal(responses[1].requestId, starts[0].requestId);
});

test('active capture ceiling produces explicit omitted-body records instead of uncontrolled buffering', async (t) => {
  const entered = defer(),
    release = defer();
  const f = await fixture(
    t,
    async (req, res) => {
      const v = JSON.parse((await body(req)).toString());
      if (v.text === 'first') {
        entered.resolve();
        await release.promise;
      }
      json(res, { text: v.text });
    },
    { activeRequests: 1, bodyBytes: 128 },
  );
  const first = f.request('/api/assistant/turn', ['{"text":"first"}']);
  await entered.promise;
  await f.request('/api/assistant/turn', ['{"text":"second"}']);
  release.resolve();
  await first;
  assert(f.events().some((r) => r.kind === 'request-start' && r.bodyCapture === false));
  assert(f.events().some((r) => r.body?.reason === 'active-capture-overflow'));
  assert.equal(f.journal.status().activeRequests, 0);
  assert(f.journal.status().maximumBufferedBytes <= 256);
});

test('aborted uploads retain incomplete/closed outcome without claiming a successful response', async (t) => {
  const received = defer(),
    closed = defer();
  const f = await fixture(t, (req) => {
    req.on('data', () => received.resolve());
    req.on('error', () => {});
    req.on('close', () => closed.resolve());
  });
  const req = http.request({
    host: '127.0.0.1',
    port: f.port,
    method: 'POST',
    path: '/api/assistant/turn',
    agent: false,
  });
  req.on('error', () => {});
  req.write('{"text":"half');
  await received.promise;
  req.destroy();
  await closed.promise;
  await new Promise((r) => setImmediate(r));
  const result = f.events().find((r) => r.kind === 'response');
  assert(result);
  assert.equal(result.complete, false);
  assert.equal(result.requestAborted, true);
  assert.equal(result.status, null);
  assert(f.events().some((r) => r.body?.state === 'incomplete'));
  assert.equal(f.journal.status().activeRequests, 0);
});

test('bounded rotation preserves explicit eviction coverage and private files', async (t) => {
  const f = await fixture(
    t,
    async (req, res) => {
      await body(req);
      json(res, { text: 'reply'.repeat(15) });
    },
    { fileBytes: 4096, files: 2, bodyBytes: 256 },
  );
  for (let i = 0; i < 24; i++)
    await f.request('/api/assistant/turn', [JSON.stringify({ text: 'request-' + i })]);
  const status = f.journal.status(),
    names = fs
      .readdirSync(f.journal.directory)
      .filter((name) => /^assistant-\d+\.ndjson$/u.test(name));
  assert.equal(status.healthy, true);
  assert.equal(names.length, 2);
  assert(status.evictedThroughSeq > 0);
  assert(f.events().some((r) => r.kind === 'rotation' && r.evictedThroughSeq > 0));
  assert(f.events().every((r) => r.seq > status.evictedThroughSeq));
  if (process.getuid)
    for (const name of fs.readdirSync(f.journal.directory))
      assert.equal(fs.statSync(path.join(f.journal.directory, name)).mode & 0o077, 0);
});

test('journal I/O failure is visible without breaking the normal HTTP reply', async (t) => {
  let broken = false;
  const faults = [],
    io = {
      ...fs,
      writeSync(...args) {
        if (broken) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
        return fs.writeSync(...args);
      },
    };
  const f = await fixture(
    t,
    async (req, res) => {
      await body(req);
      json(res, { text: 'unchanged' });
    },
    { io, onFault: (value) => faults.push(value) },
  );
  broken = true;
  assert.equal(
    (await f.request('/api/assistant/turn', ['{"text":"test"}'])).raw.toString(),
    '{"text":"unchanged"}',
  );
  assert.equal(f.journal.status().healthy, false);
  assert.equal(f.journal.status().faultCode, 'ENOSPC');
  assert(f.journal.status().droppedRecords >= 3);
  assert.equal(faults.length, 1);
});

test('production/non-synthetic/non-loopback gates refuse journal creation before opening files', async (t) => {
  const f = await fixture(t, async (req, res) => {
    await body(req);
    json(res, {});
  });
  for (const patch of [{ production: true }, { testOnly: false }, { host: '0.0.0.0' }])
    assert.throws(() =>
      createAssistantTestJournal({
        ...f.options,
        ...patch,
        directory: path.join(f.directory, 'manual-stand-reports', 'launch-synthetic', 'another'),
      }),
    );
  const marker = path.join(f.directory, '.cartoteca-timeweb-manual-stand.json'),
    value = JSON.parse(fs.readFileSync(marker));
  value.syntheticOnly = false;
  fs.writeFileSync(marker, JSON.stringify(value));
  assert.throws(() => createAssistantTestJournal({ ...f.options }));
});
test('execute journal keeps the exact receipt/error and only safe request fields, never URL queries', async (t) => {
  const executionId = '11111111-2222-4333-8444-555555555555';
  const f = await fixture(t, async (req, res) => {
    const input = JSON.parse((await body(req)).toString());
    assert.equal(input.executionId, executionId);
    if (input.policyVersion === 12) {
      res.writeHead(200, 'OK', ['Content-Type', 'application/json']);
      res.end(
        JSON.stringify({
          text: 'Запись сохранена.',
          saved: true,
          action: {
            type: 'appointmentCreated',
            appointmentId: 'synthetic-appointment',
            time: '16:30',
          },
        }),
      );
    } else {
      assert.equal(res.writeHead(400, 'Bad Request', ['Content-Type', 'application/json']), res);
      res.end(
        JSON.stringify({ error: 'Время записи должно быть с шагом 5 минут.', code: 'CLOCK_GRID' }),
      );
    }
  });
  const success = await f.request('/api/assistant/execute?ticket=QUERY_NOT_JOURNALED', [
    JSON.stringify({ executionId, policyVersion: 12, password: 'UNKNOWN_FIELD_SECRET' }),
  ]);
  const refused = await f.request('/api/assistant/execute', [
    JSON.stringify({ executionId, policyVersion: 11 }),
  ]);
  assert.equal(success.status, 200);
  assert.equal(refused.status, 400);
  const rows = f.events();
  assert(
    rows
      .filter((r) => r.kind === 'request-start')
      .every((r) => r.path === '/api/assistant/execute'),
  );
  const requests = rows.filter((r) => r.kind === 'request-body');
  assert.equal(requests[0].body.value.executionId, executionId);
  assert.equal(requests[0].body.omittedFields, 1);
  const replies = rows.filter((r) => r.kind === 'response');
  assert.equal(replies[0].response.value.saved, true);
  assert.equal(replies[0].response.value.action.time, '16:30');
  assert.equal(replies[1].response.value.code, 'CLOCK_GRID');
  assert(!f.allText().includes('QUERY_NOT_JOURNALED'));
  assert(!f.allText().includes('UNKNOWN_FIELD_SECRET'));
});
