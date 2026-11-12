const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  createBillingCompletionFixture,
} = require('../tests/helpers/billing-completion-fixture.cjs');
const { authContextHeaders } = require('../tests/helpers/account-context.cjs');
const { checkLayout, inlineForm } = require('../tests/browser/appearance.cjs');
async function main() {
  const only = process.env.CARTOTECA_BILLING_COMPLETION_SCENARIO || '';
  const output = path.resolve(
    'work/paid-services-completion-20261019/' +
      (only ? 'short-plan-browser-focused' : 'short-plan-browser'),
  );
  fs.mkdirSync(output, { recursive: true });
  const results = [],
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const f = await createBillingCompletionFixture(),
        contexts = [],
        errors = [],
        blocked = [];
      let admin, owner;
      async function session(email) {
        const context = await browser.newContext({
          viewport,
          locale: 'ru-RU',
          timezoneId: 'Asia/Yerevan',
          isMobile: viewport.width < 700,
          hasTouch: viewport.width < 700,
          serviceWorkers: 'block',
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
        const headers = authContextHeaders(await response.json()),
          page = await context.newPage(),
          requests = [];
        page.setDefaultTimeout(8000);
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('dialog', (dialog) => dialog.accept());
        page.on('request', (request) =>
          requests.push({
            url: request.url(),
            method: request.method(),
            ...(request.method() === 'POST' && request.url().endsWith('/api/billing/checkout')
              ? { body: request.postDataJSON() }
              : {}),
          }),
        );
        return { context, headers, page, requests };
      }
      async function record(name, run) {
        if (only && only !== name) return;
        const result = { name, width: viewport.width, passed: false };
        try {
          await run();
          result.passed = true;
        } catch (error) {
          result.error = error.stack;
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
      async function loaded() {
        await admin.page.waitForFunction(
          () =>
            document.querySelector('#admin-billing-content .admin-billing') &&
            !document.querySelector('#admin-billing-content').hasAttribute('aria-busy'),
        );
      }
      async function ordersLoaded() {
        await admin.page.waitForFunction(
          () => !document.querySelector('.paid-package-orders')?.hasAttribute('aria-busy'),
        );
      }
      async function screenshot(actor, name, selector) {
        await checkLayout(actor.page);
        await actor.page
          .locator(selector)
          .evaluate((node) => node.scrollIntoView({ block: 'start' }));
        await actor.page.screenshot({
          path: path.join(output, viewport.width + '-' + name + '.png'),
        });
      }
      async function openPackages(actor, query = '') {
        await actor.page.goto(f.base + '/' + query);
        await actor.page.locator('[data-view="settings"]').click();
        await actor.page
          .locator('details.settings-tile:has(#paid-services-settings) > summary')
          .click();
        await actor.page.locator('[data-paid-checkout]').waitFor();
        await actor.page.waitForFunction(
          () => !document.querySelector('#paid-services-settings').hasAttribute('aria-busy'),
        );
      }
      async function submitCheckout(actor) {
        const form = actor.page.locator('[data-paid-checkout]');
        await form.locator('[name="receiptEmail"]').fill('synthetic-receipt@example.test');
        await form.locator('[name="acceptTerms"]').check();
        await form.locator('[type="submit"]').click();
        await actor.page.locator('[data-confirm-accept]').click();
      }
      try {
        await record('cabinet-scope-and-directory-next-page', async () => {
          admin = await session('root@billing.test');
          await admin.page.goto(f.base + '/admin.html');
          await admin.page.locator('#admin-overview-billing .admin-billing-totals').waitFor();
          assert.equal(
            admin.requests.filter((item) => new URL(item.url).pathname === '/api/admin/billing')
              .length,
            0,
          );
          assert.ok(admin.requests.some((item) => item.url.endsWith('/api/admin/billing/summary')));
          await admin.page.locator('[data-admin-view="billing"]').click();
          await loaded();
          assert.match(
            await admin.page.locator('[data-billing-organization-count]').innerText(),
            /20 из 26/,
          );
          const trial = admin.page.locator('[data-admin-package-trial]');
          await admin.page.locator('[data-billing-trial-details] > summary').click();
          await trial.locator('[name="reason"]').fill('Несохранённая синтетическая причина');
          const selected = await trial.locator('[name="organizationId"]').inputValue();
          await trial.locator('[data-billing-organization-more]').click();
          await admin.page.waitForFunction(
            () => document.querySelectorAll('[data-billing-organization-id]').length === 26,
          );
          assert.equal(await trial.locator('[name="organizationId"]').inputValue(), selected);
          assert.equal(
            await trial.locator('[name="reason"]').inputValue(),
            'Несохранённая синтетическая причина',
          );
          assert.equal(await trial.locator('[name="organizationId"] option').count(), 26);
          await admin.page
            .locator('[data-admin-billing-organization="' + f.owner.organizationId + '"]')
            .click();
          await loaded();
          assert.match(
            await admin.page.locator('#admin-billing-content .admin-billing-scope').innerText(),
            /Кабинет: Синтетический кабинет А/,
          );
          const value = await admin.page
            .locator('#admin-billing-content .admin-billing-totals dt')
            .filter({ hasText: /^Расчётные расходы$/ })
            .locator('..')
            .locator('dd')
            .innerText();
          assert.equal(value, '3,75 ₽');
          assert.doesNotMatch(
            await admin.page.locator('#admin-billing-content').innerText(),
            /12,00 ₽/,
          );
          await screenshot(admin, 'cabinet-cost', '[data-admin-section="billing"]');
          await admin.page.locator('[data-admin-billing-back]').click();
          await loaded();
        });
        await record('order-cursor-exact-id-and-bounded-attention-search', async () => {
          await admin.page.locator('[data-admin-billing-tab="payments"]').click();
          assert.equal(await admin.page.locator('[data-admin-order-id]').count(), 50);
          await admin.page.locator('[data-billing-orders-more]').click();
          await admin.page.waitForFunction(
            () => document.querySelectorAll('[data-admin-order-id]').length === 100,
          );
          const filter = admin.page.locator('[data-billing-orders-filter]');
          await filter.locator('[name="q"]').fill(f.history.at(-1).providerId);
          await filter.locator('[type="submit"]').click();
          await ordersLoaded();
          assert.equal(await admin.page.locator('[data-admin-order-id]').count(), 1);
          assert.equal(
            await admin.page.locator('[data-admin-order-id]').getAttribute('data-admin-order-id'),
            f.history.at(-1).id,
          );
          await filter.locator('[name="q"]').fill('');
          await filter.locator('[name="status"]').selectOption('attention');
          await filter.locator('[type="submit"]').click();
          await ordersLoaded();
          assert.equal(await admin.page.locator('[data-admin-order-id]').count(), 0);
          assert.equal(
            await admin.page.locator('[data-billing-orders-more]').innerText(),
            'Продолжить поиск',
          );
          assert.match(
            await admin.page.locator('[data-billing-orders-empty]').innerText(),
            /В этой части истории/,
          );
          await admin.page.locator('[data-billing-orders-more]').click();
          await ordersLoaded();
          assert.equal(await admin.page.locator('[data-admin-order-id]').count(), 1);
          assert.equal(
            await admin.page.locator('[data-admin-order-id]').getAttribute('data-admin-order-id'),
            f.attention.id,
          );
          await inlineForm(admin.page, '[data-billing-orders-filter]');
          await screenshot(admin, 'order-search', '.paid-package-orders');
        });
        await record('definite-reject-new-checkout-and-memoryless-review-block', async () => {
          await f.configurePayments();
          f.rejectNextCheckout();
          owner = await session('owner@billing.test');
          await openPackages(owner);
          await submitCheckout(owner);
          await owner.page.waitForFunction(() =>
            /не создан/.test(document.querySelector('[data-paid-message]')?.textContent),
          );
          assert.equal(
            await owner.page.locator('[data-paid-checkout] [type="submit"]').innerText(),
            'Перейти к оплате',
          );
          await submitCheckout(owner);
          await owner.page.waitForFunction(() =>
            /защищённую ссылку/.test(document.querySelector('[data-paid-message]')?.textContent),
          );
          const posts = owner.requests.filter((item) => item.body);
          assert.equal(posts.length, 2);
          assert.notEqual(posts[0].body.requestId, posts[1].body.requestId);
          const other = await session('other@billing.test');
          await openPackages(other, '?payment=' + f.attention.id);
          assert.equal(
            await other.page.locator('[data-paid-checkout] [type="submit"]').isDisabled(),
            true,
          );
          assert.match(await other.page.locator('[data-paid-message]').innerText(), /сверки/);
          assert.equal(other.requests.filter((item) => item.body).length, 0);
          await screenshot(other, 'owner-review', '#paid-services-settings');
          assert.equal(f.providerCalls.filter((item) => item.kind === 'create').length, 2);
        });
        await record('protected-financial-audit-russian-labels-and-price-diff', async () => {
          if (!admin) admin = await session('root@billing.test');
          await f.configurePayments();
          await admin.page.goto(f.base + '/admin.html');
          await admin.page.locator('[data-admin-view="billing"]').click();
          await loaded();
          await admin.page.locator('[data-admin-billing-tab="packages"]').click();
          const form = admin.page.locator(
            '[data-admin-package-form][data-package-id="' + f.packageId + '"]',
          );
          await form.locator('..').locator(':scope > summary').click();
          await form.locator('[name="priceRub"]').fill('12.50');
          await form.locator('[name="reason"]').fill('Синтетическая проверка истории изменений');
          await form.locator('[type="submit"]').click();
          await admin.page
            .locator(
              '[data-admin-package-form][data-package-id="' + f.packageId + '"][data-revision="2"]',
            )
            .waitFor({ state: 'attached' });
          await screenshot(admin, 'compact-packages', '.admin-billing-tabs');
          await admin.page.locator('[data-admin-view="audit"]').click();
          await admin.page.locator('#admin-audit-event').selectOption('billing_package_saved');
          await admin.page.waitForFunction(() =>
            document.querySelector('#admin-audit')?.textContent.includes('Цена: 9,90 ₽ → 12,50 ₽'),
          );
          await admin.page
            .locator('#admin-audit .admin-audit-item')
            .first()
            .locator('summary')
            .click();
          const text = await admin.page.locator('#admin-audit').innerText();
          assert.match(text, /Изменён пакет помощника/);
          assert.match(text, /Синтетическая проверка истории изменений/);
          assert.doesNotMatch(
            text,
            /synthetic-billing-secret|secretKey|providerPayload|confirmationUrl/,
          );
          await screenshot(admin, 'financial-audit', '[data-admin-section="audit"]');
          assert.deepEqual(errors, []);
          assert.deepEqual(blocked, []);
        });
      } finally {
        for (const context of contexts) await context.close();
        await f.close();
      }
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((item) => !item.passed).length;
  console.log(
    JSON.stringify({
      scenarios: results.length,
      passed: results.length - failed,
      failed,
      externalRequests: 0,
      hostedRedirect: 'Not run; all external traffic denied.',
    }),
  );
  if (failed) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
