const test = require('node:test'),
  assert = require('node:assert/strict'),
  { EventEmitter } = require('node:events'),
  { randomUUID } = require('node:crypto');
const { createPaidBookingFixture } = require('./helpers/assistant-paid-booking-fixture.cjs');
function mediaContext(c, url) {
  const req = new EventEmitter(),
    res = new EventEmitter();
  req.complete = true;
  Object.assign(res, {
    headersSent: false,
    destroyed: false,
    bytes: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(b) {
      this.bytes += b.length;
      return true;
    },
    end() {
      this.writableEnded = this.writableFinished = true;
    },
  });
  return { ...c, req, res, url: new URL(url, 'https://synthetic.invalid') };
}
test('Timeweb negotiates streaming PCM through legacy ticket GET while direct POST stays unadvertised', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  assert.equal(f.scope.capabilities.tts.streaming, true);
  assert.equal(f.scope.capabilities.tts.directPcm, false);
});
test('real paid booking ticket GET preserves one task, exact permit and fresh scope guards', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  const r = await f.api.turn(f.context, {
    text: 'Запиши Диану Неволину',
    policyVersion: f.scope.policyVersion,
    taskRequestId: randomUUID(),
  });
  const body = {
    text: r.speechPermit.answerableText,
    policyVersion: r.policyVersion,
    format: 'pcm',
    stream: true,
    taskRequestId: r.taskRequestId,
    speechToken: r.speechPermit.token,
  };
  const ticket = await f.api.speak(f.context, body);
  assert.equal(f.pcmCalls(), 0);
  const c = mediaContext(f.context, ticket.streamUrl);
  await f.api.speakAudio(c);
  assert.equal(c.res.status, 200);
  assert.equal(c.res.headers['Content-Type'], 'audio/pcm');
  assert.equal(c.res.bytes, 4800);
  assert.equal(f.pcmCalls(), 1);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
  await assert.rejects(f.api.speak(f.context, { ...body, text: 'Посторонний текст.' }), {
    status: 403,
    code: 'ASSISTANT_SPEECH_PROOF_REQUIRED',
  });
  const pending = await f.api.speak(f.context, body);
  let view = f.api.admin.view(f.fixture.actor);
  f.api.admin.settings(f.fixture.actor, {
    expectedRevision: view.revision,
    requestId: randomUUID(),
    reason: 'Synthetic scope control',
    policy: { mode: 'off' },
  });
  await assert.rejects(f.api.speakAudio(mediaContext(f.context, pending.streamUrl)), {
    status: 403,
  });
  view = f.api.admin.view(f.fixture.actor);
  f.api.admin.settings(f.fixture.actor, {
    expectedRevision: view.revision,
    requestId: randomUUID(),
    reason: 'Synthetic newer scope',
    policy: { mode: 'selected' },
  });
  await assert.rejects(f.api.speakAudio(mediaContext(f.context, pending.streamUrl)), {
    status: 409,
  });
  assert.equal(f.pcmCalls(), 1);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
});
