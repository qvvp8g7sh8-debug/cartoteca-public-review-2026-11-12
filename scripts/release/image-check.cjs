// Runs inside the final image with --network none and temporary synthetic storage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function checkSetup(root) {
  let saved = false,
    calls = 0;
  const server = require(
    path.join(root, 'src/server/application/max-setup-server.cjs'),
  ).createMaxSetupServer({
    store: {
      exists: () => saved,
      save: async () => {
        saved = true;
      },
      load: async () => {
        throw Error('Unexpected protected-config read');
      },
    },
    fetchImpl: async () => {
      calls++;
      throw Error('Unexpected provider request');
    },
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const csrf = (await page.text()).match(/name="cartoteca-setup" content="([^"]+)"/)[1];
    for (const name of ['/setup.js', '/setup.css']) {
      const response = await fetch(origin + name);
      assert.equal(response.status, 200);
      assert.ok((await response.text()).length);
    }
    const headers = {
      'content-type': 'application/json',
      cookie,
      origin,
      'x-cartoteca-setup': csrf,
    };
    assert.equal(
      (await fetch(origin + '/state', { method: 'POST', headers, body: '{}' })).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + '/save', {
          method: 'POST',
          headers,
          body: JSON.stringify({ token: 'synthetic-image-setup-no-real-token' }),
        })
      ).status,
      200,
    );
    assert.equal(saved, true);
    assert.equal(calls, 0);
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

async function main() {
  const root = process.cwd();
  const { files: publicFiles, publicAssetRoot, setupSources, setupAssetRoot } = require(
    path.join(root, 'src/shared/web-assets.cjs'),
  );
  const publicRoot = publicAssetRoot(root);
  assert.equal(publicRoot, path.join(root, 'dist/public'));
  for (const name of publicFiles) {
    assert.equal(fs.lstatSync(path.join(publicRoot, name)).isFile(), true);
    assert.equal(fs.existsSync(path.join(root, name)), false, 'Root web duplicate: ' + name);
  }
  for (const name of ['src/client', 'tests', 'docs', '.git', '.release', 'work'])
    assert.equal(fs.existsSync(path.join(root, name)), false, 'Development input: ' + name);
  for (const name of Object.keys(setupSources))
    assert.equal(fs.lstatSync(path.join(setupAssetRoot(root), name)).isFile(), true);
  const { X509Certificate } = require('node:crypto');
  assert.equal(process.env.NODE_EXTRA_CA_CERTS, '/app/trust/max-root.pem');
  const certificate = new X509Certificate(fs.readFileSync(path.join(root, 'trust/max-root.pem')));
  assert.equal(certificate.ca, true);
  assert.equal(
    certificate.fingerprint256.replaceAll(':', ''),
    'D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31',
  );
  assert.ok(Date.parse(certificate.validFrom) <= Date.now());
  assert.ok(Date.parse(certificate.validTo) > Date.now());
  const sharp = require(path.join(root, 'node_modules/sharp'));
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  assert.ok(
    require(path.join(root, 'image-processing.cjs')).normalizeImage(bytes, 'image/png').length,
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-image-check-'));
  const { createMultiServer } = require(path.join(root, 'multi-server.cjs'));
  let server;
  try {
    server = createMultiServer({
      dataDir: directory,
      production: false,
      origin: '',
      telegramBot: null,
      supportBot: null,
      sendMail: null,
      telegramAutostart: false,
      supportAutostart: false,
      adminEmailAutostart: false,
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/api/auth/session')).status, 200);
    assert.equal((await fetch(base + '/api/cabinet')).status, 401);
    assert.equal((await fetch(base + '/.env')).status, 404);
    assert.equal((await fetch(base + '/login.html')).status, 200);
    assert.equal((await fetch(base + '/style.css')).status, 200);
    assert.equal((await fetch(base + '/icons/icon-192.png')).status, 200);
    assert.equal((await fetch(base + '/app.js')).status, 401);
    assert.equal((await fetch(base + '/dist/public/app.js')).status, 404);
    assert.equal((await fetch(base + '/dist/setup/max-setup.html')).status, 404);
    assert.equal((await fetch(base + '/src/server/config.cjs')).status, 404);
    await checkSetup(root);
    console.log(
      'IMAGE_SMOKE=PASS; runtime-only layout, public MAX CA, native decoder, startup and anonymous boundaries; synthetic data only',
    );
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (
      path.dirname(directory) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('cartoteca-image-check-')
    )
      throw Error('Unsafe temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
