const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('service worker only handles its explicit public shell, never API, cards or cross-origin requests', async () => {
  const handlers = new Map(), fetched = [], cached = [];
  const cache = { match: async () => null, keys: async () => [], put: async (request) => cached.push(request.url) };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/client/pwa/service-worker.js'), 'utf8'),
    {
      URL,
      self: {
        location: { origin: 'https://synthetic.test' },
        addEventListener: (name, handler) => handlers.set(name, handler),
      },
      caches: { open: async () => cache, match: async () => null },
      fetch: async (request) => {
        fetched.push(request.url);
        return { ok: true, clone: () => ({}) };
      },
    },
  );
  assert.deepEqual([...handlers.keys()], ['push', 'notificationclick', 'install', 'activate', 'fetch']);
  for (const [url, method] of [
    ['https://synthetic.test/api/patients', 'GET'],
    ['https://synthetic.test/', 'GET'],
    ['https://synthetic.test/app.js', 'GET'],
    ['https://synthetic.test/api/photos/synthetic', 'GET'],
    ['https://foreign.test/style.css', 'GET'],
    ['https://synthetic.test/style.css', 'POST'],
  ]) {
    let handled = false;
    handlers.get('fetch')({ request: { url, method }, respondWith: () => { handled = true; } });
    assert.equal(handled, false, url);
  }
  assert.equal(fetched.length, 0);
  let response;
  const url = 'https://synthetic.test/style.css?v=1111111111111111';
  handlers.get('fetch')({ request: { url, method: 'GET' }, respondWith: (value) => { response = value; } });
  assert.equal((await response).ok, true);
  assert.deepEqual(fetched, [url]);
  assert.deepEqual(cached, [url]);
});
