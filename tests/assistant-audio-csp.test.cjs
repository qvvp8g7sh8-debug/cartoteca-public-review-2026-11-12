const test = require('node:test');
const assert = require('node:assert/strict');
const { secureRequest } = require('../src/server/http/security.cjs');
function fixture({ host = 'localhost:4186', method = 'GET', origin, requestOrigin, marker } = {}) {
  const headers = new Map();
  const req = {
    url: '/',
    method,
    socket: { localPort: 4186 },
    headers: {
      host,
      ...(requestOrigin !== undefined ? { origin: requestOrigin } : {}),
      ...(marker !== undefined ? { 'x-cartoteca-request': marker } : {}),
    },
  };
  const res = { setHeader: (name, value) => headers.set(name.toLowerCase(), value) };
  return { headers, run: () => secureRequest(req, res, origin), req };
}
function policy(f) {
  const value = f.headers.get('content-security-policy');
  assert.equal(typeof value, 'string');
  const result = new Map();
  for (const part of value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/u);
    assert.equal(result.has(name), false, 'Security directives cannot be duplicated');
    result.set(name, sources);
  }
  return result;
}
test('application responses explicitly permit same-origin and blob media without external audio sources', () => {
  for (const config of [
    {},
    { host: '127.0.0.1:4186' },
    { host: 'cartoteca.example', origin: 'https://cartoteca.example' },
  ]) {
    const f = fixture(config);
    f.run();
    const directives = policy(f);
    assert.deepEqual(
      directives.get('media-src'),
      ["'self'", 'blob:'],
      'Completed provider audio is played from a local Blob URL',
    );
    for (const source of ['*', 'https:', 'http:', 'data:', 'https://api.timeweb.ai'])
      assert.equal(
        directives.get('media-src').includes(source),
        false,
        'Direct provider and arbitrary remote media remain disallowed',
      );
  }
});
test('the media exception does not relax script, connection, framing, form or baseline security headers', () => {
  const f = fixture();
  f.run();
  const directives = policy(f);
  directives.delete('media-src');
  assert.deepEqual(Object.fromEntries(directives), {
    'default-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'style-src': ["'self'"],
    'script-src': ["'self'"],
    'connect-src': ["'self'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  });
  assert.equal(f.headers.get('cache-control'), 'no-store');
  assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(f.headers.get('referrer-policy'), 'no-referrer');
});
test('allowing local media does not bypass host and application-origin write checks', () => {
  assert.throws(() => fixture({ host: 'untrusted.example' }).run(), { status: 403 });
  for (const config of [
    { method: 'POST' },
    { method: 'POST', requestOrigin: 'https://untrusted.example', marker: '1' },
    { method: 'POST', requestOrigin: 'http://localhost:4186' },
  ])
    assert.throws(() => fixture(config).run(), { status: 403 });
  const valid = fixture({ method: 'POST', requestOrigin: 'http://localhost:4186', marker: '1' });
  assert.equal(valid.run(), 'http://localhost:4186');
  assert.deepEqual(policy(valid).get('media-src'), ["'self'", 'blob:']);
});
