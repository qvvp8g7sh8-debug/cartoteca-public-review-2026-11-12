const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestHandler } = require('../src/server/http/request-handler.cjs');
const {
  createSpeechPermits,
} = require('../src/server/modules/assistant/speech/speech-permits.cjs');
async function refused(path, refusal) {
  const current = {
    accountId: 'synthetic-owner',
    organizationId: 'synthetic-org',
    sessionId: 'synthetic-session',
    role: 'owner',
  };
  const req = new EventEmitter();
  Object.assign(req, {
    method: 'POST',
    url: path,
    complete: true,
    aborted: false,
    pause() {},
    socket: { localPort: 4174 },
    headers: {
      host: 'synthetic.invalid',
      origin: 'https://synthetic.invalid',
      'x-cartoteca-request': '1',
      'x-cartoteca-account-id': current.accountId,
      'x-cartoteca-organization-id': current.organizationId,
      cookie: 'cartoteca_v2_session=synthetic-cookie',
    },
  });
  const res = new EventEmitter();
  Object.assign(res, {
    headersSent: false,
    destroyed: false,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status, headers) {
      this.status = status;
      this.headersSent = true;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  });
  let released = 0;
  const handler = createRequestHandler({
    config: { origin: 'https://synthetic.invalid' },
    platform: { session: () => current },
    pool: {
      lease: () => ({
        get: () => assert.fail('refused speech must not read clinical data'),
        release: () => released++,
      }),
    },
    routes: [{ method: 'POST', path, access: 'organization', handle: () => refusal(current) }],
    metrics: { track: () => ({ stage() {}, phase() {}, route() {}, failure() {} }) },
    requestDispatcher: { run: async (run) => run() },
    clientAddress: () => 'synthetic',
    services: {},
  });
  await handler(req, res);
  assert.equal(released, 1);
  return { status: res.status, body: JSON.parse(res.body) };
}
for (const path of ['/api/assistant/speak', '/api/assistant/speak-audio'])
  test('HTTP preserves exact speech proof refusal code for ' + path, async (t) => {
    const response = await refused(path, (current) => {
      const permits = createSpeechPermits();
      const ticket = { id: 'synthetic-task', grantId: 'synthetic-grant', attempt: 1 };
      const c = { current };
      const proof = permits.issue(c, ticket, { text: 'Выберите клиента.', policyVersion: 1 }, 600);
      permits.requirePermit(c, ticket, {
        speechToken: proof.token,
        policyVersion: 1,
        text: 'Посторонний текст.',
      });
    });
    t.diagnostic(JSON.stringify({ path, status: response.status, code: response.body.code ?? null }));
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'ASSISTANT_SPEECH_PROOF_REQUIRED');
    assert.equal(response.body.error, 'Можно озвучить только текущий ответ помощника.');
    assert.deepEqual(Object.keys(response.body).sort(), ['code', 'error']);
  });
test('HTTP still hides unknown internal speech refusal codes', async () => {
  const response = await refused('/api/assistant/speak-audio', () => {
    throw Object.assign(Error('Нет доступа.'), { status: 403, code: 'SYNTHETIC_INTERNAL_ONLY' });
  });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: 'Нет доступа.' });
});
