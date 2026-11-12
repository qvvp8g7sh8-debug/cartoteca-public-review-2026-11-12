const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, webkit, devices } = require('playwright');
const { adminFixture } = require('../tests/helpers/admin-fixture.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { groups } = require('./release/browser-matrix.cjs');
const { validateBrowserReport } = require('./release/browser-report.cjs');
const { createChecks, writeReports } = require('../tests/browser/checks.cjs');
const { adminLayout } = require('../tests/browser/appearance.cjs');
const { authContextHeaders } = require('../tests/helpers/account-context.cjs');

async function main() {
  const output = path.resolve(process.env.CARTOTECA_BROWSER_REPORT || 'work/admin-browser-report'),
    results = [];
  const matrix = groups('admin', process.env.CARTOTECA_BROWSER_WIDTHS);
  fs.mkdirSync(output, { recursive: true });
  const engines = (process.env.CARTOTECA_BROWSER_ENGINES || 'chromium,webkit').split(',');
  for (const engine of engines) {
    if (!['chromium', 'webkit'].includes(engine)) throw Error('Unknown browser engine');
    const browser = await { chromium, webkit }[engine].launch({
      headless: true,
      ...(engine === 'chromium' && process.env.CARTOTECA_CHROMIUM_CHANNEL
        ? { channel: process.env.CARTOTECA_CHROMIUM_CHANNEL }
        : {}),
    });
    try {
      for (const { width, layoutWidths } of matrix) {
        const f = await adminFixture(null, { extraAccounts: 24 }),
          emails = [],
          errors = [];
        const backupStatusFile = path.join(f.directory, 'synthetic-status', 'status.json');
        const { atomicJson } = require('../src/server/infrastructure/backup/durable.cjs');
        atomicJson(backupStatusFile, {
          format: 1,
          observedAt: Date.now(),
          cadenceHours: 24,
          state: 'failed',
          remoteConfigured: true,
          lastLocalAt: Date.now(),
          error: 'BACKUP_REMOTE_RETENTION',
          recent: [{ state: 'failed', startedAt: Date.now() }],
        });
        const server = createMultiServer({
          dataDir: f.directory,
          backupStatusFile,
          sendMail: async (email, link, metadata) => emails.push({ email, link, metadata }),
          telegramBot: null,
          supportDelivery: { telegram: null, email: null },
          telegramAutostart: false,
          supportAutostart: false,
          adminEmailAutostart: false,
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        f.cleanup(async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        });
        const base = 'http://127.0.0.1:' + server.address().port;
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          locale: 'ru-RU',
          timezoneId: 'Asia/Yerevan',
          hasTouch: width < 700,
          isMobile: width < 700 && !(engine === 'webkit' && process.platform === 'win32'),
          ...(width < 700
            ? { userAgent: devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'].userAgent }
            : {}),
        });
        try {
          await context.route('**/*', (route) =>
            route
              .request()
              .url()
              .startsWith(base + '/')
              ? route.continue()
              : route.abort(),
          );
          const loginResponse = await context.request.post(base + '/api/auth/login', {
            data: { email: 'root@admin.test', password: f.password },
            headers: { Origin: base, 'X-Cartoteca-Request': '1' },
          });
          assert.equal(loginResponse.status(), 200);
          const expectedContext = authContextHeaders(await loginResponse.json());
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('dialog', (dialog) => dialog.accept());
          page.on('response', (response) => {
            if (response.status() >= 500) errors.push('HTTP ' + response.status());
          });
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
          const record = async (name, run, metadata) => {
            const result = { engine, name, ...metadata, passed: false };
            const started = Date.now();
            try {
              await run();
              result.passed = true;
            } catch (error) {
              result.error = error.message;
              if (process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1')
                await page
                  .screenshot({
                    path: path.join(
                      output,
                      `${engine}-${metadata.category}-${metadata.width}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}-failure.png`,
                    ),
                    fullPage: true,
                  })
                  .catch(() => {});
            }
            if (metadata.category === 'functional')
              result.appearanceDurationMs = metadata.appearanceDurationMs;
            result.wallDurationMs = Date.now() - started;
            result.durationMs = Math.max(
              0,
              result.wallDurationMs - (metadata.appearanceDurationMs || 0),
            );
            results.push(result);
            writeReports(output, results);
            console.log(
              `${engine} ${result.category} ${result.width} ${name}: ${result.passed ? 'PASS' : 'FAIL ' + result.error.split('\n')[0]}`,
            );
          };
          const check = createChecks({ page, width, layoutWidths, record, layout: adminLayout });
          const layout = () => check.layout(page);
          await check('overview', async () => {
            await page.goto(base + '/admin.html');
            await page.locator('#admin-dashboard').waitFor({ state: 'visible' });
            await layout();
          });
          await check('organizations-and-controls', async () => {
            await page.locator('[data-admin-view="organizations"]').click();
            const record = page.locator(`[data-id="${f.owner.organizationId}"]`);
            await record.locator('summary').click();
            await record.locator('[name="city"]').waitFor({ state: 'visible' });
            await layout();
            await record.locator('[data-admin-command="profile"] [name="city"]').fill('Тула');
            await record.locator('[data-admin-command="profile"] button').click();
            await page
              .locator('#admin-message')
              .filter({ hasText: 'Изменения сохранены.' })
              .waitFor();
            await layout();
            if (process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1' && [390, 1440].includes(width))
              await page.screenshot({
                path: path.join(output, `${engine}-${width}-organization.png`),
                fullPage: true,
              });
          });
          await check('accounts-paging', async () => {
            await page.locator('[data-admin-view="accounts"]').click();
            await page
              .locator('#admin-account-result-count')
              .filter({ hasText: 'Показано 20 из 27' })
              .waitFor();
            await page.locator('#admin-account-more').click();
            await page
              .locator('#admin-account-result-count')
              .filter({ hasText: 'Показано 27 из 27' })
              .waitFor();
            const record = page.locator(`[data-id="${f.owner.accountId}"]`);
            await record.locator('summary').click();
            await record
              .locator('[data-admin-command="emailRecovery"]')
              .waitFor({ state: 'visible' });
            await layout();
          });
          const receipt = f.store.support.create(
            { accountId: f.owner.accountId, organizationId: f.owner.organizationId },
            {
              requestId: f.database.id(),
              description: 'Проверка формы поддержки и длинного сообщения <без HTML>',
            },
          );
          await check('support-note-and-state', async () => {
            await page.locator('[data-admin-view="support"]').click();
            const record = page.locator(`[data-id="${receipt.id}"]`);
            await record.locator('summary').click();
            await record.locator('[name="text"]').fill('Тестовая внутренняя заметка');
            await record.locator('[data-admin-command="caseMessage"] button').click();
            await record.locator('.admin-thread-item').waitFor({ state: 'visible' });
            await layout();
            await record.locator('[name="state"]').selectOption('waiting');
            await record.locator('[data-admin-command="caseState"] button').click();
            await record.locator('summary').filter({ hasText: 'Ожидает ответа' }).waitFor();
            await layout();
          });
          await check('history', async () => {
            await page.locator('[data-admin-view="audit"]').click();
            await page.locator('#admin-audit details').first().waitFor();
            await page.locator('#admin-audit details summary').first().click();
            await layout();
          });
          await check('service-state', async () => {
            await page.locator('[data-admin-view="system"]').click();
            await page.locator('#admin-system').filter({ hasText: 'Процесс сервера' }).waitFor();
            await page
              .locator('.admin-backups')
              .filter({ hasText: 'Не подтверждена защита' })
              .waitFor();
            await page.locator('.admin-backups summary').click();
            await layout();
            if (process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1' && [390, 1440].includes(width))
              await page.screenshot({
                path: path.join(output, `${engine}-${width}-backups.png`),
                fullPage: true,
              });
          });
          await check('explicit-email-confirmation', async () => {
            const body = f.command('account', f.owner.accountId, {
              email: 'new@admin.test',
              password: f.password,
              identityConfirmed: true,
            });
            const response = await context.request.post(base + '/api/admin/accounts/email', {
              data: body,
              headers: { Origin: base, 'X-Cartoteca-Request': '1', ...expectedContext },
            });
            assert.equal(response.status(), 202);
            await server.adminEmailRuntime.tick();
            await page.goto(emails[0].link);
            await page.locator('#email-change-form').waitFor({ state: 'visible' });
            assert.equal(
              f.store.admin.account(f.admin.accountId, f.owner.accountId).email,
              'owner@admin.test',
            );
            await layout();
            await page.locator('#email-change-form button').click();
            await page
              .locator('#extra-message')
              .filter({ hasText: 'Новая почта подтверждена' })
              .waitFor();
            assert.equal(
              f.store.admin.account(f.admin.accountId, f.owner.accountId).email,
              'new@admin.test',
            );
            await layout();
          });
          await check('runtime-errors', async () => assert.deepEqual(errors, []));
        } finally {
          await context.close();
          await f.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  writeReports(output, results);
  const failed = results.filter((x) => !x.passed);
  if (!failed.length)
    for (const engine of engines)
      for (const { width, layoutWidths } of matrix)
        validateBrowserReport(
          results.filter((row) => row.engine === engine && row.flowWidth === width),
          { suite: 'admin', engine, functionalWidth: width, layoutWidths },
        );
  console.log(`Administrator browser checks: ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
