const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/client/core/session.js'), 'utf8');
function fixture() {
  const calls = [],
    timers = new Map(),
    redirects = [],
    window = new EventTarget();
  let timerId = 0,
    resets = 0;
  const create = vm.runInNewContext(source + '\ncreateSession', {
    window,
    AbortController,
    location: { hash: '', replace: (url) => redirects.push(url) },
    setTimeout(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch(url, options) {
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      options.signal.addEventListener('abort', () => reject(Error('Synthetic transport abort')), {
        once: true,
      });
      calls.push({
        url,
        options,
        reject,
        complete(result, status = 200) {
          resolve({ status, ok: status >= 200 && status < 300, json: async () => result });
        },
        headers(status, json) {
          resolve({ status, ok: status >= 200 && status < 300, json });
        },
      });
      return promise;
    },
  });
  return {
    session: create({}, { resetAssistant: () => resets++ }),
    calls,
    timers,
    redirects,
    window,
    resets: () => resets,
  };
}
const endpoints = ['turn', 'transcribe', 'speak'];
test('legacy speech preserves the public proof-required code and hides unknown codes', async () => {
  for (const code of ['ASSISTANT_SPEECH_PROOF_REQUIRED', 'UNSAFE_UNKNOWN_CODE']) {
    const f = fixture();
    const pending = f.session.request('/api/assistant/speak', {
      method: 'POST', assistantRequest: true, body: '{}',
    }).catch((error) => error);
    f.calls[0].complete({ error: 'Synthetic speech refusal', code }, 403);
    const error = await pending;
    assert.equal(error.status, 403);
    assert.equal(error.code, code === 'ASSISTANT_SPEECH_PROOF_REQUIRED' ? code : undefined);
    assert.equal(f.calls.length, 1);
    assert.equal(f.redirects.length, 0);
  }
});
for (const endpoint of endpoints) {
  test(
    endpoint +
      ' opt-in preserves a completed HTTP provider error without claiming an unknown appointment save',
    async () => {
      for (const status of [400, 403, 409, 429, 500, 502, 503, 504]) {
        const f = fixture();
        const result = f.session
          .request('/api/assistant/' + endpoint, {
            method: 'POST',
            assistantRequest: true,
            body: '{}',
          })
          .catch((error) => error);
        f.calls[0].complete({ error: 'Synthetic provider error ' + status }, status);
        const error = await result;
        assert.equal(error.status, status);
        assert.equal(error.message, 'Synthetic provider error ' + status);
        assert.equal(error.outcomeUnknown, undefined);
        assert.equal(Object.hasOwn(f.calls[0].options, 'assistantRequest'), false);
        assert.equal(f.calls[0].options.headers['X-Cartoteca-Request'], '1');
        assert.equal(f.timers.size, 0);
        assert.equal(f.calls.length, 1);
      }
    },
  );
  test(
    endpoint +
      ' network failure, deadline and explicit abort remain unknown with assistant wording and no retry',
    async () => {
      for (const reason of ['network', 'timeout', 'abort', 'json']) {
        const f = fixture(),
          caller = new AbortController();
        const pending = f.session
          .request('/api/assistant/' + endpoint, {
            method: 'post',
            assistantRequest: true,
            signal: caller.signal,
            timeoutMs: 20,
          })
          .catch((error) => error);
        if (reason === 'network') f.calls[0].reject(Error('Synthetic network failure'));
        else if (reason === 'timeout') [...f.timers.values()][0]();
        else if (reason === 'abort') caller.abort();
        else
          f.calls[0].headers(502, async () => {
            throw Error('Synthetic malformed JSON');
          });
        const error = await pending;
        assert.equal(error.outcomeUnknown, true);
        assert.equal(error.status, undefined);
        assert.equal(
          error.assistantFailure,
          reason === 'timeout' ? 'deadline' : reason === 'json' ? 'response' : 'network',
        );
        assert.match(error.message, /^Ответ помощника не получен/);
        assert.doesNotMatch(error.message, /сохранени|сохранён|сохранен/);
        assert.equal(f.calls.length, 1);
        assert.equal(f.timers.size, 0);
        if (['timeout', 'abort'].includes(reason))
          assert.equal(f.calls[0].options.signal.aborted, true);
      }
    },
  );
}
test('only exact opted-in assistant POST endpoints change 5xx classification; ordinary saves and other methods keep their contract', async () => {
  for (const [url, options] of [
    ['/api/cabinet', { method: 'POST', assistantRequest: true }],
    ['/api/assistant/turn', { method: 'POST' }],
    ['/api/assistant/turn', { method: 'POST', assistantRequest: false }],
    ['/api/assistant/turn', { method: 'POST', assistantRequest: 'true' }],
    ['/api/assistant/turn', { method: 'PATCH', assistantRequest: true }],
    ['/api/assistant/speak/extra', { method: 'POST', assistantRequest: true }],
    ['/api/assistant/turn?scope=other', { method: 'POST', assistantRequest: true }],
    ['/api/admin/voice-assistant/settings', { method: 'POST', assistantRequest: true }],
  ]) {
    const f = fixture(),
      pending = f.session.request(url, options).catch((error) => error);
    f.calls[0].complete({ error: 'Synthetic HTTP failure' }, 503);
    const error = await pending;
    assert.equal(error.status, undefined);
    assert.equal(error.outcomeUnknown, true);
    assert.match(error.message, /Результат сохранения пока неизвестен/);
    assert.equal(Object.hasOwn(f.calls[0].options, 'assistantRequest'), false);
  }
});
test('assistant scope GET retains read transport, while a pagehide does not cancel opted-in POST or change success handling', async () => {
  const f = fixture();
  const scope = f.session
    .request('/api/assistant/scope', { assistantRequest: true })
    .catch((error) => error);
  assert.equal(f.calls[0].options.keepalive, true);
  f.calls[0].complete({ error: 'Synthetic scope unavailable' }, 503);
  assert.equal((await scope).status, 503);
  assert.equal((await scope).outcomeUnknown, undefined);
  const pending = f.session.request('/api/assistant/turn', {
    method: 'POST',
    assistantRequest: true,
  });
  assert.equal(f.calls[1].options.keepalive, undefined);
  f.window.dispatchEvent(new Event('pagehide'));
  assert.equal(f.calls[1].options.signal.aborted, false);
  const reply = { text: 'Synthetic success', policyVersion: 1 };
  f.calls[1].complete(reply);
  assert.equal(await pending, reply);
  assert.equal(f.timers.size, 0);
});
test('known empty assistant HTTP failure has assistant fallback wording and 401 still redirects and resets access', async () => {
  const f = fixture();
  const failed = f.session
    .request('/api/assistant/speak', { method: 'POST', assistantRequest: true })
    .catch((error) => error);
  f.calls[0].complete({}, 502);
  const error = await failed;
  assert.equal(error.status, 502);
  assert.equal(error.outcomeUnknown, undefined);
  assert.equal(error.message, 'Не удалось получить ответ помощника.');
  const denied = f.session
    .request('/api/assistant/turn', { method: 'POST', assistantRequest: true })
    .catch((error) => error);
  f.calls[1].complete({ error: 'Synthetic session expired' }, 401);
  assert.equal((await denied).status, 401);
  assert.equal(f.resets(), 1);
  assert.deepEqual(f.redirects, ['/']);
});

test('payment network hard-off is definite only for exact checkout; ordinary mutations retain unknown outcome', async () => {
  for (const [url, status, code, definite] of [
    ['/api/billing/checkout', 503, 'PAYMENTS_NETWORK_DISABLED', true],
    ['/api/cabinet', 503, 'PAYMENTS_NETWORK_DISABLED', false],
    ['/api/billing/checkout/other', 503, 'PAYMENTS_NETWORK_DISABLED', false],
    ['/api/billing/checkout', 500, 'PAYMENTS_NETWORK_DISABLED', false],
    ['/api/billing/checkout', 503, undefined, false],
  ]) {
    const f = fixture(),
      pending = f.session.request(url, { method: 'POST', body: '{}' }).catch((error) => error);
    f.calls[0].complete(
      { error: 'Synthetic payments disabled', ...(code ? { code } : {}) },
      status,
    );
    const error = await pending;
    if (definite) {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'PAYMENTS_NETWORK_DISABLED');
      assert.equal(error.message, 'Synthetic payments disabled');
      assert.notEqual(error.outcomeUnknown, true);
    } else {
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.status, undefined);
    }
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 0);
  }
});

test('151 only explicit cabinet pre-dispatch rejection is known not started', async () => {
  for (const [url, method, status, unknown] of [
    ['/api/cabinet/appointments', 'POST', 503, false],
    ['/api/cabinet/changes', 'PATCH', 504, false],
    ['/api/cabinet', 'PUT', 503, false],
    ['/api/cabinet/appointments', 'POST', 500, true],
    ['/api/other', 'POST', 503, true],
  ]) {
    const f = fixture(),
      pending = f.session.request(url, { method });
    f.calls[0].complete({ error: 'Busy', code: 'CABINET_COMMAND_NOT_STARTED' }, status);
    await assert.rejects(pending, (e) =>
      unknown
        ? e.outcomeUnknown === true
        : e.outcomeUnknown === false && e.code === 'CABINET_COMMAND_NOT_STARTED',
    );
  }
});
