const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('');
const records = {
  esc: (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    ),
  date: (value) => String(value),
};
const context = vm.createContext({ records, FormData: dom.window.FormData });
for (const file of [
  'billing-money.js',
  'payment-review-view.js',
  'billing-summary-view.js',
  'billing-pages-view.js',
  'billing-view.js',
])
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/client/modules/admin', file), 'utf8'),
    context,
  );
const review = vm.runInContext('createAdminPaymentReviewView({records})', context);
const view = vm.runInContext('createAdminBillingView({records})', context);

test('cost uncertainty is explicit only when unresolved usage or reservations exist', () => {
  assert.equal(view.uncertaintyHtml({ uncertainCalls: 0, pendingReservations: 0 }), '');
  assert.equal(view.uncertaintyHtml({ uncertainCalls: NaN, pendingReservations: -1 }), '');
  const warning = view.uncertaintyHtml({ uncertainCalls: 2, pendingReservations: 1 });
  assert.match(warning, /Расходы ещё уточняются/);
  assert.match(warning, /Неуточнённых обращений: 2/);
  assert.match(warning, /Незакрытых резервов: 1/);
  const html = view.renderBillingAdminHtml({ available: true, packages: [], summary: {} });
  assert.match(html, /платным и пробным пакетам с начала их учёта/);
  assert.doesNotMatch(html, /<h3>Пакеты и оплата/);
});

test('review forms require a version and never offer administrative creation without capability', () => {
  assert.equal(review.render({ id: 'synthetic', status: 'pending' }), '');
  const html = review.render({
    id: 'synthetic',
    revision: 4,
    canRetryCreate: false,
    receiptRegistration: null,
    reconciliation: { status: 'required' },
    refund: { status: 'review_required' },
    closingReceipt: { status: 'not_checked' },
  });
  assert.match(html, /Нужна сверка/);
  assert.match(html, /Заявка на проверку/);
  assert.match(html, /Не проверялся/);
  assert.match(html, /Чек оплаты:<\/strong> Нет сведений/);
  assert.match(html, /Они не возвращают деньги и не создают чек/);
  assert.doesNotMatch(html, /value="retry_create"|manual_approve|approve_paid/);
});

test('reference checks require an existing reference and carry the exact order revision', () => {
  dom.window.document.body.innerHTML = review.render({ id: 'synthetic', revision: 7 });
  const form = dom.window.document.querySelector('form');
  form.elements.action.value = 'check_refund';
  const common = { requestId: 'synthetic-request', reason: 'Synthetic only' };
  assert.throws(() => review.operation(form, common), /Укажите ID/);
  form.elements.referenceId.value = ' existing-reference ';
  form.elements.paymentId.value = 'ignored-for-refund';
  const operation = JSON.parse(JSON.stringify(review.operation(form, common)));
  assert.deepEqual(operation, {
    route: '/api/admin/billing/payment-review',
    kind: 'review',
    body: {
      ...common,
      checkoutId: 'synthetic',
      expectedRevision: 7,
      action: 'check_refund',
      referenceId: 'existing-reference',
    },
  });
  form.elements.action.value = 'request_receipt_review';
  const local = JSON.parse(JSON.stringify(review.operation(form, common)));
  assert.equal(Object.hasOwn(local.body, 'referenceId'), false);
  assert.equal(Object.hasOwn(local.body, 'paymentId'), false);
});

test('payment settings never render a returned key or choose tax parameters for an unconfigured draft', () => {
  const html = view.renderBillingAdminHtml({
    available: true,
    packages: [],
    summary: {},
    paymentConfiguration: {
      configured: false,
      secretConfigured: true,
      secretKey: 'must-never-render',
      receiptConfig: { vatCode: null, taxSystemCode: null },
    },
  });
  assert.doesNotMatch(html, /must-never-render/);
  const page = new JSDOM(html).window.document;
  assert.equal(page.querySelector('[name="secretKey"]').value, '');
  assert.equal(page.querySelector('[name="vatCode"]').value, '');
  assert.equal(page.querySelector('[name="taxSystemCode"]').value, '');
  assert.equal(page.querySelector('[name="configured"]').checked, false);
});

test('a cabinet summary requires its explicit scope and cannot relabel platform totals as local', () => {
  const organization = { id: 'synthetic-org', name: 'Синтетический кабинет' };
  const global = { available: true, scope: { type: 'platform' }, summary: { providerCostRub: 99 } };
  const rejected = view.renderBillingAdminHtml(global, organization);
  assert.match(rejected, /Финансовые данные этого кабинета пока не загружены/);
  assert.doesNotMatch(rejected, /99,00/);
  const local = view.renderBillingAdminHtml(
    {
      ...global,
      scope: { type: 'organization', organizationId: organization.id, name: organization.name },
      periodLabel: 'С начала учёта пакетов',
      summary: { providerCostRub: 3.75, paidRevenueRub: 10, trialGrants: 4, activePackages: 1 },
    },
    organization,
  );
  assert.match(local, /Кабинет: Синтетический кабинет/);
  assert.match(local, /3,75/);
  assert.match(local, /Пробных выдач за период учёта/);
  assert.match(local, /Действующих пакетов/);
});

test('empty history keeps a working search form and pagination indicators are explicit', () => {
  const html = view.renderBillingAdminHtml({
    available: true,
    packages: [],
    summary: {},
    organizations: [{ organizationId: 'org-a', organizationName: 'Кабинет А', subscription: null }],
    organizationTotal: 21,
    nextOffset: 20,
    orders: [],
    ordersNextCursor: 'opaque-cursor',
  });
  const page = new JSDOM(html).window.document;
  assert.match(
    page.querySelector('[data-billing-organization-count]').textContent,
    /Показано 1 из 21/,
  );
  assert.equal(page.querySelector('[data-billing-orders-more]').hidden, false);
  assert.equal(page.querySelector('[data-billing-organization-more]').hidden, false);
  const search = page.querySelector('[data-billing-orders-filter] [name="q"]');
  search.value = 'short';
  assert.equal(search.checkValidity(), false);
  search.value = '12345678-1234-1234-1234-123456789abc';
  assert.equal(search.checkValidity(), true);
  assert.equal(page.querySelector('[data-billing-orders-empty]').hidden, false);
});

test('financial totals and their difference preserve exact integer minor units beyond Number precision', () => {
  const money = vm.runInContext('createAdminBillingMoney()', context);
  assert.equal(
    money.format('900719925474099112345', 100n),
    '9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0991\u00a0123,45 ₽',
  );
  assert.equal(
    money.difference({
      paidRevenueKopecks: '900719925474099112345',
      providerCostMicrorub: '9007199254740991123449999',
    }),
    '0,000001 ₽',
  );
  assert.equal(
    money.difference({ paidRevenueKopecks: '0', providerCostMicrorub: '1' }),
    '−0,000001 ₽',
  );
});
