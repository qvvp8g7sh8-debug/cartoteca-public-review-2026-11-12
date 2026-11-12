const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const source = (file) =>
  fs.readFileSync(path.join(__dirname, '../src/client/modules/admin', file), 'utf8');
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
async function waitFor(check) {
  for (let index = 0; index < 40; index++) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  assert.ok(check(), 'Synthetic pagination did not settle');
}
function fixture() {
  const dom = new JSDOM('<div id="content"></div>'),
    document = dom.window.document;
  const records = { esc, date: (value) => String(value) },
    requests = [],
    messages = [];
  let generation = 1,
    respond = async () => ({}),
    permit = true;
  const context = vm.createContext({
    document,
    URLSearchParams,
    FormData: dom.window.FormData,
    confirm: () => permit,
  });
  for (const file of [
    'billing-money.js',
    'payment-review-view.js',
    'billing-summary-view.js',
    'billing-pages-view.js',
    'billing-view.js',
    'billing-pages.js',
    'billing-navigation.js',
    'audit-view.js',
  ])
    vm.runInContext(source(file), context);
  const view = vm.runInContext('createAdminBillingView', context)({ records });
  const root = document.querySelector('#content');
  const navigation = vm.runInContext(
    'createAdminBillingNavigation',
    context,
  )({ content: () => root, scope: () => null });
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const order = (id) => ({
    checkoutId: id,
    revision: 1,
    title: 'Синтетический заказ',
    priceKopecks: 990,
    status: 'rejected',
    createdAt: 1,
  });
  const initial = {
    available: true,
    summary: {},
    packages: [
      {
        id: 'synthetic',
        title: 'Синтетический пакет',
        priceKopecks: 990,
        taskLimit: 3,
        enabled: true,
        version: 1,
      },
    ],
    organizations: [{ organizationId: 'org-a', organizationName: 'Кабинет А' }],
    organizationTotal: 2,
    nextOffset: 20,
    orders: [order(a)],
    ordersNextCursor: 'opaque:cursor',
  };
  const pages = vm.runInContext(
    'createAdminBillingPages',
    context,
  )({
    view,
    content: () => root,
    request: async (route) => {
      requests.push(route);
      return respond(route);
    },
    isCurrent: (value) => value === generation,
    restorePending() {},
    message: (value) => messages.push(value),
  });
  function render(data = initial) {
    root.innerHTML = view.renderBillingAdminHtml(data);
    pages.init(data, null, generation);
    navigation.restore();
  }
  render();
  pages.bind();
  navigation.bind();
  return {
    dom,
    document,
    root,
    requests,
    messages,
    a,
    b,
    order,
    initial,
    render,
    respond(fn) {
      respond = fn;
    },
    permit(value) {
      permit = value;
    },
    nextGeneration() {
      generation++;
    },
  };
}
test('more organizations append without duplicates and preserve the trial form and selected cabinet', async () => {
  const f = fixture();
  try {
    const form = f.root.querySelector('[data-admin-package-trial]');
    form.elements.reason.value = 'Несохранённая причина';
    form.dataset.dirty = '1';
    f.respond(async () => ({
      organizations: [
        f.initial.organizations[0],
        { organizationId: 'org-b', organizationName: 'Кабинет Б' },
      ],
      total: 2,
      nextOffset: null,
    }));
    f.root.querySelector('.admin-billing-directory [data-billing-organization-more]').click();
    await waitFor(() => f.root.querySelectorAll('[data-billing-organization-id]').length === 2);
    assert.equal(f.requests[0], '/api/admin/billing/organizations?offset=20');
    assert.equal(form.elements.reason.value, 'Несохранённая причина');
    assert.equal(form.elements.organizationId.value, 'org-a');
    assert.equal(form.elements.organizationId.options.length, 2);
    assert.equal(form.dataset.dirty, '1');
    assert.match(
      f.root.querySelector('[data-billing-organization-count]').textContent,
      /Показано 2 из 2/,
    );
  } finally {
    f.dom.window.close();
  }
});
test('order pagination forwards an opaque cursor and removes duplicate rows', async () => {
  const f = fixture();
  try {
    f.respond(async () => ({ orders: [f.order(f.a), f.order(f.b)], nextCursor: null }));
    f.root.querySelector('[data-billing-orders-more]').click();
    await waitFor(() => f.root.querySelectorAll('[data-admin-order-id]').length === 2);
    assert.equal(
      new URL(f.requests[0], 'http://synthetic.test').searchParams.get('before'),
      'opaque:cursor',
    );
    assert.equal(f.root.querySelector('[data-billing-orders-more]').hidden, true);
  } finally {
    f.dom.window.close();
  }
});
test('a denied filter change preserves a dirty review form and performs no request', async () => {
  const f = fixture();
  try {
    const review = f.root.querySelector('[data-admin-payment-review]');
    review.dataset.dirty = '1';
    review.elements.reason.value = 'Не терять эти изменения';
    f.permit(false);
    const form = f.root.querySelector('[data-billing-orders-filter]');
    form.elements.status.value = 'attention';
    form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(setImmediate);
    assert.equal(f.requests.length, 0);
    assert.equal(form.elements.status.value, 'all');
    assert.equal(review.elements.reason.value, 'Не терять эти изменения');
  } finally {
    f.dom.window.close();
  }
});
test('late order results cannot append into a different financial page generation', async () => {
  const f = fixture();
  try {
    let resolve;
    f.respond(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.root.querySelector('[data-billing-orders-more]').click();
    await waitFor(() => resolve);
    f.nextGeneration();
    f.render({ ...f.initial, orders: [f.order(f.b)], ordersNextCursor: null });
    resolve({ orders: [f.order(f.a)], nextCursor: null });
    await new Promise(setImmediate);
    assert.deepEqual(
      [...f.root.querySelectorAll('[data-admin-order-id]')].map(
        (node) => node.dataset.adminOrderId,
      ),
      [f.b],
    );
  } finally {
    f.dom.window.close();
  }
});
test('financial audit history has Russian labels and never renders unknown billing snapshot fields', () => {
  const f = fixture();
  try {
    f.document.body.innerHTML =
      '<select id="admin-audit-event"><option value="">Все действия</option></select><div id="admin-audit"></div>';
    const context = vm.createContext({ document: f.document });
    vm.runInContext(source('billing-money.js'), context);
    vm.runInContext(source('audit-view.js'), context);
    const audit = vm.runInContext(
      'createAdminAuditView',
      context,
    )({
      $: (selector) => f.document.querySelector(selector),
      records: { esc, date: () => 'Сегодня' },
    });
    audit.renderAudit([
      {
        event: 'billing_package_saved',
        time: 1,
        targetType: 'billing_package',
        targetId: 'synthetic',
        detail: {
          reason: 'Синтетическая проверка',
          before: { priceKopecks: 990 },
          after: { priceKopecks: 1250, secretKey: 'must-not-render' },
        },
      },
    ]);
    const text = f.document.querySelector('#admin-audit').textContent;
    assert.match(text, /Изменён пакет услуги/);
    assert.match(text, /Цена: 9,90 ₽ → 12,50 ₽/);
    assert.doesNotMatch(text, /must-not-render|secretKey/);
    assert.equal(f.document.querySelectorAll('option[value="billing_payment_review"]').length, 1);
  } finally {
    f.dom.window.close();
  }
});

test('a bounded history scan with zero matches keeps the continuation cursor visible', () => {
  const f = fixture();
  try {
    f.render({ ...f.initial, orders: [], ordersNextCursor: 'scanned:opaque' });
    assert.equal(f.root.querySelector('[data-billing-orders-more]').hidden, false);
    assert.equal(
      f.root.querySelector('[data-billing-orders-more]').textContent,
      'Продолжить поиск',
    );
    assert.match(
      f.root.querySelector('[data-billing-orders-empty]').textContent,
      /В этой части истории/,
    );
    assert.doesNotMatch(
      f.root.querySelector('[data-billing-orders-empty]').textContent,
      /По этим условиям заказов нет/,
    );
  } finally {
    f.dom.window.close();
  }
});

test('financial tabs preserve form identity, unsaved values and an unknown-operation lock', () => {
  const f = fixture();
  try {
    const form = f.root.querySelector('[data-admin-package-form]');
    f.root.querySelector('[data-admin-billing-tab="packages"]').click();
    form.closest('details').open = true;
    form.elements.reason.value = 'Сохранить при переключении';
    form.dataset.dirty = '1';
    form.querySelector('fieldset').disabled = true;
    f.root.querySelector('[data-admin-billing-tab="cabinets"]').click();
    assert.equal(f.root.querySelector('[data-admin-billing-panel="packages"]').hidden, true);
    f.root.querySelector('[data-admin-billing-tab="payments"]').click();
    f.root.querySelector('[data-admin-billing-tab="packages"]').click();
    assert.equal(f.root.querySelector('[data-admin-package-form]'), form);
    assert.equal(form.elements.reason.value, 'Сохранить при переключении');
    assert.equal(form.dataset.dirty, '1');
    assert.equal(form.querySelector('fieldset').disabled, true);
    assert.equal(form.closest('details').open, true);
  } finally {
    f.dom.window.close();
  }
});
