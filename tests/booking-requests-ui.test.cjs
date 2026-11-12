const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom'),
  { setTimeout: delay } = require('node:timers/promises');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/booking-requests.js'),
  'utf8',
);
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error('UI timeout');
};
function fixture(t, manage = true) {
  const w = new JSDOM(
    '<section id="booking-requests-panel"><div data-booking-request-content></div><p data-booking-request-message></p></section>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.eval(source);
  w.confirm = () => true;
  w.eval(
    fs.readFileSync(path.join(__dirname, '../src/client/modules/booking-request-view.js'), 'utf8'),
  );
  const state = { account: { id: 'a', organizationId: 'o' }, currentView: 'services', busy: false };
  const record = {
    id: 'request',
    revision: 0,
    status: 'pending',
    firstName: '<script>evil</script>',
    lastName: 'Test',
    phone: '+79990000000',
    date: '2030-01-01',
    time: '09:00',
    duration: 30,
    staffId: 'a',
    services: [{ name: 'Test' }],
    comment: '<img src=x onerror=evil>',
  };
  let calls = [],
    invalidated = 0;
  const actions = {
    $: (s) => w.document.querySelector(s),
    esc: (v) =>
      String(v).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    formatDate: (v) => v,
    formatMinutes: (v) => v + ' мин',
    invalidateCalendarRead: () => invalidated++,
    invalidateDirectory: () => invalidated++,
    request: async (url, options) => {
      calls.push({ url, options });
      return options
        ? { ...record, status: 'accepted', revision: 1 }
        : { items: [record], cursor: null };
    },
  };
  Object.assign(actions, w.eval('createBookingRequestView')(state, actions));
  w.eval(
    fs.readFileSync(path.join(__dirname, '../src/client/modules/booking-request-list.js'), 'utf8'),
  );
  Object.assign(
    actions,
    {
      readBackground: (url) => actions.request(url),
      renderBookingInbox() {},
      refreshBookingInbox: async () => {},
    },
    w.eval('createBookingRequestList')(state, actions),
  );
  const module = w.eval('createBookingRequests')(state, actions);
  Object.assign(actions, module);
  module.mountBookingRequests({
    canManage: manage,
    canManageOwnRequests: manage,
    members: [{ accountId: 'a', displayName: 'Test staff' }],
  });
  return {
    w,
    state,
    actions,
    calls,
    get invalidated() {
      return invalidated;
    },
  };
}
for (const width of [390, 1440])
  test('request panel escapes contact data and accepts once at ' + width, async (t) => {
    const f = fixture(t);
    Object.defineProperty(f.w, 'innerWidth', { value: width });
    await until(() => f.actions.$('[data-booking-request-action=accept]'));
    assert.equal(f.w.document.querySelectorAll('script,img').length, 0);
    const button = f.actions.$('[data-booking-request-action=accept]');
    button.click();
    button.click();
    await until(() => !f.state.busy && f.calls.length === 3);
    assert.equal(f.invalidated, 2);
    assert.equal(f.actions.$('[data-booking-request-action=accept]'), null);
    assert.match(
      f.actions.$('[data-booking-request-message]').textContent,
      /добавлена в календарь/,
    );
    assert.deepEqual(JSON.parse(f.calls[2].options.body), {
      id: 'request',
      revision: 0,
      date: '2030-01-01',
      time: '09:00',
    });
    assert.equal(f.actions.$('.booking-request'), null);
  });
test('read-only staff has no commands and a stale response never renders another organization', async (t) => {
  const f = fixture(t, false);
  await until(() => f.calls.length === 1);
  await delay(10);
  assert.equal(f.actions.$('[data-booking-request-action]'), null);
  let resolve;
  f.actions.request = () => new Promise((r) => (resolve = r));
  const loading = f.actions.refreshBookingRequests({ version: 'changed' });
  await until(() => resolve);
  f.state.account.organizationId = 'other';
  resolve({ items: [], cursor: null });
  await loading;
  assert.match(f.actions.$('[data-booking-request-content]').textContent, /evil/);
});
test('unknown acceptance result shows an error, keeps retry available and does not invent success', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-booking-request-action=accept]'));
  f.actions.request = async () => {
    throw Error('Synthetic network timeout');
  };
  f.actions.$('[data-booking-request-action=accept]').click();
  await until(() => !f.state.busy);
  assert.match(f.actions.$('[data-booking-request-message]').textContent, /network timeout/);
  assert.equal(f.invalidated, 0);
  assert.equal(f.actions.$('[data-booking-request-action=accept]').disabled, false);
});
test('ambiguous contact requires an explicit choice and never automatically merges cards', async (t) => {
  const f = fixture(t);
  await until(() => f.actions.$('[data-booking-request-action=accept]'));
  let accepted;
  f.actions.request = async (url, options) => {
    if (!options)
      return {
        needsAdministrator: false,
        items: [
          { id: 'p1', name: 'First', phone: '+79990000000' },
          { id: 'p2', name: 'Second', phone: '89990000000' },
        ],
      };
    accepted = JSON.parse(options.body);
    return {
      id: 'request',
      revision: 1,
      status: 'accepted',
      firstName: 'Test',
      lastName: '',
      phone: '+79990000000',
      date: '2030-01-01',
      time: '09:00',
      duration: 30,
      staffId: 'a',
      services: [{ name: 'Test' }],
    };
  };
  f.actions.$('[data-booking-request-action=accept]').click();
  await until(() => !f.state.busy && f.actions.$('[data-booking-contact]'));
  assert.equal(accepted, undefined);
  f.actions.$('[data-booking-request-action=accept]').click();
  await until(() => !f.state.busy);
  assert.equal(accepted, undefined);
  f.actions.$('[data-booking-contact]').value = 'p2';
  f.actions.$('[data-booking-request-action=accept]').click();
  await until(() => !f.state.busy && accepted);
  assert.equal(accepted.patientId, 'p2');
  assert.equal(f.invalidated, 2);
});
