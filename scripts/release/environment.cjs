const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { hash } = require('./files.cjs');

async function environment(root, target, engines) {
  if (
    (target === 'windows' && process.platform !== 'win32') ||
    (target === 'linux' && process.platform !== 'linux')
  )
    throw Error(
      'This target must run on its own OS; use the manual GitHub Actions workflow for Linux',
    );
  const value = {
    node: process.version,
    os: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    availableCPUs: os.availableParallelism(),
    lockHash: hash(fs.readFileSync(path.join(root, 'package-lock.json'))),
    browsers: {},
  };
  const { chromium, webkit } = require(path.join(root, 'node_modules/playwright'));
  for (const name of engines || (target === 'linux' ? ['chromium', 'webkit'] : ['chromium'])) {
    const engine = { chromium, webkit }[name];
    const browser = await engine.launch({
      headless: true,
      ...(target === 'windows' ? { channel: 'msedge' } : {}),
    });
    try {
      value.browsers[name] = browser.version();
    } finally {
      await browser.close();
    }
  }
  // Caddy cannot silently skip on Linux. No production configuration is loaded.
  if (target === 'linux') {
    const binary = process.env.CADDY_BIN || '/usr/bin/caddy';
    value.caddy = execFileSync(binary, ['version'], { encoding: 'utf8', timeout: 10000 }).trim();
    value.caddyHash = hash(fs.readFileSync(binary));
  }
  return value;
}
module.exports = { environment };
