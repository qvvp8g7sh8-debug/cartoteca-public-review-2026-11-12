const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createInternalIngress,
  internalContext,
} = require('../src/server/http/internal-ingress.cjs');
const { secureRequest } = require('../src/server/http/security.cjs');
const { clientAddressResolver } = require('../client-address.cjs');
const secret = 'a'.repeat(64);
function request(headers = {}) {
  return {
    method: 'POST',
    url: '/api/cabinet/changes',
    headers: {
      host: 'localhost:4174',
      origin: 'http://localhost:4174',
      'x-cartoteca-request': '1',
      'x-cartoteca-native-transport': secret,
      'x-cartoteca-native-address': '203.0.113.5',
      'x-cartoteca-native-port': '4174',
      ...headers,
    },
    socket: { localPort: 12345, remoteAddress: '127.0.0.1' },
  };
}
function response() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    },
  };
}
test('private ingress pins the real public port and original peer only after capability authentication', () => {
  const req = request(),
    res = response();
  let calls = 0;
  createInternalIngress((incoming, output) => {
    calls++;
    assert.deepEqual(internalContext(incoming), { localPort: 4174, remoteAddress: '203.0.113.5' });
    assert.equal(secureRequest(incoming, output, ''), 'http://localhost:4174');
    assert.equal(clientAddressResolver([])(incoming), '203.0.113.5');
    assert.equal(incoming.headers['x-cartoteca-native-transport'], undefined);
  }, secret)(req, res);
  assert.equal(calls, 1);
  assert.equal(internalContext(request()), undefined);
});
test('spoofed private headers fail before application work and cannot become trusted metadata', () => {
  for (const override of [
    { 'x-cartoteca-native-transport': 'b'.repeat(64) },
    { 'x-cartoteca-native-transport': undefined },
    { 'x-cartoteca-native-transport': 'é'.repeat(64) },
    { 'x-cartoteca-native-address': 'spoof' },
    { 'x-cartoteca-native-port': '0' },
    { 'x-cartoteca-native-port': '65536' },
    { 'x-cartoteca-native-port': '4174,80' },
  ]) {
    const req = request(override),
      res = response();
    let calls = 0;
    createInternalIngress(() => calls++, secret)(req, res);
    assert.equal(calls, 0);
    assert.equal(res.status, 403);
    assert.equal(internalContext(req), undefined);
  }
});
test('public mode ignores private-looking client headers and keeps Host/Origin/CSRF checks', () => {
  const req = request(),
    res = response();
  assert.throws(() => secureRequest(req, res, ''), { status: 403 });
  assert.equal(clientAddressResolver([])(req), '127.0.0.1');
  let forwarded;
  const handler = (r) => {
    forwarded = r;
  };
  assert.equal(createInternalIngress(handler), handler);
  createInternalIngress(handler)(req, res);
  assert.equal(forwarded, req);
  for (const override of [
    { origin: 'http://evil.invalid' },
    { 'x-cartoteca-request': undefined },
    { host: 'evil.invalid' },
  ]) {
    const bad = request(override);
    assert.throws(
      () => createInternalIngress((r, s) => secureRequest(r, s, ''), secret)(bad, response()),
      { status: 403 },
    );
  }
});
test('original exact proxy rules survive the local bridge; forwarded-for is never trusted', () => {
  const req = request({
    'x-cartoteca-native-address': '192.0.2.10',
    'x-cartoteca-client-ip': '198.51.100.9',
    'x-forwarded-for': '1.2.3.4',
  });
  createInternalIngress((r) => {
    assert.equal(clientAddressResolver(['192.0.2.10'])(r), '198.51.100.9');
    assert.equal(clientAddressResolver(['127.0.0.1'])(r), '192.0.2.10');
  }, secret)(req, response());
});
