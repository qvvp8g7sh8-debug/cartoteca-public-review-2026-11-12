const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
const { createFixture } = require('../tests/browser/fixture.cjs');
const { runScenarios } = require('../tests/browser/scenarios.cjs');

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel:
      process.env.CARTOTECA_CHROMIUM_CHANNEL ||
      (process.platform === 'win32' ? 'msedge' : undefined),
  });
  let passed = 0;
  try {
    for (const width of [320, 390, 412, 768, 1440]) {
      const fixture = await createFixture();
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale: 'ru-RU',
        timezoneId: 'Asia/Yerevan',
        isMobile: width < 700,
        hasTouch: width < 700,
        ...(width < 700 ? { userAgent: devices['Pixel 7'].userAgent } : {}),
        serviceWorkers: 'block',
      });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await context.route('**/*', (route) => {
          const url = route.request().url();
          return url.startsWith(fixture.base + '/') || /^(data|blob):/.test(url)
            ? route.continue()
            : route.abort('blockedbyclient');
        });
        await runScenarios(page, fixture, async (name, run) => {
          if (!['login', 'settings'].includes(name)) return;
          await run();
          passed++;
          console.log(`settings ${width} ${name}: PASS`);
        });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert.equal(passed, 10);
  console.log(`Settings browser checks: ${passed}/${passed}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
