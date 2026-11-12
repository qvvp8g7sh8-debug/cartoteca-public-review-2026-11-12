const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, devices } = require('playwright');
const { createFixture } = require('../tests/browser/fixture.cjs');
const { runScenarios, checkLayout } = require('../tests/browser/scenarios.cjs');
const { groups } = require('./release/browser-matrix.cjs');
const { validateBrowserReport } = require('./release/browser-report.cjs');
const { createChecks, writeReports } = require('../tests/browser/checks.cjs');
const { observeNetwork } = require('../tests/browser/network-observer.cjs');

async function main() {
  const output = path.resolve(process.env.CARTOTECA_BROWSER_REPORT || 'work/browser-report');
  fs.mkdirSync(output, { recursive: true });
  const matrix = groups('main', process.env.CARTOTECA_BROWSER_WIDTHS);
  const engines = (process.env.CARTOTECA_BROWSER_ENGINES || 'chromium,webkit').split(',');
  const results = [];
  for (const engine of engines) {
    if (!['chromium', 'webkit'].includes(engine)) throw Error('Unknown browser engine');
    const browser = await { chromium, webkit }[engine].launch({
      headless: true,
      ...(engine === 'chromium' && process.env.CARTOTECA_CHROMIUM_CHANNEL
        ? { channel: process.env.CARTOTECA_CHROMIUM_CHANNEL }
        : {}),
    });
    console.log(`${engine}: ${browser.version()}`);
    try {
      for (const { width, layoutWidths } of matrix) {
        const fixture = await createFixture();
        let context;
        try {
          context = await browser.newContext({
            viewport: { width, height: 900 },
            // Windows fixed mobile layout disagrees with host DPI; responsive + touch instead.
            isMobile: width < 700 && !(engine === 'webkit' && process.platform === 'win32'),
            hasTouch: width < 700,
            ...(width < 700
              ? { userAgent: devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'].userAgent }
              : {}),
            locale: 'ru-RU',
            timezoneId: 'Asia/Yerevan',
            // Transport-only mocks must not be bypassed by WebKit service workers.
            // Worker caching/isolation is covered independently in pwa.test.cjs.
            serviceWorkers: 'block',
          });
          const page = await context.newPage(),
            errors = [],
            badResponses = [],
            external = [];
          await page.setContent(
            '<meta name="viewport" content="width=device-width,initial-scale=1">',
          );
          if (engine === 'webkit' && process.platform === 'win32') {
            const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
            await page.setViewportSize({
              width: Math.round((width * width) / actual.width),
              height: Math.round((900 * 900) / actual.height),
            });
          }
          const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          if (Math.abs(viewport.width - width) > 1 || Math.abs(viewport.height - 900) > 1)
            throw Error(
              `Browser environment has an incorrect CSS viewport: ${JSON.stringify(viewport)}`,
            );
          page.setDefaultTimeout(12000);
          const networkObserver = await observeNetwork(page, { base: fixture.base });
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('response', (response) => {
            if (response.status() >= 500) badResponses.push(response.url());
          });
          await context.route('**/*', (route) => {
            const url = route.request().url();
            if (url.startsWith(fixture.base + '/') || /^(data|blob):/.test(url))
              return route.continue();
            external.push(url);
            return route.abort('blockedbyclient');
          });
          const record = async (name, run, metadata) => {
            const result = { engine, name, ...metadata, passed: false };
            const started = Date.now();
            if (metadata.category === 'functional') networkObserver.setScenario(name);
            try {
              await run();
              result.passed = true;
              if (
                process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1' &&
                width === 390 &&
                [
                  'services-and-category',
                  'settings',
                  'public-privacy-and-consent',
                  'registration-consent-and-draft',
                ].includes(name)
              ) {
                const filename = `${engine}-${width}-${name}.png`;
                await page.screenshot({ path: path.join(output, filename), fullPage: true });
                result.screenshot = filename;
              }
            } catch (error) {
              result.error = error.message;
              if (process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1') {
                const filename = `${engine}-${metadata.category}-${metadata.width}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}-failure.png`;
                await page
                  .screenshot({ path: path.join(output, filename), fullPage: true })
                  .catch(() => {});
                result.screenshot = filename;
              }
              if (metadata.category === 'functional') {
                result.formError = await page
                  .locator('#form-error')
                  .textContent({ timeout: 500 })
                  .catch(() => null);
                if (await page.locator('#action-confirmation[open]').isVisible())
                  await page
                    .locator('#action-confirmation [data-confirm-cancel]')
                    .click({ timeout: 1000 })
                    .catch(() => {});
                await page
                  .locator('#close-editor')
                  .click({ timeout: 1000 })
                  .catch(() => {});
                if (
                  (await page
                    .locator('#action-confirmation-title')
                    .textContent({ timeout: 500 })
                    .catch(() => '')) === 'Есть несохранённые изменения' &&
                  (await page.locator('#action-confirmation[open]').isVisible())
                )
                  await page
                    .locator('#action-confirmation [data-confirm-accept]')
                    .click({ timeout: 1000 })
                    .catch(() => {});
                await page
                  .locator('[data-close-telegram-share]')
                  .click({ timeout: 1000 })
                  .catch(() => {});
              }
            }
            if (metadata.category === 'functional')
              result.appearanceDurationMs = metadata.appearanceDurationMs;
            result.wallDurationMs = Date.now() - started;
            result.durationMs = Math.max(
              0,
              result.wallDurationMs - (metadata.appearanceDurationMs || 0),
            );
            results.push(result);
            console.log(
              `${engine} ${result.category} ${result.width} ${name}: ${result.passed ? 'PASS' : 'FAIL ' + result.error.split('\n')[0]}`,
            );
            writeReports(output, results);
            if (metadata.category === 'functional') networkObserver.setScenario(null);
          };
          const check = createChecks({ page, width, layoutWidths, record, layout: checkLayout });
          await runScenarios(page, fixture, check);
          results.push({
            engine,
            width,
            category: 'functional',
            flowWidth: width,
            name: 'browser-errors-and-network',
            passed: !errors.length && !badResponses.length && !external.length,
            errors,
            badResponses,
            external,
            diagnostics: networkObserver.events,
          });
        } finally {
          await context?.close();
          await fixture.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  writeReports(output, results);
  const failures = results.filter((r) => !r.passed);
  if (!failures.length)
    for (const engine of engines)
      for (const { width, layoutWidths } of matrix)
        validateBrowserReport(
          results.filter((row) => row.engine === engine && row.flowWidth === width),
          { suite: 'main', engine, functionalWidth: width, layoutWidths },
        );
  if (failures.length) console.log('Browser failures: ' + JSON.stringify(failures, null, 2));
  console.log(
    `Completed: ${results.length - failures.length}/${results.length}; report: ${output}`,
  );
  if (failures.length) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
