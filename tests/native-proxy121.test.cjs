const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createNativeProxy } = require('../src/server/http/native-proxy.cjs');
const {
  createInternalIngress,
  internalContext,
} = require('../src/server/http/internal-ingress.cjs');
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function fixture(t, handler, options = {}) {
  const secret = 'c'.repeat(64),
    child = http.createServer(createInternalIngress(handler, secret));
  const port = await listen(child),
    proxy = createNativeProxy({
      endpoint: () => ({ host: '127.0.0.1', port, transportToken: secret }),
      ...options,
    });
  const server = http.createServer(
    (req, res) =>
      void proxy.run(req, res).catch((error) => {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(error.status || 503);
          res.end('failed');
        }
      }),
  );
  const publicPort = await listen(server);
  t.after(async () => {
    proxy.close();
    server.closeAllConnections();
    child.closeAllConnections();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => child.close(r))]);
  });
  return { proxy, base: 'http://127.0.0.1:' + publicPort, publicPort };
}
test(
  'stream proxy preserves exact body, request identity, status, cookies and strips client private capability',
  { timeout: 5000 },
  async (t) => {
    let received;
    const f = await fixture(t, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = {
        body: Buffer.concat(chunks),
        headers: req.headers,
        context: internalContext(req),
      };
      res.writeHead(201, {
        'Content-Type': 'application/octet-stream',
        'Set-Cookie': ['a=1; HttpOnly', 'b=2; HttpOnly'],
      });
      res.end(received.body);
    });
    const input = Buffer.from('{"literal":"raw bytes \u2028", "spacing":  123}');
    const response = await fetch(f.base + '/api/cabinet/changes?exact=1', {
      method: 'PATCH',
      body: input,
      headers: {
        'Content-Type': 'application/json',
        Origin: f.base,
        'X-Cartoteca-Request': '1',
        'X-Cartoteca-Account-Id': 'account',
        Cookie: 'synthetic=1',
        'X-Cartoteca-Native-Transport': 'forged',
        'X-Cartoteca-Native-Address': '1.2.3.4',
        'X-Cartoteca-Native-Port': '80',
      },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), input);
    assert.deepEqual(received.body, input);
    assert.equal(received.headers.origin, f.base);
    assert.equal(received.headers.cookie, 'synthetic=1');
    assert.equal(received.headers['x-cartoteca-account-id'], 'account');
    assert.equal(received.context.localPort, f.publicPort);
    assert.equal(received.context.remoteAddress, '127.0.0.1');
    assert.equal(received.headers['x-cartoteca-native-transport'], undefined);
    assert.equal(response.headers.getSetCookie().length, 2);
  },
);
test(
  'a response lost after a write is never retried by the transport',
  { timeout: 5000 },
  async (t) => {
    let calls = 0;
    const f = await fixture(t, (req) => {
      calls++;
      req.resume();
      req.once('end', () => req.socket.destroy());
    });
    const result = await fetch(f.base + '/api/cabinet/changes', { method: 'PATCH', body: '{}' });
    assert.equal(result.status, 502);
    await result.text();
    assert.equal(calls, 1);
  },
);
test(
  'proxy capacity is finite and close cancels active and queued connections',
  { timeout: 5000 },
  async (t) => {
    let enter;
    const entered = new Promise((r) => (enter = r));
    const f = await fixture(
      t,
      (req) => {
        req.resume();
        enter();
      },
      { activeLimit: 1, pendingLimit: 1 },
    );
    const first = fetch(f.base + '/one').then(async (r) => [r.status, await r.text()]);
    await entered;
    const second = fetch(f.base + '/two').then(async (r) => [r.status, await r.text()]);
    // Observe queue admission without a timing assumption about TCP scheduling.
    while (f.proxy.stats().pending !== 1) await new Promise((r) => setImmediate(r));
    const third = await fetch(f.base + '/three');
    assert.equal(third.status, 503);
    await third.text();
    assert.equal(f.proxy.stats().active, 1);
    assert.equal(f.proxy.stats().pending, 1);
    f.proxy.close();
    const settled = await Promise.all([first, second]);
    assert.equal(settled[1][0], 503);
    assert.equal(f.proxy.stats().pending, 0);
  },
);

test(
  'expired queued request never starts when an earlier response finishes before its timeout callback',
  { timeout: 5000 },
  async (t) => {
    let clock = 0,
      releaseFirst,
      calls = 0,
      enter;
    const entered = new Promise((r) => (enter = r));
    const f = await fixture(
      t,
      (req, res) => {
        calls++;
        req.resume();
        releaseFirst = () => res.end('ok');
        enter();
      },
      { activeLimit: 1, pendingLimit: 1, waitMs: 10000, now: () => clock },
    );
    const first = fetch(f.base + '/one').then(async (r) => [r.status, await r.text()]);
    await entered;
    const second = fetch(f.base + '/two').then(async (r) => [r.status, await r.text()]);
    while (f.proxy.stats().pending !== 1) await new Promise((r) => setImmediate(r));
    clock = 10001;
    releaseFirst();
    const results = await Promise.all([first, second]);
    assert.equal(results[0][0], 200);
    assert.equal(results[1][0], 503);
    assert.equal(calls, 1);
  },
);
