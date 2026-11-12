const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createPaidBookingFixture } = require('./helpers/assistant-paid-booking-fixture.cjs');
function media(c, path) {
  const req = new EventEmitter(),
    res = new EventEmitter();
  req.complete = true;
  Object.assign(res, {
    bytes: 0,
    headersSent: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(bytes) {
      this.bytes += bytes.length;
      return true;
    },
    end() {
      this.writableEnded = this.writableFinished = true;
    },
  });
  return { ...c, req, res, url: new URL(path, 'https://synthetic.invalid') };
}
async function turn(f, speech) {
  return f.api.turn(f.context, {
    text: 'Запиши Диану Неволину',
    policyVersion: f.scope.policyVersion,
    taskRequestId: randomUUID(),
    ...(speech ? { speech } : {}),
  });
}
test('paid turn optionally prepares one exact protected PCM ticket without synthesis until GET', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  const reply = await turn(f, { format: 'pcm', stream: true, mode: 'answerable' });
  assert.equal(reply.speech.text, reply.speechPermit.answerableText);
  assert.equal(reply.speech.policyVersion, reply.policyVersion);
  assert.equal(reply.speech.mimeType, 'audio/pcm');
  assert.equal(f.pcmCalls(), 0);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
  const c = media(f.context, reply.speech.streamUrl);
  await f.api.speakAudio(c);
  assert.equal(c.res.status, 200);
  assert.equal(c.res.bytes, 4800);
  assert.equal(f.pcmCalls(), 1);
  await assert.rejects(f.api.speakAudio(media(f.context, reply.speech.streamUrl)), { status: 410 });
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
});
test('no opt-in keeps legacy POST and changed policy rejects prepared GET before provider', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  const plain = await turn(f);
  assert.equal(plain.speech, undefined);
  const reply = await turn(f, { format: 'pcm', stream: true, mode: 'answerable' });
  const view = f.api.admin.view(f.fixture.actor);
  f.api.admin.settings(f.fixture.actor, {
    expectedRevision: view.revision,
    requestId: randomUUID(),
    reason: 'Synthetic ticket guard',
    policy: { mode: 'off' },
  });
  await assert.rejects(f.api.speakAudio(media(f.context, reply.speech.streamUrl)), { status: 403 });
  assert.equal(f.pcmCalls(), 0);
});
test('new prepared reply supersedes only earlier turn ticket, legacy POST stays valid', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  const first = await turn(f, { format: 'pcm', stream: true, mode: 'answerable' });
  const legacy = await f.api.speak(f.context, {
    text: first.speechPermit.answerableText,
    policyVersion: first.policyVersion,
    format: 'pcm',
    stream: true,
    taskRequestId: first.taskRequestId,
    speechToken: first.speechPermit.token,
  });
  const next = await turn(f, { format: 'pcm', stream: true, mode: 'answerable' });
  assert.ok(next.speech.streamUrl);
  await assert.rejects(f.api.speakAudio(media(f.context, first.speech.streamUrl)), { status: 410 });
  const c = media(f.context, legacy.streamUrl);
  await f.api.speakAudio(c);
  assert.equal(c.res.status, 200);
});
test('prepared-ticket replay, expiry, marker bounds and cleanup are independent of legacy tickets', () => {
  const {
    createSpeechTickets,
  } = require('../src/server/modules/assistant/speech/speech-tickets.cjs');
  let now = 1000;
  const tickets = createSpeechTickets({ now: () => now });
  const c = {
    current: {
      accountId: 'synthetic-a',
      organizationId: 'synthetic-o',
      sessionId: 'synthetic-s',
      role: 'owner',
    },
  };
  const state = {
    revision: 1,
    providers: { tts: { provider: 'timeweb' } },
    credentials: { timeweb: 'synthetic' },
  };
  const member = { membershipId: 'synthetic-m' },
    scope = () => ({ state, member });
  const proof = (n) => ({ taskRequestId: 'task-' + n, speechToken: 'permit-' + n });
  const issue = (n) => tickets.issueTurn(c, state, member, 'На какую дату?', proof(n));
  const id = (ticket) =>
    new URL(ticket.streamUrl, 'https://synthetic.invalid').searchParams.get('ticket');
  const first = issue(1);
  assert.deepEqual(issue(1), first);
  tickets.take(c, id(first), scope);
  assert.equal(issue(1).replay, true);
  const second = issue(2);
  now += 30001;
  assert.equal(issue(2).replay, true);
  assert.throws(() => tickets.take(c, id(second), scope), { status: 410 });
  const third = issue(3),
    fourth = issue(4);
  assert.equal(issue(3).replay, true);
  assert.throws(() => tickets.take(c, id(third), scope), { status: 410 });
  assert.equal(tickets.stats().active, 1);
  for (let n = 5; n <= 32; n++) assert.ok(issue(n));
  assert.throws(() => issue(33), { status: 503 });
  assert.equal(tickets.stats().active, 1);
  tickets.clearSession(c.current.sessionId);
  assert.equal(tickets.stats().active, 0);
  const replacementOld = issue(1);
  for (let n = 0; n < 3; n++) tickets.issue(c, state, member, 'Legacy', 'pcm', proof(100 + n));
  assert.equal(tickets.stats().active, 4);
  assert.ok(issue(2));
  assert.equal(tickets.stats().active, 4);
  assert.throws(() => tickets.take(c, id(replacementOld), scope), { status: 410 });
  tickets.discardTurn(c.current.sessionId);
  assert.equal(tickets.stats().active, 3);
  assert.equal(issue(2).replay, true);
  tickets.clearAccount(c.current.accountId);
  assert.equal(tickets.stats().active, 0);
  assert.ok(fourth.expiresAt > 0);
});
test('paid turn descriptor crosses HTTP JSON then protected PCM GET without a speak POST', async (t) => {
  const http = require('node:http');
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  let postCount = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const c = { ...f.context, req, res, url: new URL(req.url, 'http://127.0.0.1') };
      if (req.method === 'POST' && req.url === '/api/assistant/turn') {
        postCount++;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const reply = await f.api.turn(c, JSON.parse(Buffer.concat(chunks)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      } else if (req.method === 'GET' && c.url.pathname === '/api/assistant/speak-audio') {
        await f.api.speakAudio(c);
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(error.status || 500);
        res.end();
      } else res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const replyResponse = await fetch(base + '/api/assistant/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Запиши Диану Неволину',
      policyVersion: f.scope.policyVersion,
      taskRequestId: randomUUID(),
      speech: { format: 'pcm', stream: true, mode: 'answerable' },
    }),
  });
  assert.equal(replyResponse.status, 200);
  const reply = await replyResponse.json();
  assert.ok(reply.speech?.streamUrl);
  assert.equal(f.pcmCalls(), 0);
  const audio = await fetch(base + reply.speech.streamUrl);
  assert.equal(audio.status, 200);
  assert.equal((await audio.arrayBuffer()).byteLength, 4800);
  assert.equal(postCount, 1);
  assert.equal(f.pcmCalls(), 1);
  const replay = await fetch(base + reply.speech.streamUrl);
  assert.equal(replay.status, 410);
  await replay.arrayBuffer();
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
});
test('prepared ticket invalidates on no-opt-in turn while legacy ticket survives', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  const reply = await turn(f, { format: 'pcm', stream: true, mode: 'answerable' });
  const legacy = await f.api.speak(f.context, {
    text: reply.speechPermit.answerableText,
    policyVersion: reply.policyVersion,
    format: 'pcm',
    stream: true,
    taskRequestId: reply.taskRequestId,
    speechToken: reply.speechPermit.token,
  });
  await turn(f);
  await assert.rejects(f.api.speakAudio(media(f.context, reply.speech.streamUrl)), { status: 410 });
  const c = media(f.context, legacy.streamUrl);
  await f.api.speakAudio(c);
  assert.equal(c.res.status, 200);
});
test('actual paid continuation semantic replay reuses unconsumed ticket and skips automatic voice after consumption', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  const initial = await turn(f);
  const body = {
    text: 'Чистка',
    policyVersion: initial.policyVersion,
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    taskRequestId: initial.taskRequestId,
    speech: { format: 'pcm', stream: true, mode: 'answerable' },
  };
  const first = await f.api.turn(f.context, body);
  const replay = await f.api.turn(f.context, body);
  assert.ok(first.speech?.streamUrl);
  assert.ok(replay.speech?.streamUrl);
  assert.ok(
    first.speech.streamUrl === replay.speech.streamUrl,
    'semantic replay must reuse the unconsumed ticket',
  );
  assert.equal(f.pcmCalls(), 0);
  await f.api.speakAudio(media(f.context, first.speech.streamUrl));
  const consumedReplay = await f.api.turn(f.context, body);
  assert.equal(consumedReplay.speech, undefined);
  assert.equal(consumedReplay.speechReplay, true);
  assert.equal(f.pcmCalls(), 1);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
});
test('actual paid continuation replay after ticket expiry skips voice without new provider or task', async (t) => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => {
    Date.now = realNow;
  });
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  const initial = await turn(f);
  const body = {
    text: 'Чистка',
    policyVersion: initial.policyVersion,
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    taskRequestId: initial.taskRequestId,
    speech: { format: 'pcm', stream: true, mode: 'answerable' },
  };
  const first = await f.api.turn(f.context, body);
  assert.ok(first.speech?.streamUrl);
  offset = 30001;
  const replay = await f.api.turn(f.context, body);
  assert.equal(replay.speech, undefined);
  assert.equal(replay.speechReplay, true);
  await assert.rejects(f.api.speakAudio(media(f.context, first.speech.streamUrl)), { status: 410 });
  assert.equal(f.pcmCalls(), 0);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
  offset = 600001;
  await assert.rejects(f.api.turn(f.context, body), { status: 409 });
  assert.equal(f.pcmCalls(), 0);
});
