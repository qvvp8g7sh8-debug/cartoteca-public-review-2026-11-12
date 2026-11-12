const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { chromium, webkit, devices } = require('playwright');
const { createFixture, createBrowserSeed } = require('../tests/browser/fixture.cjs');
const { login, cases, caseNames } = require('../tests/browser/time-picker-smoke.cjs');

async function main() {
  const output = path.resolve(
    process.env.CARTOTECA_BROWSER_REPORT || 'work/release-time-picker-smoke',
  );
  const engines = (process.env.CARTOTECA_BROWSER_ENGINES || 'chromium,webkit')
    .split(',')
    .map((value) => value.trim());
  const widths = (process.env.CARTOTECA_BROWSER_WIDTHS || '390,1440').split(',').map(Number);
  if (
    !engines.length ||
    new Set(engines).size !== engines.length ||
    engines.some((engine) => !['chromium', 'webkit'].includes(engine))
  )
    throw Error('Invalid/duplicate time-picker smoke engines');
  if (
    new Set(widths).size !== widths.length ||
    widths.length !== 2 ||
    !widths.includes(390) ||
    !widths.includes(1440)
  )
    throw Error('Time-picker early smoke requires exactly 390 and 1440 CSS pixels');
  fs.mkdirSync(output, { recursive: true });
  const expectedCases = engines.length * widths.length * caseNames.length;
  const results = [];
  const seed = createBrowserSeed();
  const started = performance.now();
  const resourceFailures = [];
  let cleanupComplete = false;
  const write = () =>
    fs.writeFileSync(
      path.join(output, 'results.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: 'time-picker-early-smoke',
          partial: true,
          fullRequired: true,
          readiness: false,
          complete: cleanupComplete && !resourceFailures.length && results.length === expectedCases,
          engines,
          widths,
          caseNames,
          expectedCases,
          failures: results.filter((result) => !result.passed).length,
          resourceFailures,
          timing: {
            totalMs: Math.round(performance.now() - started),
            seedPreparationMs: seed.preparationDurationMs,
          },
          results,
        },
        null,
        2,
      ),
    );
  write();
  try {
    for (const engine of engines) {
      let browser, launchError;
      try {
        browser = await { chromium, webkit }[engine].launch({
          headless: true,
          ...(engine === 'chromium' && process.env.CARTOTECA_CHROMIUM_CHANNEL
            ? { channel: process.env.CARTOTECA_CHROMIUM_CHANNEL }
            : {}),
        });
        console.log(`${engine}: ${browser.version()}`);
      } catch (error) {
        launchError = error;
      }
      try {
        for (const width of widths)
          for (const name of caseNames) {
            const result = { engine, width, name, passed: false };
            const started = Date.now();
            const timing = {};
            const measure = async (stage, action) => {
              const stageStarted = performance.now();
              try {
                return await action();
              } finally {
                timing[stage] = Math.round(performance.now() - stageStarted);
              }
            };
            let fixture, context;
            try {
              if (launchError) throw launchError;
              fixture = await measure('fixtureMs', () => createFixture({ seed }));
              context = await measure('contextMs', () =>
                browser.newContext({
                  viewport: { width, height: 900 },
                  isMobile: width < 700 && !(engine === 'webkit' && process.platform === 'win32'),
                  hasTouch: width < 700,
                  ...(width < 700
                    ? {
                        userAgent: devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'].userAgent,
                      }
                    : {}),
                  locale: 'ru-RU',
                  timezoneId: 'Asia/Yerevan',
                  serviceWorkers: 'block',
                }),
              );
              const page = await context.newPage(),
                errors = [],
                badResponses = [],
                external = [];
              page.setDefaultTimeout(8000);
              page.setDefaultNavigationTimeout(12000);
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
              await measure('loginMs', () => login(page, fixture));
              assert.equal(await page.evaluate(() => innerWidth), width, 'Incorrect CSS viewport');
              await measure('scenarioMs', () => cases[name](page, fixture));
              assert.deepEqual(errors, [], 'Browser runtime errors');
              assert.deepEqual(badResponses, [], 'Server failed a request');
              assert.deepEqual(external, [], 'Synthetic smoke attempted an external request');
              result.passed = true;
            } catch (error) {
              result.error = error.message;
            } finally {
              // Every case gets its own data, session and page; failed flows cannot poison the rest.
              const cleanup = await measure('cleanupMs', () =>
                Promise.allSettled([context?.close(), fixture?.close()]),
              );
              const rejected = cleanup.filter((item) => item.status === 'rejected');
              if (rejected.length) {
                result.passed = false;
                result.error = [result.error, ...rejected.map((item) => item.reason.message)]
                  .filter(Boolean)
                  .join('; ');
              }
            }
            result.durationMs = Date.now() - started;
            result.timing = timing;
            results.push(result);
            write();
            console.log(
              `${engine} ${width} ${name}: ${result.passed ? 'PASS' : 'FAIL ' + result.error.split('\n')[0]}`,
            );
          }
      } finally {
        try {
          await browser?.close();
        } catch (error) {
          resourceFailures.push(engine + ': ' + error.message);
        }
      }
    }
  } finally {
    try {
      await seed.close();
    } catch (error) {
      resourceFailures.push('seed: ' + error.message);
    }
    cleanupComplete = true;
    write();
  }
  write();
  const failures = results.filter((result) => !result.passed);
  console.log(
    `Early smoke: ${results.length - failures.length}/${expectedCases}; partial report: ${output}`,
  );
  if (resourceFailures.length)
    console.error('Resource cleanup failed: ' + resourceFailures.join('; '));
  if (failures.length || resourceFailures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
