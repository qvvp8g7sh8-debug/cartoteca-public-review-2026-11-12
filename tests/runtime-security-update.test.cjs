const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('security release pins Docker, CI, engines and installed dependency floors', () => {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  assert.ok(
    (major === 24 && (minor > 22 || (minor === 22 && patch >= 1))) ||
      (major === 26 && (minor > 12 || (minor === 12 && patch >= 1))),
    'Run with a patched supported Node release',
  );
  assert.equal(typeof zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, 'number');
  assert.match(
    fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'),
    /^FROM node:24\.22\.1-bookworm-slim$/m,
  );
  for (const file of ['release.yml', 'delivery-lease.yml']) {
    const text = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    const pins = [...text.matchAll(/node-version: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(pins.length);
    assert.ok(pins.every((pin) => pin === '24.22.1'));
  }
  assert.equal(require('../package.json').engines.node, '^24.22.1 || ^26.12.1');
  assert.equal(
    require('../package-lock.json').packages[''].engines.node,
    require('../package.json').engines.node,
  );
  assert.equal(require('nodemailer/package.json').version, '10.2.1');
  const installed = require('undici/package.json').version.split('.').map(Number);
  assert.ok(
    installed[0] === 8 && (installed[1] > 12 || (installed[1] === 12 && installed[2] >= 2)),
  );
});

test('DNS resolver rejects embedded NUL before lookup', () => {
  assert.throws(() => dns.resolve('attacker.example\0.trusted.example', () => {}), {
    code: 'ERR_INVALID_ARG_VALUE',
  });
});

test('mail address parser preserves recipient across nested comments', () => {
  const parse = require('nodemailer/lib/addressparser');
  assert.deepEqual(
    parse('Victim (x(y) <evil@evil.test>) <v@victim.test>').map((v) => v.address),
    ['v@victim.test'],
  );
  assert.deepEqual(
    parse('Client <client@example.test>').map((v) => v.address),
    ['client@example.test'],
  );
});

for (const [label, fetchImpl] of [
  ['runtime', globalThis.fetch],
  ['test dependency', require('undici').fetch],
])
  test(
    label + ' fetch decodes valid Brotli and safely rejects invalid encoding responses',
    async (t) => {
      const payload = JSON.stringify({ ok: true });
      const server = http.createServer((req, res) => {
        if (req.url === '/excess') {
          res.writeHead(200, {
            'Content-Encoding': 'gzip,gzip,gzip,gzip,gzip,gzip',
            'Content-Length': '1',
          });
          res.end(Buffer.from([0]));
        } else if (req.url === '/broken') {
          res.writeHead(200, { 'Content-Encoding': 'br' });
          res.end(Buffer.from([255]));
        } else if (req.url === '/br') {
          res.writeHead(200, { 'Content-Encoding': 'br', 'Content-Type': 'application/json' });
          res.end(zlib.brotliCompressSync(Buffer.from(payload)));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(payload);
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      const base = 'http://127.0.0.1:' + server.address().port;
      for (const route of ['/br', '/plain']) {
        const response = await fetchImpl(base + route, { signal: AbortSignal.timeout(3000) });
        assert.deepEqual(await response.json(), { ok: true });
      }
      for (const route of ['/broken'])
        await assert.rejects(async () => {
          const response = await fetchImpl(base + route, { signal: AbortSignal.timeout(3000) });
          await response.arrayBuffer();
        });
      await assert.rejects(
        () => fetchImpl(base + '/excess', { signal: AbortSignal.timeout(3000) }),
        (error) => /too many content-encodings/.test(error.cause?.message || error.message),
      );
    },
  );
