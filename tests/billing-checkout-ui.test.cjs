const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const viewSource = fs.readFileSync(path.join(__dirname,'../src/client/modules/paid-services-view.js'),'utf8');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/paid-services.js'),
  'utf8',
);
async function waitFor(check) {
  for (let index = 0; index < 40; index++) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  assert.ok(check(), 'Synthetic UI operation did not settle');
}
async function fixture(outcomes, fixtureOptions = {}) {
  const dom = new JSDOM('', { url: 'http://billing.test/', pretendToBeVisual: true });
  const calls = [],
    packageId = 'synthetic-package',
    originalId = crypto.randomUUID();
  let returnPayment = null;
  const snapshot = {
    available: true,
    paymentReady: true,
    packages: [
      {
        id: packageId,
        title: 'Синтетический пакет',
        enabled: true,
        priceKopecks: 990,
        taskLimit: 3,
        version: 1,
      },
    ],
    subscription: { active: false },
    termsVersion: 'packages-20261019-draft',
  };
  Object.assign(snapshot,fixtureOptions.snapshot || {});
  const state = {
    multiUser: true,
    currentView: 'settings',
    sessionReady: true,
    account: {
      id: 'synthetic-owner',
      organizationId: 'synthetic-org',
      role: 'owner',
      email: 'owner@example.test',
    },
  };
  const actions = {
    $: (selector) => dom.window.document.querySelector(selector),
    accountRole: () => 'owner',
    esc: (value) =>
      String(value ?? '').replace(
        /[&<>"']/g,
        (character) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
      ),
    settingsSectionHtml: (title, id, html) =>
      '<details class="settings-tile" open><summary>' +
      title +
      '</summary><div id="' +
      id +
      '">' +
      html +
      '</div></details>',
    confirmAction: async () => true,
    applyAssistantScope() {},
    toast() {},
    async request(route, options) {
      if (route === '/api/billing') return structuredClone(snapshot);
      if (route === '/api/billing/services/connection') {fixtureOptions.onConnect?.(snapshot,JSON.parse(options.body));return structuredClone(snapshot);}
      if (route.startsWith('/api/billing/payment?')) return returnPayment;
      if (route === '/api/billing/checkout') {
        calls.push(JSON.parse(options.body));
        const next = outcomes.shift();
        if (next instanceof Error) throw next;
        return { checkoutId: originalId, ...next };
      }
      throw Error('Unexpected synthetic route');
    },
  };
  const context = vm.createContext({
    state,
    actions,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    URL,
    URLSearchParams,
    AbortController,
    FormData: dom.window.FormData,
  });
  vm.runInContext(viewSource + source + '\nObject.assign(actions,createPaidServicesView(state,actions)); this.module = createPaidServices(state, actions);', context);
  dom.window.document.body.innerHTML = context.module.paidServicesSettingsHtml();
  context.module.bindPaidServicesEvents();
  const root = actions.$('#paid-services-settings');
  root.closest('details').dispatchEvent(new dom.window.Event('toggle'));
  await waitFor(
    () => root.querySelector('[data-paid-checkout]') && !root.hasAttribute('aria-busy'),
  );
  return {
    dom,
    calls,
    root,
    originalId,
    snapshot,
    async submit() {
      const form = root.querySelector('form');
      if (!form.querySelector('[name="receiptEmail"]').disabled) {
        form.elements.receiptEmail.value = 'receipt@example.test';
        form.elements.acceptTerms.checked = true;
      }
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(
        () =>
          !root.hasAttribute('aria-busy') &&
          /Заказ не создан|требует сверки|Ответ не получен|отменена|выключен/.test(
            root.querySelector('[data-paid-message]').textContent,
          ),
      );
      await new Promise(setImmediate);
    },
    async payment(value) {
      returnPayment = value;
      dom.window.history.replaceState({}, '', '?payment=' + value.checkoutId);
      root.querySelector('[data-paid-refresh]').click();
      await waitFor(() => !root.hasAttribute('aria-busy'));
    },
  };
}
test('definite rejected checkout releases only that operation and permits a new explicit request', async () => {
  const f = await fixture([{ status: 'rejected' }, { status: 'rejected' }]);
  try {
    await f.submit();
    assert.equal(f.root.querySelector('[name="receiptEmail"]').disabled, false);
    assert.equal(f.root.querySelector('[type="submit"]').textContent, 'Перейти к оплате');
    await f.submit();
    assert.equal(f.calls.length, 2);
    assert.notEqual(f.calls[0].requestId, f.calls[1].requestId);
  } finally {
    f.dom.window.close();
  }
});
test('review status keeps the original request blocked and explains the need for reconciliation', async () => {
  const f = await fixture([{ status: 'review' }, { status: 'review' }]);
  try {
    await f.submit();
    assert.equal(f.root.querySelector('fieldset').disabled, true);
    assert.match(f.root.querySelector('[data-paid-message]').textContent, /требует сверки/);
    assert.doesNotMatch(
      f.root.querySelector('[data-paid-message]').textContent,
      /Ожидаем подтверждения/,
    );
    await f.submit();
    assert.deepEqual(f.calls[0], f.calls[1]);
  } finally {
    f.dom.window.close();
  }
});
test('an unrelated terminal return cannot erase an unknown original checkout request', async () => {
  const error = Object.assign(Error('Synthetic lost response'), { outcomeUnknown: true });
  const f = await fixture([error, { status: 'review' }]);
  try {
    await f.submit();
    await f.payment({
      checkoutId: crypto.randomUUID(),
      status: 'rejected',
      notice: 'Заказ не создан.',
    });
    assert.equal(f.root.querySelector('fieldset').disabled, true);
    await f.submit();
    assert.deepEqual(f.calls[0], f.calls[1]);
  } finally {
    f.dom.window.close();
  }
});

test('a known server transport OFF refusal releases the request without an unknown-payment lock', async () => {
  const error = Object.assign(Error('Приём оплат выключен сервером.'), {
    status: 503,
    code: 'PAYMENTS_NETWORK_DISABLED',
    outcomeUnknown: false,
  });
  const f = await fixture([error, { status: 'rejected' }]);
  try {
    await f.submit();
    assert.equal(f.root.querySelector('fieldset').disabled, false);
    assert.equal(f.root.querySelector('[type="submit"]').textContent, 'Перейти к оплате');
    assert.doesNotMatch(
      f.root.querySelector('[data-paid-message]').textContent,
      /Ответ не получен/,
    );
    await f.submit();
    assert.notEqual(f.calls[0].requestId, f.calls[1].requestId);
  } finally {
    f.dom.window.close();
  }
});

test('an unknown original operation remains blocked when its retry receives a definite transport OFF refusal', async () => {
  const unknown = Object.assign(Error('Synthetic unknown'), { outcomeUnknown: true });
  const off = Object.assign(Error('Приём оплат выключен сервером.'), {
    status: 503,
    outcomeUnknown: false,
  });
  const f = await fixture([unknown, off, { status: 'review' }]);
  try {
    await f.submit();
    await f.submit();
    assert.equal(f.root.querySelector('fieldset').disabled, true);
    assert.match(
      f.root.querySelector('[data-paid-message]').textContent,
      /прежнего заказа пока неизвестен/,
    );
    await f.submit();
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.deepEqual(f.calls[0], f.calls[2]);
  } finally {
    f.dom.window.close();
  }
});

test('a review return without an in-memory operation still blocks creating another order', async () => {
  const f = await fixture([]);
  try {
    await f.payment({
      checkoutId: f.originalId,
      status: 'review',
      notice: 'Заказ требует сверки администратором.',
    });
    assert.equal(f.root.querySelector('[type="submit"]').disabled, true);
    await f.submit();
    assert.equal(f.calls.length, 0);
    assert.match(f.root.querySelector('[data-paid-message]').textContent, /требует сверки/);
  } finally {
    f.dom.window.close();
  }
});

function twoServices(activeVoice=false) {
  return {services:[{code:'voice-assistant',title:'Помощник',subscription:{active:activeVoice,enabled:activeVoice,connectionRevision:1,title:'Голосовой',endsAt:Date.now()+86400000}},{code:'reports',title:'Отчёты',subscription:{active:false}}],
    packages:[{id:'synthetic-package',title:'Голосовой',serviceCode:'voice-assistant',enabled:true,priceKopecks:990,taskLimit:3,version:1},{id:'reports',title:'Отчёты',serviceCode:'reports',enabled:true,priceKopecks:2000,taskLimit:1,quotaUnit:'access',periodMonths:12,version:1}]};
}
test('an active voice package leaves the other service purchasable',async()=>{
 const f=await fixture([],{snapshot:twoServices(true)});try{
  assert.equal(f.root.querySelector('[data-service-code="voice-assistant"] fieldset').disabled,true);
  assert.equal(f.root.querySelector('[data-service-code="reports"] fieldset').disabled,false);
  assert.match(f.root.querySelector('[data-paid-service="reports"]').textContent,/12 мес/);
 }finally{f.dom.window.close();}
});
test('unknown payment for voice does not block reports or erase the original request key',async()=>{
 const unknown=()=>Object.assign(Error('Ответ не получен'),{outcomeUnknown:true});
 const f=await fixture([unknown(),{status:'rejected',package:{serviceCode:'reports'}},unknown()],{snapshot:twoServices()});try{
  await f.submit();const form=f.root.querySelector('[data-service-code="reports"]');assert.equal(form.querySelector('fieldset').disabled,false);
  form.elements.receiptEmail.value='reports@example.test';form.elements.acceptTerms.checked=true;
  form.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>f.calls.length===2 && !f.root.hasAttribute('aria-busy'));
  await f.submit();assert.equal(f.calls[1].packageId,'reports');assert.notEqual(f.calls[0].requestId,f.calls[1].requestId);assert.equal(f.calls[0].requestId,f.calls[2].requestId);
 }finally{f.dom.window.close();}
});
