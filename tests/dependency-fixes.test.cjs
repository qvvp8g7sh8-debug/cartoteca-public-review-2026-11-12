const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const { normalizeImage, normalizeImageAsync } = require('../image-processing.cjs');
const { configuredMailer } = require('../src/server/modules/notifications/email-adapter.cjs');
const root = path.resolve(__dirname, '..');

test('fixed dependency versions are installed and locked; deployment selects the updated proxy', () => {
  const manifest = require('../package.json');
  const lock = require('../package-lock.json');
  for (const [name, version] of [
    ['sharp', '0.35.5'],
    ['nodemailer', '10.2.1'],
  ]) {
    assert.equal(manifest.dependencies[name], version);
    assert.equal(lock.packages[''].dependencies[name], version);
    assert.equal(lock.packages['node_modules/' + name].version, version);
    const installed = JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
    assert.equal(installed.version, version);
  }
  assert.match(
    fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8'),
    /image: cartoteca-caddy:2\.11\.7\b/,
  );
  const proxyBuild = fs.readFileSync(path.join(root, 'Dockerfile.caddy'), 'utf8');
  assert.match(proxyBuild, /releases\/download\/v2\.11\.7\/caddy_2\.11\.7_linux_amd64/);
  assert.match(proxyBuild, /727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b/);
  assert.match(proxyBuild, /sha256sum -c/);
});

test('photo worker keeps JPEG PNG and WebP usable through synchronous and asynchronous paths', async () => {
  for (const format of ['jpeg', 'png', 'webp']) {
    const input = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#abc' } })
      .toFormat(format)
      .toBuffer();
    for (const output of [
      normalizeImage(input, 'image/' + format),
      await normalizeImageAsync(input, 'image/' + format),
    ]) {
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.format, format);
      assert.equal(metadata.width, 8);
      assert.equal(metadata.height, 6);
      await sharp(output).raw().toBuffer();
    }
    const wrong = format === 'png' ? 'jpeg' : 'png';
    await assert.rejects(normalizeImageAsync(input, 'image/' + wrong));
  }
});

test('unsupported loaders are blocked before metadata, including SVG disguised as PNG', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
  );
  const tiff = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } })
    .tiff()
    .toBuffer();
  const policy = path.join(root, 'src/server/infrastructure/photos/decoder-policy.cjs');
  for (const input of [svg, tiff]) {
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const sharp=require('sharp');require(${JSON.stringify(policy)}).configurePhotoDecoder(sharp);
      sharp(Buffer.from(${JSON.stringify(input.toString('base64'))},'base64')).metadata()
        .then(()=>process.exitCode=2).catch(error=>{
          if(!/blocked|unsupported image format/i.test(error.message))process.exitCode=3;
        });
    `,
      ],
      { cwd: root, timeout: 10000, windowsHide: true, encoding: 'utf8' },
    );
    assert.equal(
      probe.status,
      0,
      'libvips must reject the loader, not just reject the format afterwards',
    );
    assert.throws(() => normalizeImage(input, 'image/png'));
    await assert.rejects(normalizeImageAsync(input, 'image/png'));
  }
});

test('mail adapter retains TLS and file/URL restrictions; fixed SMTP transport delivers to a local sink', async (t) => {
  const messages = [],
    sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = '',
      inData = false;
    socket.write('220 localhost synthetic SMTP\r\n');
    socket.on('data', (chunk) => {
      pending += chunk.toString();
      for (;;) {
        if (inData) {
          const end = pending.indexOf('\r\n.\r\n');
          if (end < 0) break;
          messages.push(pending.slice(0, end));
          pending = pending.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const end = pending.indexOf('\r\n');
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (/^EHLO /i.test(line))
          socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1048576\r\n');
        else if (/^DATA$/i.test(line)) {
          inData = true;
          socket.write('354 continue\r\n');
        } else if (/^QUIT$/i.test(line)) {
          socket.end('221 bye\r\n');
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const env = {
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '465',
    SMTP_USER: 'synthetic',
    SMTP_PASSWORD: 'synthetic',
    SMTP_FROM: 'sender@example.test',
  };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const create = nodemailer.createTransport;
  let config;
  try {
    Object.assign(process.env, env);
    nodemailer.createTransport = (options) => {
      config = options;
      // Only the synthetic sink is unencrypted; production options are asserted below.
      return create({
        host: '127.0.0.1',
        port: server.address().port,
        secure: false,
        ignoreTLS: true,
        connectionTimeout: 3000,
        socketTimeout: 3000,
      });
    };
    const send = configuredMailer();
    assert.equal(config.secure, true);
    assert.equal(config.requireTLS, true);
    assert.equal(config.disableFileAccess, true);
    assert.equal(config.disableUrlAccess, true);
    for (const kind of ['reset', 'invitation']) {
      const result = await send(
        'recipient@example.test',
        'https://example.test/login.html#synthetic',
        { kind, organizationName: '<Test organization>', roleName: 'Администратор' },
      );
      assert.deepEqual(result.accepted, ['recipient@example.test']);
    }
    assert.equal(messages.length, 2);
    for (const message of messages) assert.match(message, /To: recipient@example\.test/);
  } finally {
    nodemailer.createTransport = create;
    for (const [key, value] of Object.entries(oldEnv))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});
