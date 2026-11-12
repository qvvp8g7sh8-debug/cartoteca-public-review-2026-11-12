const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createUiActionTracker } = require('./helpers/ui-action-tracker.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t, fetch) {
  const window = new JSDOM('<p id="result"></p>', { url: 'http://fixture.test/' }).window;
  const tracker = createUiActionTracker({ window, fetch });
  t.after(async () => { await tracker.close(); window.close(); });
  const ready = () => window.document.querySelector('#result').textContent === 'done';
  const show = () => { window.document.querySelector('#result').textContent = 'done'; };
  return { window, tracker, ready, show };
}
const spec = { method: 'POST', path: '/api/save' };

test('one action waits for headers, consumed body and resulting UI separately', async (t) => {
  const headers = gate(), body = gate(), bodyStarted = gate(), process = gate(), processing = gate();
  const f = fixture(t, () => headers.promise);
  let work, settled = false;
  const done = f.tracker.action({ ...spec, ready: f.ready, trigger: () => {
    work = (async () => {
      const response = await f.tracker.fetch('/api/save', { method: 'POST' });
      await response.json(); processing.resolve(); await process.promise; f.show();
    })();
  } });
  done.then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  headers.resolve({ status: 200, json() { bodyStarted.resolve(); return body.promise; } });
  await bodyStarted.promise; assert.equal(settled, false);
  body.resolve({ secret: 'synthetic-body-do-not-log' });
  await processing.promise; assert.equal(settled, false);
  process.resolve(); await work;
  const result = await done;
  assert.deepEqual(Object.keys(result.timingsMs), ['request', 'response', 'body', 'ui']);
  assert.equal(f.tracker.pending(), 0);
  assert.ok(!JSON.stringify(result).includes('synthetic-body'));
});

test('previous same-route fetch, another method and another path do not acknowledge an action', async (t) => {
  const responses = [gate(), gate(), gate(), gate()];
  let calls = 0, work;
  const f = fixture(t, () => responses[calls++].promise);
  const read = async (path, method) => (await f.tracker.fetch(path, { method })).json();
  const previous = read('/api/save', 'POST');
  await tick();
  let settled = false;
  const done = f.tracker.action({ ...spec, ready: f.ready, trigger: () => {
    work = Promise.all([read('/api/save', 'GET'), read('/api/other', 'POST'), read('/api/save?private=value', 'POST')]);
  } });
  done.then(() => { settled = true; });
  for (const response of responses.slice(0, 3)) response.resolve(new Response('{}'));
  f.show(); await previous; await tick();
  assert.equal(settled, false);
  responses[3].resolve(new Response('{}'));
  await work;
  assert.equal((await done).requestId, 4);
});

test('transport rejection fails the observer immediately without logging error or request data', async (t) => {
  const f = fixture(t, () => Promise.reject(Error('secret transport detail')));
  let work;
  const done = f.tracker.action({ ...spec, ready: f.ready, trigger: () => {
    work = f.tracker.fetch('/api/save?token=secret', { method: 'POST', body: 'secret payload' }).catch(() => f.show());
  } });
  await assert.rejects(done, (error) => {
    assert.equal(error.code, 'UI_ACTION_TRANSPORT');
    assert.equal(error.diagnostic.phase, 'transport');
    assert.ok(!JSON.stringify(error).includes('secret'));
    return true;
  });
  await work;
  assert.equal(f.tracker.pending(), 0);
});

test('a rejected body has its own immediate failure phase', async (t) => {
  const f = fixture(t, () => ({ status: 200, json: () => Promise.reject(Error('private parse content')) }));
  let work;
  const done = f.tracker.action({ ...spec, ready: f.ready, trigger: () => {
    work = f.tracker.fetch('/api/save', { method: 'POST' }).then((r) => r.json()).catch(() => {});
  } });
  await assert.rejects(done, { code: 'UI_ACTION_BODY' });
  await work;
});

test('HTTP 200 plus body is not success if UI never becomes ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, () => new Response('{}'));
  let work;
  const done = f.tracker.action({ ...spec, ready: f.ready, trigger: () => {
    work = f.tracker.fetch('/api/save', { method: 'POST' }).then((r) => r.json());
  } });
  const failed = assert.rejects(done, (error) => {
    assert.equal(error.code, 'UI_ACTION_UI_TIMEOUT');
    assert.ok(Object.hasOwn(error.diagnostic.timingsMs, 'body'));
    assert.ok(!Object.hasOwn(error.diagnostic.timingsMs, 'ui'));
    return true;
  });
  await work; t.mock.timers.tick(5000); await failed;
});

test('missing request times out as missing request, not as network or UI failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, () => { throw Error('must not fetch'); });
  const failed = assert.rejects(f.tracker.action({ ...spec, ready: f.ready, trigger() {} }), { code: 'UI_ACTION_REQUEST_TIMEOUT' });
  t.mock.timers.tick(20000); await failed;
});

test('teardown aborts an in-flight fetch and drains its UI rejection handler before DOM close', async (t) => {
  const entered = gate();
  const f = fixture(t, (input, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    entered.resolve();
  }));
  let work;
  const done = f.tracker.action({ ...spec, ready: f.ready, trigger: () => {
    work = f.tracker.fetch('/api/save', { method: 'POST' }).catch(() => f.show());
  } });
  const failed = assert.rejects(done, { code: 'UI_ACTION_ABORT' });
  await entered.promise; await f.tracker.close(); await failed; await work;
  assert.equal(f.tracker.pending(), 0);
  assert.equal(f.ready(), true);
});

test('teardown waits for a body read interrupted by abort before disposing the DOM', async (t) => {
  const entered = gate();
  const f = fixture(t, (input, options) => ({ status: 200, json: () => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    entered.resolve();
  }) }));
  const work = f.tracker.fetch('/api/save', { method: 'POST' }).then((r) => r.json()).catch(() => f.show());
  await entered.promise; await f.tracker.close(); await work;
  assert.equal(f.tracker.pending(), 0);
  assert.equal(f.ready(), true);
});

test('teardown cancels an unconsumed response body, not just the header promise', async (t) => {
  let cancelled = false;
  const f = fixture(t, () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await f.tracker.fetch('/api/save', { method: 'POST' });
  assert.equal(f.tracker.pending(), 1);
  await f.tracker.close();
  assert.equal(cancelled, true);
  assert.equal(f.tracker.pending(), 0);
});

test('two matching requests are rejected as ambiguous rather than choosing a convenient response', async (t) => {
  const f = fixture(t, () => new Response('{}'));
  let work;
  const done = f.tracker.action({ ...spec, ready: f.ready, trigger: () => {
    work = Promise.all([1, 2].map(() => f.tracker.fetch('/api/save', { method: 'POST' }).then((r) => r.json())));
  } });
  await assert.rejects(done, { code: 'UI_ACTION_AMBIGUOUS_REQUEST' });
  await work;
});
