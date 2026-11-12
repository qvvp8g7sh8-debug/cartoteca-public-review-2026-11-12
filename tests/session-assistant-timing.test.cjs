const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/client/core/session.js'), 'utf8');
function fixture() {
  const state = {
    account: { id: 'synthetic-owner', organizationId: 'synthetic-org', role: 'owner' },
    assistantGeneration: 1,
  };
  const calls = [],
    redirects = [];
  const session = vm.runInNewContext(source + '\ncreateSession', {
    AbortController,
    setTimeout,
    clearTimeout,
    location: { hash: '', replace: (url) => redirects.push(url) },
    fetch: (url, options) =>
      new Promise((resolve) => {
        calls.push({
          url,
          options,
          reply: (header, status = 200, data = { ok: true }) =>
            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers: { get: (name) => (name === 'Server-Timing' ? header : null) },
              json: async () => data,
            }),
        });
      }),
  })(state, {
    resetAssistant: () => {
      state.assistantGeneration++;
    },
  });
  return { state, calls, redirects, request: session.request };
}
const options = (callback) => ({
  method: 'POST',
  assistantRequest: true,
  assistantTiming: callback,
});
test('request timing observes the matching response even when concurrent replies complete in reverse order', async () => {
  const f = fixture(),
    seen = [];
  const a = f.request(
    '/api/assistant/turn',
    options((header) => seen.push(['turn', header])),
  );
  const b = f.request(
    '/api/assistant/speak',
    options((header) => seen.push(['speak', header])),
  );
  for (const call of f.calls) assert.equal(Object.hasOwn(call.options, 'assistantTiming'), false);
  f.calls[1].reply('ct_request;dur=2');
  await b;
  f.calls[0].reply('ct_request;dur=9');
  await a;
  assert.deepEqual(seen, [
    ['speak', 'ct_request;dur=2'],
    ['turn', 'ct_request;dur=9'],
  ]);
});
test('timing observers cannot fail requests and only run for successful current assistant responses', async () => {
  const f = fixture();
  const good = f.request(
    '/api/assistant/turn',
    options(() => {
      throw Error('observer failed');
    }),
  );
  f.calls[0].reply('ct_request;dur=5');
  assert.equal((await good).ok, true);
  let observed = 0;
  for (const route of ['/api/cabinet', '/api/assistant/execute', '/api/assistant/scope']) {
    const pending = f.request(
      route,
      options(() => observed++),
    );
    f.calls.at(-1).reply('ct_request;dur=5');
    await pending;
  }
  for (const status of [403, 500]) {
    const pending = f
      .request(
        '/api/assistant/turn',
        options(() => observed++),
      )
      .catch((error) => error);
    f.calls.at(-1).reply('ct_request;dur=5', status, { error: 'synthetic rejection' });
    assert.equal((await pending).status, status);
  }
  assert.equal(observed, 0);
});
test('timing never crosses account replacement, role, generation or auth-context rejection', async () => {
  for (const change of ['account', 'organization', 'role', 'generation', 'replaced', 'cookie']) {
    const f = fixture();
    let observed = 0;
    const pending = f
      .request(
        '/api/assistant/turn',
        options(() => observed++),
      )
      .catch((error) => error);
    if (change === 'account') f.state.account.id = 'different';
    if (change === 'organization') f.state.account.organizationId = 'different';
    if (change === 'role') f.state.account.role = 'staff';
    if (change === 'generation') f.state.assistantGeneration++;
    if (change === 'replaced') f.state.account = { ...f.state.account };
    f.calls[0].reply(
      'ct_request;dur=5',
      change === 'cookie' ? 428 : 200,
      change === 'cookie' ? { code: 'AUTH_CONTEXT_CHANGED' } : { ok: true },
    );
    const result = await pending;
    assert.equal(observed, 0, change);
    if (['account', 'organization', 'cookie'].includes(change))
      assert.equal(result.code, 'AUTH_CONTEXT_CHANGED');
  }
});
