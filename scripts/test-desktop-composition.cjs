const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
const { createFixture } = require('../tests/browser/fixture.cjs');
const { runDesktopComposition } = require('../tests/browser/desktop-composition.cjs');

const output = path.resolve(
  __dirname,
  '../work/web-design-implementation-2026-10-13/composition.json',
);
const cases = [
  { width: 981, height: 768 },
  { width: 1101, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 1280, height: 500 },
];
const report = {
  startedAt: new Date().toISOString(),
  browser: 'chromium',
  channel:
    process.env.CARTOTECA_CHROMIUM_CHANNEL || (process.platform === 'win32' ? 'msedge' : null),
  screenshots: false,
  syntheticOnly: true,
  results: [],
};
function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.passed = report.results.filter((entry) => entry.passed).length;
  report.failed = report.results.length - report.passed;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(report.channel ? { channel: report.channel } : {}),
    ...(process.env.CARTOTECA_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CARTOTECA_CHROMIUM_EXECUTABLE }
      : {}),
  });
  report.version = browser.version();
  try {
    for (const viewport of cases) {
      const fixture = await createFixture();
      let context;
      try {
        context = await browser.newContext({
          viewport,
          locale: 'ru-RU',
          timezoneId: 'Europe/Moscow',
          serviceWorkers: 'block',
          isMobile: viewport.width < 700,
          hasTouch: viewport.width < 700,
          ...(viewport.width < 700 ? { userAgent: devices['Pixel 7'].userAgent } : {}),
        });
        const page = await context.newPage(),
          errors = [],
          external = [];
        page.setDefaultTimeout(10000);
        page.on('pageerror', (error) => errors.push(error.message));
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith(fixture.base + '/') || /^(data|blob):/.test(url))
            return route.continue();
          external.push(new URL(url).origin);
          return route.abort('blockedbyclient');
        });
        const check = async (name, run, options = {}) => {
          const result = { name, ...viewport, passed: false },
            start = Date.now();
          try {
            result.measurements = await run();
            result.passed = true;
          } catch (error) {
            result.error = error.message;
            if (options.fatal) throw error;
          } finally {
            result.durationMs = Date.now() - start;
            report.results.push(result);
            console.log(
              `${viewport.width}x${viewport.height} ${name}: ${result.passed ? 'PASS' : 'FAIL'}`,
            );
            writeReport();
          }
        };
        await runDesktopComposition(page, fixture, viewport, check);
        await check('no-page-errors', async () => {
          assert.deepEqual(errors, []);
          return { errors, blockedExternalOrigins: [...new Set(external)] };
        });
      } catch (error) {
        report.results.push({
          name: 'viewport-setup-or-fatal',
          ...viewport,
          passed: false,
          error: error.message,
        });
      } finally {
        await context?.close();
        await fixture.close();
        writeReport();
      }
    }
  } finally {
    await browser.close();
  }
  if (report.failed) process.exitCode = 1;
  console.log(`Composition: ${report.passed} passed, ${report.failed} failed. ${output}`);
}
main().catch((error) => {
  report.results.push({ name: 'runner', passed: false, error: error.message });
  writeReport();
  console.error(error.message);
  process.exitCode = 1;
});
