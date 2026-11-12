const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serveStatic } = require('../src/server/http/static-files.cjs');
const { files, staticSources } = require('../src/shared/web-assets.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-product-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file);
  }
  for (const file of [
    'product.html',
    'product.css',
    'product-content.css',
    'robots.txt',
    'sitemap.xml',
  ])
    fs.copyFileSync(path.resolve(__dirname, '..', staticSources[file]), path.join(root, file));
  fs.copyFileSync(
    path.resolve(__dirname, '../src/client/modules/auth/login.html'),
    path.join(root, 'login.html'),
  );
  return async (pathname, { method = 'GET', session = null } = {}) => {
    const result = {};
    await serveStatic(
      { method },
      {
        writeHead(status, headers) {
          Object.assign(result, { status, headers });
        },
        end(body) {
          result.body = body == null ? '' : body.toString();
        },
      },
      new URL(pathname, 'https://example.test'),
      session,
      root,
    );
    return result;
  };
}

test('public product uses exact canonical aliases without opening adjacent paths', async (t) => {
  const request = fixture(t);
  const guest = await request('/product/');
  const member = await request('/product/', { session: { id: 'synthetic' } });
  assert.equal(guest.status, 200);
  assert.equal(guest.body, member.body);
  assert.equal(guest.headers['Cache-Control'], 'no-store');
  assert.match(guest.body, /rel="canonical" href="https:\/\/example.invalid\/product\/"/);
  assert.doesNotMatch(guest.body, /<script\b|name="robots" content="noindex"/);
  for (const route of ['/product', '/product.html']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(route, { method });
      assert.equal(response.status, 308);
      assert.equal(response.headers.Location, '/product/');
      assert.equal(response.body, '');
    }
  }
  for (const route of ['/product/private', '/product/index.html', '/product/kartoteka/'])
    await assert.rejects(request(route), /Файл не найден/);
  await assert.rejects(request('/app.js'), /Войдите в картотеку/);
  assert.equal((await request('/product/', { method: 'HEAD' })).body, '');
});

test('guest entry aliases remain the same noindex form, while cabinet shell stays protected', async (t) => {
  const request = fixture(t);
  const login = await request('/login.html');
  for (const route of ['/', '/index.html', '/login.html']) {
    const response = await request(route);
    assert.equal(response.body, login.body);
    assert.match(response.body, /<meta name="robots" content="noindex"/);
    assert.match(response.body, /<a href="\/product\/">О Картотеке<\/a>/);
    assert.doesNotMatch(response.body, /rel="canonical"/);
  }
  assert.equal((await request('/', { session: { id: 'synthetic' } })).body, 'index.html');
});

test('discovery resources have explicit MIME and list only the public canonical landing', async (t) => {
  const request = fixture(t);
  for (const [route, mime] of [
    ['/robots.txt', 'text/plain'],
    ['/sitemap.xml', 'application/xml'],
  ]) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], `${mime}; charset=utf-8`);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal((await request(route, { method: 'HEAD' })).body, '');
  }
  const robots = (await request('/robots.txt')).body;
  assert.doesNotMatch(robots, /^Disallow:/m);
  assert.match(robots, /Sitemap: https:\/\/example.invalid\/sitemap.xml/);
  const sitemap = (await request('/sitemap.xml')).body;
  assert.deepEqual(
    [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]),
    ['https://example.invalid//product/'],
  );
});
