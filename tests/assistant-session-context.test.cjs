const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../src/client/core/session.js'), 'utf8');
function fixture() {
  const state = {
    account: { id: 'synthetic-owner', organizationId: 'synthetic-org', role: 'owner' },
    assistantGeneration: 2,
  };
  const calls = [],
    redirects = [],
    timers = new Map();
  let timerId = 0,
    resets = 0;
  const factory = vm.runInNewContext(source + '\ncreateSession', {
    window: new EventTarget(),
    AbortController,
    location: { hash: '', replace: (target) => redirects.push(target) },
    setTimeout(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch(url, options) {
      return new Promise((resolve) =>
        calls.push({
          url,
          options,
          complete(status) {
            resolve({
              status,
              ok: status < 400,
              json: async () => ({ error: 'Synthetic expired response' }),
            });
          },
        }),
      );
    },
  });
  return {
    state,
    calls,
    redirects,
    timers,
    api: factory(state, {
      resetAssistant() {
        resets++;
      },
    }),
    resets: () => resets,
  };
}
const mutations = [
  [
    'account',
    (s) => {
      s.account.id = 'synthetic-other';
    },
  ],
  [
    'organization',
    (s) => {
      s.account.organizationId = 'synthetic-other-org';
    },
  ],
  [
    'role',
    (s) => {
      s.account.role = 'cosmetologist';
    },
  ],
  [
    'generation',
    (s) => {
      s.assistantGeneration++;
    },
  ],
  [
    'session account object',
    (s) => {
      s.account = { ...s.account };
    },
  ],
];
for (const [route, method] of [
  ['/api/assistant/scope', 'GET'],
  ['/api/assistant/turn', 'POST'],
  ['/api/assistant/transcribe', 'POST'],
  ['/api/assistant/speak', 'POST'],
])
  test(route + ' stale401 cannot reset or redirect a newer assistant context', async () => {
    for (const [name, mutate] of mutations) {
      const f = fixture();
      const pending = f.api
        .request(route, { method, assistantRequest: true })
        .catch((error) => error);
      mutate(f.state);
      f.calls[0].complete(401);
      const error = await pending;
      const changedAccount = name === 'account' || name === 'organization';
      assert.equal(error.status, changedAccount ? 428 : 401, name);
      if (changedAccount) {
        assert.equal(error.code, 'AUTH_CONTEXT_CHANGED', name);
        assert.equal(error.outcomeUnknown, false, name);
      }
      assert.equal(f.resets(), 0, name);
      assert.deepEqual(f.redirects, [], name);
      assert.equal(f.timers.size, 0, name);
    }
  });
test('current assistant401 still revokes access and redirects exactly once', async () => {
  for (const [route, method] of [
    ['/api/assistant/scope', 'GET'],
    ['/api/assistant/turn', 'POST'],
  ]) {
    const f = fixture();
    const pending = f.api
      .request(route, { method, assistantRequest: true })
      .catch((error) => error);
    f.calls[0].complete(401);
    assert.equal((await pending).status, 401);
    assert.equal(f.resets(), 1);
    assert.deepEqual(f.redirects, ['/']);
    assert.equal(f.timers.size, 0);
  }
});
test('assistant context fencing does not change ordinary requests or unrecognized opt-in routes', async () => {
  for (const [route, options] of [
    ['/api/cabinet', { method: 'POST' }],
    ['/api/auth/session', {}],
    ['/api/assistant/turn', { method: 'POST' }],
    ['/api/assistant/scope', { method: 'GET', assistantRequest: false }],
    ['/api/assistant/scope?other=1', { method: 'GET', assistantRequest: true }],
    ['/api/assistant/turn', { method: 'PATCH', assistantRequest: true }],
  ]) {
    const f = fixture();
    const pending = f.api.request(route, options).catch((error) => error);
    f.state.assistantGeneration++;
    f.calls[0].complete(401);
    assert.equal((await pending).status, 401);
    assert.equal(f.resets(), 1, route);
    assert.deepEqual(f.redirects, ['/'], route);
    assert.equal(f.timers.size, 0, route);
  }
});
