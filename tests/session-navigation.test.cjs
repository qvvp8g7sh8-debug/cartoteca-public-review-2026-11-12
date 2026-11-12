const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/client/core/session.js'), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture({ browser = true, ignoreFetchAbort = false, ignoreBodyAbort = false } = {}) {
  const window = new EventTarget(),
    calls = [],
    timers = new Map(),
    listeners = new Map();
  const addListener = window.addEventListener.bind(window),
    removeListener = window.removeEventListener.bind(window);
  window.addEventListener = (name, callback, options) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    addListener(name, callback, options);
  };
  window.removeEventListener = (name, callback, options) => {
    listeners.get(name)?.delete(callback);
    removeListener(name, callback, options);
  };
  let timerId = 0;
  const globals = {
    AbortController,
    console,
    setTimeout(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch(url, options) {
      const network = deferred(),
        body = deferred();
      const call = { url, options, network, body, aborts: 0, bodyStarted: false };
      options.signal.addEventListener(
        'abort',
        () => {
          call.aborts++;
          if (!ignoreFetchAbort)
            network.reject(Object.assign(Error('Synthetic fetch abort'), { name: 'AbortError' }));
          if (call.bodyStarted && !ignoreBodyAbort)
            body.reject(Object.assign(Error('Synthetic body abort'), { name: 'AbortError' }));
        },
        { once: true },
      );
      call.respond = (status = 200) =>
        network.resolve({
          status,
          ok: status >= 200 && status < 300,
          json() {
            call.bodyStarted = true;
            return body.promise;
          },
        });
      call.complete = (data, status = 200) => {
        call.respond(status);
        body.resolve(data);
      };
      calls.push(call);
      return network.promise;
    },
    ...(browser ? { window } : {}),
  };
  const create = vm.runInNewContext(source + '\ncreateSession', globals);
  return {
    session: create({}, {}),
    window,
    calls,
    timers,
    listeners: (name) => listeners.get(name)?.size || 0,
    pagehide() {
      window.dispatchEvent(new Event('pagehide'));
    },
    pageshow({ persisted = false } = {}) {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: persisted });
      window.dispatchEvent(event);
    },
  };
}
const nextTurn = () => new Promise(setImmediate);
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Pagehide did not settle the pending read')), 300);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('pagehide aborts every pending GET/HEAD but reports only a read failure', async () => {
  const f = fixture();
  const pending = [
    f.session.request('/default-read'),
    f.session.request('/explicit-get', { method: 'GET' }),
    f.session.request('/head', { method: 'head' }),
    f.session.request('/lowercase-get', { method: 'get' }),
  ].map((task) => task.catch((error) => error));
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every((call) => !call.options.signal.aborted));
  f.pagehide();
  const errors = await bounded(Promise.all(pending));
  assert.ok(f.calls.every((call) => call.options.signal.aborted && call.aborts === 1));
  for (const error of errors) {
    assert.equal(error.outcomeUnknown, false);
    assert.match(error.message, /Нет связи/);
  }
  assert.equal(f.timers.size, 0);
});

test('GET/HEAD use keepalive transport and retain ordinary JSON response handling', async () => {
  const f = fixture();
  const methods = [undefined, 'GET', 'head', 'gEt'];
  const pending = methods.map((method, index) =>
    f.session.request('/transport-read-' + index, method ? { method } : {}),
  );
  assert.equal(f.calls.length, methods.length);
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.options.keepalive, true);
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.signal.aborted, false);
    assert.equal(call.options.headers['X-Cartoteca-Request'], '1');
    call.complete({ index, received: true });
  }
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map((result) => result.index),
    [0, 1, 2, 3],
  );
  assert.ok(results.every((result) => result.received));
  assert.equal(f.listeners('beforeunload'), 0);
  assert.equal(f.timers.size, 0);
});

test('beforeunload cancels pending reads without blocking navigation and unbinds once reads finish', async () => {
  const f = fixture();
  assert.equal(f.listeners('beforeunload'), 0);
  const reads = [
    f.session.request('/pending-get'),
    f.session.request('/pending-head', { method: 'HEAD' }),
  ].map((task) => task.catch((error) => error));
  const mutation = f.session.request('/pending-mutation', { method: 'PATCH', body: '{}' });
  assert.equal(f.listeners('beforeunload'), 1);
  const leaving = new Event('beforeunload', { cancelable: true });
  assert.equal(f.window.dispatchEvent(leaving), true);
  assert.equal(leaving.defaultPrevented, false);
  assert.equal(leaving.returnValue, true);
  const errors = await bounded(Promise.all(reads));
  assert.ok(errors.every((error) => error.outcomeUnknown === false));
  assert.ok(f.calls.slice(0, 2).every((call) => call.options.signal.aborted));
  assert.equal(f.calls[2].options.signal.aborted, false);
  assert.equal(f.listeners('beforeunload'), 0);
  const resumed = f.session.request('/resumed-read');
  assert.equal(f.listeners('beforeunload'), 1);
  f.calls[3].complete({ resumed: true });
  assert.equal((await resumed).resumed, true);
  assert.equal(f.listeners('beforeunload'), 0);
  f.calls[2].complete({ saved: true });
  assert.equal((await mutation).saved, true);
  assert.equal(f.timers.size, 0);
});

test('pagehide read cancellation covers the response JSON phase and non-aborting mocks', async () => {
  const f = fixture({ ignoreFetchAbort: true, ignoreBodyAbort: true });
  const pending = f.session.request('/body-read').catch((error) => error);
  f.calls[0].respond();
  await nextTurn();
  assert.equal(f.calls[0].bodyStarted, true);
  f.pagehide();
  const error = await bounded(pending);
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(error.outcomeUnknown, false);
  assert.equal(f.timers.size, 0);
});

test('pagehide does not explicitly abort POST/PATCH/PUT or classify their result as a known cancellation', async () => {
  const f = fixture();
  const methods = ['POST', 'PATCH', 'put'];
  const pending = methods.map((method) =>
    f.session.request('/mutation-' + method, { method, body: '{}' }),
  );
  assert.ok(f.calls.every((call) => !Object.hasOwn(call.options, 'keepalive')));
  for (const call of f.calls) call.respond();
  await nextTurn();
  f.pagehide();
  assert.ok(f.calls.every((call) => !call.options.signal.aborted && call.aborts === 0));
  for (const [index, call] of f.calls.entries()) call.body.resolve({ saved: methods[index] });
  const saved = await Promise.all(pending);
  assert.deepEqual(
    saved.map((value) => value.saved),
    methods,
  );
  assert.equal(f.timers.size, 0);
});

test('mutation external abort and timeout still require reconciliation after pagehide', async () => {
  const f = fixture(),
    external = new AbortController();
  const first = f.session
    .request('/post', { method: 'POST', signal: external.signal })
    .catch((error) => error);
  const second = f.session
    .request('/patch', { method: 'PATCH', timeoutMs: 1 })
    .catch((error) => error);
  f.pagehide();
  assert.ok(f.calls.every((call) => !call.options.signal.aborted));
  external.abort();
  [...f.timers.values()].at(-1)();
  const errors = await bounded(Promise.all([first, second]));
  assert.ok(f.calls.every((call) => call.options.signal.aborted));
  for (const error of errors) {
    assert.equal(error.outcomeUnknown, true);
    assert.match(error.message, /неизвестен/);
  }
  assert.equal(f.timers.size, 0);
});

test('finished and rejected reads are removed before later pagehide', async () => {
  const f = fixture();
  const complete = f.session.request('/finished');
  f.calls[0].complete({ done: true });
  assert.equal((await complete).done, true);
  const rejected = f.session.request('/not-found').catch((error) => error);
  f.calls[1].complete({ error: 'Synthetic missing resource' }, 404);
  assert.equal((await rejected).status, 404);
  f.pagehide();
  f.pagehide();
  assert.ok(f.calls.every((call) => !call.options.signal.aborted && call.aborts === 0));
  assert.equal(f.timers.size, 0);
});

test('a resumed document can make new reads after pagehide without a sticky cancelled state', async () => {
  const f = fixture();
  const first = f.session.request('/before-hide').catch((error) => error);
  f.pagehide();
  assert.equal((await bounded(first)).outcomeUnknown, false);
  f.pageshow();
  const next = f.session.request('/after-show');
  assert.equal(f.calls[1].options.signal.aborted, false);
  f.calls[1].complete({ fresh: true });
  assert.equal((await next).fresh, true);
  const later = f.session.request('/after-resume-pending').catch((error) => error);
  f.pagehide();
  assert.equal(f.calls[1].options.signal.aborted, false);
  assert.equal((await bounded(later)).outcomeUnknown, false);
  assert.equal(f.calls[2].options.signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test('departed documents reject new GET/HEAD without fetching but allow POST and resume on BFcache pageshow', async () => {
  const f = fixture();
  f.pagehide();
  const blocked = [
    f.session.request('/departed-default'),
    f.session.request('/departed-get', { method: 'get' }),
    f.session.request('/departed-head', { method: 'HEAD' }),
  ].map((task) => task.catch((error) => error));
  const errors = await bounded(Promise.all(blocked));
  assert.equal(f.calls.length, 0);
  for (const error of errors) {
    assert.equal(error.outcomeUnknown, false);
    assert.match(error.message, /Нет связи/);
  }
  assert.equal(f.listeners('beforeunload'), 0);
  assert.equal(f.timers.size, 0);

  const mutation = f.session.request('/departed-post', { method: 'POST', body: '{}' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.signal.aborted, false);
  assert.equal(Object.hasOwn(f.calls[0].options, 'keepalive'), false);
  f.calls[0].complete({ saved: true });
  assert.equal((await mutation).saved, true);

  f.pageshow({ persisted: true });
  const reads = [
    f.session.request('/restored-get'),
    f.session.request('/restored-head', { method: 'head' }),
  ];
  assert.equal(f.calls.length, 3);
  for (const call of f.calls.slice(1)) {
    assert.equal(call.options.keepalive, true);
    assert.equal(call.options.signal.aborted, false);
    call.complete({ restored: true });
  }
  assert.ok((await Promise.all(reads)).every((result) => result.restored));
  assert.equal(f.listeners('beforeunload'), 0);
  assert.equal(f.timers.size, 0);
});

test('read timeout still interrupts headers and JSON processing even when transport ignores abort', async () => {
  for (const bodyPhase of [false, true]) {
    const f = fixture({ ignoreFetchAbort: true, ignoreBodyAbort: true });
    const pending = f.session.request('/read-timeout', { timeoutMs: 37 }).catch((error) => error);
    assert.equal(f.calls[0].options.keepalive, true);
    if (bodyPhase) {
      f.calls[0].respond();
      await nextTurn();
      assert.equal(f.calls[0].bodyStarted, true);
    }
    assert.equal(f.timers.size, 1);
    [...f.timers.values()][0]();
    const error = await bounded(pending);
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.calls[0].aborts, 1);
    assert.equal(error.outcomeUnknown, false);
    assert.match(error.message, /Нет связи/);
    assert.equal(f.listeners('beforeunload'), 0);
    assert.equal(f.timers.size, 0);
  }
});

test('an already aborted external read signal prevents fetch with keepalive enabled', async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  const error = await bounded(
    f.session
      .request('/pre-aborted-read', { signal: controller.signal })
      .catch((failure) => failure),
  );
  assert.equal(error.outcomeUnknown, false);
  assert.match(error.message, /Нет связи/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.listeners('beforeunload'), 0);
  assert.equal(f.timers.size, 0);
});

test('explicit read abort and server mutation rejection keep their existing contracts', async () => {
  const f = fixture(),
    controller = new AbortController();
  const read = f.session
    .request('/cancelled-read', { signal: controller.signal })
    .catch((error) => error);
  controller.abort();
  assert.equal((await bounded(read)).outcomeUnknown, false);
  const write = f.session
    .request('/conflict', { method: 'PATCH', body: '{}' })
    .catch((error) => error);
  f.pagehide();
  f.calls[1].complete({ error: 'Synthetic revision conflict' }, 409);
  const error = await write;
  assert.equal(error.status, 409);
  assert.equal(error.outcomeUnknown, undefined);
  assert.equal(f.calls[1].options.signal.aborted, false);
});

test('session requests still work in non-window async-workflow fixtures', async () => {
  const f = fixture({ browser: false });
  const pending = f.session.request('/no-window');
  f.calls[0].complete({ compatible: true });
  assert.equal((await pending).compatible, true);
  assert.equal(f.timers.size, 0);
});
