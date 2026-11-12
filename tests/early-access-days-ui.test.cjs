const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/early-access.js'),
  'utf8',
);

function fixture(t) {
  const dom = new JSDOM('<section><span id="early-access-days">Загрузка</span></section>', {
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('#early-access-days');
  const state = {
    multiUser: true,
    currentView: 'settings',
    account: { id: 'a', organizationId: 'org-a' },
  };
  const actions = {
    $: (selector) => dom.window.document.querySelector(selector),
    plural: (n, one, few, many) =>
      n % 100 >= 11 && n % 100 <= 14
        ? many
        : n % 10 === 1
          ? one
          : n % 10 >= 2 && n % 10 <= 4
            ? few
            : many,
    readBackground: async () => ({ freeAccess: { status: 'active', remainingDays: 274 } }),
  };
  const api = dom.window.eval(source + '\ncreateEarlyAccess')(state, actions);
  return { root, state, actions, api };
}

test('day text changes without replacing surrounding forms; quiet errors retain the real value', async (t) => {
  const f = fixture(t),
    parent = f.root.parentElement;
  await f.api.loadEarlyAccess();
  assert.equal(f.root.textContent, 'Бесплатный доступ: осталось 274 дня');
  f.actions.readBackground = async () => {
    throw Error('offline');
  };
  await f.api.loadEarlyAccess({ quiet: true });
  assert.equal(f.root.textContent, 'Бесплатный доступ: осталось 274 дня');
  assert.equal(f.root.parentElement, parent);
});

test('an old organization response cannot replace the new organization period', async (t) => {
  const f = fixture(t);
  let resolve;
  f.actions.readBackground = () =>
    new Promise((r) => {
      resolve = r;
    });
  const old = f.api.loadEarlyAccess();
  f.state.account.organizationId = 'org-b';
  f.actions.readBackground = async () => ({ freeAccess: { status: 'active', remainingDays: 1 } });
  await f.api.loadEarlyAccess();
  resolve({ freeAccess: { status: 'active', remainingDays: 274 } });
  await old;
  assert.equal(f.root.textContent, 'Бесплатный доступ: остался 1 день');
});

test('ended and paid states do not invent a payment status; paid state still permits background refresh', async (t) => {
  const f = fixture(t);
  f.actions.readBackground = async () => ({ freeAccess: { status: 'ended', remainingDays: 0 } });
  await f.api.loadEarlyAccess();
  assert.equal(f.root.textContent, 'Бесплатный период завершён');
  f.actions.readBackground = async () => ({ freeAccess: null });
  await f.api.loadEarlyAccess();
  assert.equal(f.root.hidden, true);
  assert.equal(f.api.earlyAccessVisible(), true);
  f.actions.readBackground = async () => ({ freeAccess: { status: 'active', remainingDays: 2 } });
  await f.api.loadEarlyAccess({ quiet: true });
  assert.equal(f.root.hidden, false);
  assert.equal(f.root.textContent, 'Бесплатный доступ: осталось 2 дня');
});
