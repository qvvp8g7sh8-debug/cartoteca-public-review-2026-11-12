const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/booking-health.js'),
  'utf8',
);
const issue = {
  code: 'no_working_days',
  title: 'Нет открытых рабочих дней',
  message: 'Настройте график',
  target: 'schedule',
};
function fixture(t) {
  const w = new JSDOM(
    '<button data-view="settings"><span data-booking-health-count hidden></span></button><details><summary><span data-booking-health-count hidden></span></summary><div data-booking-health-panel hidden></div><input id="draft" value="unsaved"></details>',
    { runScripts: 'outside-only', pretendToBeVisual: true },
  ).window;
  t.after(() => w.close());
  w.eval(source);
  const state = { multiUser: true, account: { id: 'a', organizationId: 'o', role: 'owner' } };
  const value = { canManage: true, enabled: true, available: false, issues: [issue], checkedAt: 1 };
  let read = async () => structuredClone(value),
    calls = 0;
  const actions = {
    $: (s) => w.document.querySelector(s),
    esc: (v) =>
      String(v).replace(
        /[<>&"]/g,
        (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
      ),
    canManageTeam: () => state.account.role !== 'cosmetologist',
    syncBookingPublication: () => {},
    readBackground: () => {
      calls++;
      return read();
    },
  };
  const api = w.eval('createBookingHealth')(state, actions);
  return {
    w,
    state,
    value,
    api,
    setRead(fn) {
      read = fn;
    },
    get calls() {
      return calls;
    },
  };
}
test('both badges show issues and clear automatically; unchanged reads retain focused actions and drafts', async (t) => {
  const f = fixture(t);
  await f.api.refreshBookingHealth({ force: true });
  const badges = [...f.w.document.querySelectorAll('[data-booking-health-count]')];
  assert.ok(badges.every((b) => !b.hidden && b.textContent === '1'));
  const action = f.w.document.querySelector('[data-management-tab]');
  action.focus();
  await f.api.refreshBookingHealth({ force: true });
  assert.equal(f.w.document.activeElement, action);
  assert.equal(f.w.document.querySelector('#draft').value, 'unsaved');
  f.value.available = true;
  f.value.issues = [];
  await f.api.refreshBookingHealth({ force: true });
  assert.ok(badges.every((b) => b.hidden));
  assert.equal(f.value.enabled, true);
  f.value.enabled = false;
  await f.api.refreshBookingHealth({ force: true });
  assert.equal(f.w.document.querySelector('[data-booking-health-panel]').hidden, true);
});
test('network failures preserve warnings, back off and escape diagnostic content', async (t) => {
  const f = fixture(t);
  f.value.issues[0] = { ...issue, title: '<img src=x>', message: '<script>x</script>' };
  await f.api.refreshBookingHealth({ force: true });
  assert.equal(f.w.document.querySelector('img,script'), null);
  f.setRead(async () => {
    throw Error('offline');
  });
  await f.api.refreshBookingHealth({ force: true });
  const badge = f.w.document.querySelector('[data-booking-health-count]');
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '1');
  assert.equal(f.api.bookingHealthInterval(), 60000);
  assert.match(
    f.w.document.querySelector('[data-booking-health-panel]').textContent,
    /Повторим автоматически/,
  );
});

test('automatic disable keeps warning; restored schedule requires manual activation', async (t) => {
  const f = fixture(t);
  f.value.enabled = false;
  f.value.disabledReason = 'no_working_days';
  await f.api.refreshBookingHealth({ force: true });
  const badge = f.w.document.querySelector('[data-booking-health-count]');
  assert.equal(badge.hidden, false);
  assert.match(
    f.w.document.querySelector('[data-booking-health-panel]').textContent,
    /выключена автоматически/,
  );
  f.value.issues = [
    {
      code: 'awaiting_activation',
      title: 'Включите запись',
      message: 'Вручную',
      target: 'publication',
    },
  ];
  await f.api.refreshBookingHealth({ force: true });
  assert.equal(badge.hidden, false);
  assert.ok(f.w.document.querySelector('[data-booking-health-target="publication"]'));
  assert.equal(f.value.enabled, false);
});
test('late responses cannot cross accounts and employees do not poll organization warnings', async (t) => {
  const f = fixture(t);
  let resolve;
  f.setRead(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = f.api.refreshBookingHealth();
  assert.equal(f.api.refreshBookingHealth(), pending);
  await Promise.resolve();
  f.state.account = { id: 'b', organizationId: 'another', role: 'cosmetologist' };
  resolve(f.value);
  await pending;
  await f.api.refreshBookingHealth({ force: true });
  assert.equal(f.calls, 1);
  assert.equal(f.w.document.querySelector('[data-booking-health-count]').hidden, true);
  assert.equal(f.w.document.querySelector('[data-booking-health-panel]').hidden, true);
});
