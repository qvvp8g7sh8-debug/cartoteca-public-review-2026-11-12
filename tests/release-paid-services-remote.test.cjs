const test = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test(
  'Paid services executor uses synthetic preserved-data transitions and durable admission',
  { skip: process.platform !== 'linux' },
  () => {
    execFileSync(
      'python3',
      ['-I', '-B', path.join(__dirname, 'helpers/release-paid-services-remote.py')],
      {
        encoding: 'utf8',
        timeout: 30000,
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
  },
);

test(
  'schema19 image probe runs with production ENV and synthetic origin while payments default OFF',
  { timeout: 30000 },
  () => {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const crypto = require('node:crypto');
    const { configuration } = require('../src/server/config.cjs');
    const environment = {
      ...process.env,
      NODE_ENV: 'production',
      APP_ORIGIN: '',
      CARTOTECA_PAYMENT_NETWORK_ENABLED: '0',
    };
    // The real production startup guard stays strict; only this probe is synthetic.
    assert.throws(() => configuration({}, environment), /Production requires HTTPS APP_ORIGIN/);
    const root = path.resolve(__dirname, '..');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-native-image-probe-'));
    try {
      const input = path.join(temporary, 'probe-input.json');
      const script = path.join(temporary, 'probe.cjs');
      fs.writeFileSync(
        input,
        JSON.stringify({
          schema: 19,
          runtime: {
            'package.json': crypto
              .createHash('sha256')
              .update(fs.readFileSync(path.join(root, 'package.json')))
              .digest('hex'),
          },
        }),
        { flag: 'wx', mode: 0o600 },
      );
      // Execute the actual production probe unchanged apart from its fixed container
      // paths. All writes remain inside this new synthetic temporary directory.
      let source = fs.readFileSync(path.join(root, 'scripts/release/remote/probe.cjs'), 'utf8');
      function replaceOnce(before, after) {
        assert.equal(source.split(before).length, 2, 'Expected one fixed image-probe path');
        source = source.replace(before, after);
      }
      replaceOnce("'/tmp/probe-input.json'", JSON.stringify(input));
      replaceOnce(
        "fs.mkdtempSync('/tmp/cartoteca-release-probe-')",
        'fs.mkdtempSync(' + JSON.stringify(path.join(temporary, 'cartoteca-release-probe-')) + ')',
      );
      replaceOnce(
        "assert.equal(path.dirname(directory), '/tmp')",
        'assert.equal(path.dirname(directory), ' + JSON.stringify(temporary) + ')',
      );
      // Resolve only the image's code root; no test copies or data directories are reused.
      source = source.replaceAll("'/app/", "'" + root.replaceAll('\\', '/') + '/');
      source = source.replaceAll("'/app'", JSON.stringify(root));
      fs.writeFileSync(script, source, { flag: 'wx', mode: 0o600 });
      const result = JSON.parse(
        execFileSync(process.execPath, [script], {
          encoding: 'utf8',
          timeout: 25000,
          cwd: root,
          env: environment,
        }),
      );
      assert.equal(result.schema, 19);
      assert.equal(result.paymentNetworkEnabled, false);
      assert.equal(typeof result.build, 'string');
      assert.ok(Object.keys(result.publicAssets).length > 0);
      assert.deepEqual(fs.readdirSync(temporary).sort(), ['probe-input.json', 'probe.cjs']);
      assert.throws(() => configuration({}, environment), /Production requires HTTPS APP_ORIGIN/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
);
