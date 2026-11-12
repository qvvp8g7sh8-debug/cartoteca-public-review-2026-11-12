const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createBillingBrowserFixture } = require('../tests/helpers/billing-browser-fixture.cjs');
const { authContextHeaders } = require('../tests/helpers/account-context.cjs');
const { checkLayout, inlineForm } = require('../tests/browser/appearance.cjs');

// All fixtures, identities and payment responses are synthetic. Every browser
// context blocks service workers and every URL outside its local test server.
// The production hosted redirect is deliberately NOT exercised by this runner.
async function main() {
  const output = path.resolve(
    process.env.CARTOTECA_BILLING_BROWSER_REPORT ||
      'work/paid-services-completion-20261019/browser-01',
  );
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const f = await createBillingBrowserFixture(),
        contexts = [],
        errors = [],
        blocked = [];
      let admin, owner, other, packageId, checkoutId;
      async function session(email) {
        const context = await browser.newContext({
          viewport,
          locale: 'ru-RU',
          timezoneId: 'Asia/Yerevan',
          serviceWorkers: 'block',
          isMobile: viewport.width < 700,
          hasTouch: viewport.width < 700,
        });
        contexts.push(context);
        await context.route('**/*', (route) => {
          if (new URL(route.request().url()).origin === f.base) return route.continue();
          blocked.push(route.request().url());
          return route.abort('blockedbyclient');
        });
        const response = await context.request.post(f.base + '/api/auth/login', {
          headers: { Origin: f.base, 'X-Cartoteca-Request': '1' },
          data: { email, password: f.password },
        });
        assert.equal(response.status(), 200);
        const headers = {
          Origin: f.base,
          'X-Cartoteca-Request': '1',
          ...authContextHeaders(await response.json()),
        };
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        page.on('pageerror', (error) => errors.push(error.message));
        const dialogs = [];
        const actor = {
          context,
          page,
          headers,
          denyNext: false,
          dialogs,
          billingReads: 0,
          async get(url) {
            return context.request.get(f.base + url, { headers });
          },
          async post(url, data) {
            return context.request.post(f.base + url, { headers, data });
          },
        };
        page.on('dialog', async (dialog) => {
          dialogs.push(dialog.message());
          if (actor.denyNext) {
            actor.denyNext = false;
            await dialog.dismiss();
          } else await dialog.accept();
        });
        page.on('request', (request) => {
          if (request.url() === f.base + '/api/billing') actor.billingReads++;
        });
        return actor;
      }
      async function record(name, run) {
        const result = { name, width: viewport.width, height: viewport.height, passed: false };
        try {
          await run();
          result.passed = true;
        } catch (error) {
          result.error = error.stack;
          const page = other?.page || owner?.page || admin?.page;
          await page
            ?.screenshot({ path: path.join(output, viewport.width + '-' + name + '-failure.png') })
            .catch(() => {});
        }
        results.push(result);
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results }, null, 2));
        console.log(
          viewport.width +
            ' ' +
            name +
            ': ' +
            (result.passed ? 'PASS' : 'FAIL ' + result.error.split('\n')[0]),
        );
      }
      async function waitAdmin() {
        await admin.page.waitForFunction(() => {
          const node = document.querySelector('#admin-billing-content');
          return (
            node?.querySelector('[data-admin-package-form]') && !node.hasAttribute('aria-busy')
          );
        });
      }
      async function openPackages(actor, suffix = '') {
        await actor.page.goto(f.base + '/' + suffix);
        await actor.page.locator('[data-view="settings"]').click();
        await actor.page
          .locator('details.settings-tile:has(#paid-services-settings) > summary')
          .click();
        await actor.page.locator('#paid-services-settings .paid-package-current').waitFor();
        await actor.page.waitForFunction(
          () => !document.querySelector('#paid-services-settings')?.hasAttribute('aria-busy'),
        );
      }
      async function screenshot(actor, name) {
        const target = actor.page
          .locator('[data-admin-section="billing"]:visible, #paid-services-settings:visible')
          .first();
        await target.evaluate((node) => {
          for (let item = node; item; item = item.parentElement) item.scrollTop = 0;
        });
        await actor.page.screenshot({
          path: path.join(output, viewport.width + '-' + name + '.png'),
        });
      }
      try {
        await record('admin-empty-and-manual-package', async () => {
          admin = await session('root@billing.test');
          await admin.page.goto(f.base + '/admin.html');
          await admin.page.locator('#admin-dashboard').waitFor();
          await admin.page.locator('[data-admin-view="billing"]').click();
          await waitAdmin();
          assert.equal(await admin.page.locator('#admin-billing-content h3').count(), 0);
          assert.match(
            await admin.page.locator('#admin-billing-summary').innerText(),
            /не подключён/,
          );
          const form = admin.page.locator('[data-admin-package-form][data-package-id=""]');
          assert.equal(await form.locator('[name="priceRub"]').inputValue(), '');
          assert.equal(await form.locator('[name="taskLimit"]').inputValue(), '');
          await form.locator('[name="title"]').fill('Синтетический месячный пакет');
          await form.locator('[name="priceRub"]').fill('9.90');
          await form.locator('[name="taskLimit"]').fill('3');
          await form.locator('[name="enabled"]').check();
          await form.locator('[name="reason"]').fill('Только синтетическая проверка интерфейса');
          await inlineForm(admin.page, '[data-admin-package-form][data-package-id=""]');
          await form.locator('[type="submit"]').click();
          await admin.page.locator('[data-admin-package-form]:not([data-package-id=""])').waitFor();
          await waitAdmin();
          packageId = await admin.page
            .locator('[data-admin-package-form]:not([data-package-id=""])')
            .getAttribute('data-package-id');
          assert.equal(f.providerCalls.length, 0);
        });
        await record('admin-dirty-conflict-and-refresh', async () => {
          assert.ok(packageId);
          const form = admin.page.locator(
            '[data-admin-package-form][data-package-id="' + packageId + '"]',
          );
          await form.locator('[name="title"]').fill('Несохранённое название');
          admin.denyNext = true;
          await admin.page.locator('[data-admin-view="overview"]').click();
          assert.equal(
            await admin.page.locator('[data-admin-section="billing"]').isVisible(),
            true,
          );
          assert.equal(await form.locator('[name="title"]').inputValue(), 'Несохранённое название');
          const changed = await admin.post(
            '/api/admin/billing/package',
            f.command({
              id: packageId,
              expectedRevision: 1,
              title: 'Синтетический актуальный пакет',
              priceRub: '9.90',
              taskLimit: 3,
              enabled: true,
            }),
          );
          assert.equal(changed.status(), 200);
          await form.locator('[name="reason"]').fill('Проверка устаревшей версии');
          await form.locator('[type="submit"]').click();
          await admin.page.waitForFunction(() =>
            /Условия изменились/.test(
              document.querySelector('[data-admin-package-form] [data-admin-billing-message]')
                ?.textContent,
            ),
          );
          assert.equal(await form.locator('[name="title"]').inputValue(), 'Несохранённое название');
          await admin.page.locator('#admin-billing-refresh').click();
          await waitAdmin();
          assert.equal(
            await form.locator('[name="title"]').inputValue(),
            'Синтетический актуальный пакет',
          );
        });
        await record('admin-trial-and-unconfigured-payment-settings', async () => {
          const form = admin.page.locator('[data-admin-package-trial]');
          await form.locator('[name="organizationId"]').selectOption(f.owner.organizationId);
          await form.locator('[name="packageId"]').selectOption(packageId);
          await form.locator('[name="reason"]').fill('Синтетическое пробное подключение');
          await form.locator('[type="submit"]').click();
          await admin.page.waitForFunction(() =>
            document
              .querySelector('#admin-message')
              ?.textContent.includes('Пробный пакет подключён'),
          );
          await waitAdmin();
          await admin.page.locator('.admin-package-payment-settings > summary').click();
          const config = admin.page.locator('[data-admin-package-payments]');
          assert.equal(await config.locator('[name="testMode"]').isChecked(), true);
          assert.equal(await config.locator('[name="configured"]').isChecked(), false);
          for (const name of ['secretKey', 'vatCode', 'taxSystemCode'])
            assert.equal(await config.locator('[name="' + name + '"]').inputValue(), '');
          await inlineForm(admin.page, '[data-admin-package-payments]');
          await admin.page.locator('.admin-package-payment-settings > summary').click();
          await checkLayout(admin.page);
          await screenshot(admin, 'admin-packages');
          assert.equal(f.providerCalls.length, 0);
        });
        await record('owner-trial-lazy-load-and-employee-finance-hidden', async () => {
          owner = await session('owner@billing.test');
          await owner.page.goto(f.base + '/');
          await owner.page.locator('[data-view="settings"]').click();
          assert.equal(owner.billingReads, 0);
          await owner.page
            .locator('details.settings-tile:has(#paid-services-settings) > summary')
            .click();
          await owner.page.locator('.paid-package-quota').waitFor();
          assert.match(
            await owner.page.locator('.paid-service-status').innerText(),
            /Пробный пакет/,
          );
          assert.equal(
            await owner.page.locator('[data-paid-checkout] [type="submit"]').isDisabled(),
            true,
          );
          assert.match(
            await owner.page.locator('.paid-package-quota').innerText(),
            /Осталось задач\s+3/,
          );
          await inlineForm(owner.page, '[data-paid-checkout]');
          await screenshot(owner, 'owner-trial');
          for (const email of ['salon_admin@billing.test', 'cosmetologist@billing.test']) {
            const employee = await session(email);
            await employee.page.goto(f.base + '/');
            await employee.page.locator('[data-view="settings"]').click();
            assert.equal(await employee.page.locator('#paid-services-settings').count(), 0);
            assert.equal(employee.billingReads, 0);
            assert.equal((await (await employee.get('/api/assistant/scope')).json()).enabled, true);
          }
        });
        await record(
          'owner-checkout-validation-cancel-unknown-retry-and-redirect-guard',
          async () => {
            other = await session('other@billing.test');
            await openPackages(other);
            assert.match(
              await other.page.locator('.paid-package-notice').innerText(),
              /не подключён/,
            );
            assert.equal(
              await other.page.locator('[data-paid-checkout] [type="submit"]').isDisabled(),
              true,
            );
            await f.configurePayments();
            await other.page.locator('[data-paid-refresh]').click();
            await other.page.waitForFunction(
              () => !document.querySelector('[data-paid-checkout] [type="submit"]')?.disabled,
            );
            const form = other.page.locator('[data-paid-checkout]'),
              button = form.locator('[type="submit"]');
            assert.equal(
              await form
                .locator('[autocomplete="cc-number"], [name="cardNumber"], [name="cvc"]')
                .count(),
              0,
            );
            await form.locator('[name="receiptEmail"]').fill('invalid');
            await button.click();
            assert.equal(await other.page.locator('#action-confirmation[open]').count(), 0);
            await form.locator('[name="receiptEmail"]').fill('synthetic@example.test');
            await button.click();
            assert.equal(await other.page.locator('#action-confirmation[open]').count(), 0);
            await form.locator('[name="acceptTerms"]').check();
            await button.click();
            await other.page.locator('[data-confirm-cancel]').click();
            assert.equal(f.providerCalls.length, 0);
            let loseResponse = true;
            const bodies = [];
            await other.page.route('**/api/billing/checkout', async (route) => {
              bodies.push(route.request().postDataJSON());
              if (!loseResponse) return route.continue();
              loseResponse = false;
              const response = await route.fetch();
              assert.equal(response.status(), 200);
              await route.abort('failed');
            });
            await button.click();
            await other.page.locator('[data-confirm-accept]').click();
            await other.page.waitForFunction(() =>
              /Ответ не получен/.test(document.querySelector('[data-paid-message]')?.textContent),
            );
            assert.equal(await form.locator('[name="receiptEmail"]').isDisabled(), true);
            await button.click();
            await other.page.waitForFunction(() =>
              /защищённую ссылку/.test(document.querySelector('[data-paid-message]')?.textContent),
            );
            assert.equal(bodies.length, 2);
            assert.deepEqual(bodies[0], bodies[1]);
            assert.equal(f.providerCalls.filter(({ kind }) => kind === 'create').length, 1);
            checkoutId = f.latestOrder().id;
            assert.equal(new URL(other.page.url()).origin, f.base);
            assert.equal(blocked.length, 0);
          },
        );
        await record('confirmed-test-return-and-no-real-revenue', async () => {
          assert.ok(checkoutId);
          f.markPaid(checkoutId);
          await openPackages(other, '?payment=' + checkoutId);
          await other.page.waitForFunction(
            () => document.querySelector('.paid-service-status')?.textContent === 'Тестовая оплата',
          );
          assert.match(
            await other.page.locator('[data-paid-message]').innerText(),
            /Оплата подтверждена/,
          );
          assert.equal(
            await other.page.locator('[data-paid-checkout] [type="submit"]').isDisabled(),
            true,
          );
          await screenshot(other, 'owner-test-package');
          await admin.page.locator('#admin-billing-refresh').click();
          await waitAdmin();
          const view = await (await admin.get('/api/admin/billing')).json();
          assert.equal(view.summary.paidRevenueRub, 0);
          assert.equal(
            f.database.db
              .prepare('SELECT count(*) n FROM billing_package_grants WHERE source=?')
              .get('paid').n,
            1,
          );
          assert.match(
            await admin.page.locator('.paid-package-orders').innerText(),
            /Тестовая оплата/,
          );
        });
        await record('admin-local-review-and-reference-validation', async () => {
          const details = admin.page.locator('.admin-payment-review').first();
          await details.locator('summary').click();
          const form = details.locator('[data-admin-payment-review]');
          assert.equal(await form.locator('option[value="retry_create"]').count(), 0);
          await form.locator('[name="action"]').selectOption('check_refund');
          await form.locator('[name="reason"]').fill('Синтетическая проверка обязательного ID');
          const before = f.providerCalls.length;
          await form.locator('[type="submit"]').click();
          await form
            .locator('[data-admin-billing-message]')
            .filter({ hasText: 'Укажите ID' })
            .waitFor();
          assert.equal(f.providerCalls.length, before);
          await form.locator('[name="action"]').selectOption('request_refund_review');
          await form.locator('[type="submit"]').click();
          await waitAdmin();
          assert.equal(f.providerCalls.length, before);
          await admin.page.locator('.admin-payment-review').first().locator('summary').click();
          await inlineForm(admin.page, '[data-admin-payment-review]');
          await checkLayout(admin.page);
          await screenshot(admin, 'admin-review');
        });
        await record('narrow-and-landscape-reachability', async () => {
          for (const size of viewport.width < 700
            ? [
                { width: 320, height: 740 },
                { width: 844, height: 390 },
              ]
            : [viewport]) {
            await admin.page.setViewportSize(size);
            await other.page.setViewportSize(size);
            await checkLayout(admin.page);
            await inlineForm(admin.page, '[data-admin-package-form][data-package-id=""]');
            await inlineForm(other.page, '[data-paid-checkout]');
            if (size.width !== viewport.width)
              await screenshot(other, 'owner-fit-' + size.width + 'x' + size.height);
          }
          assert.deepEqual(errors, []);
          assert.equal(blocked.length, 0);
        });
      } finally {
        for (const context of contexts) await context.close();
        await f.close();
      }
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((item) => !item.passed);
  console.log(
    JSON.stringify({
      scenarios: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      positiveHostedRedirect:
        'Not run: automatic approval rejected real-domain fixture URL; all external traffic denied.',
    }),
  );
  if (failed.length) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
