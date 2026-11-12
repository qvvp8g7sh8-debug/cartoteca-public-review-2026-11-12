const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom'),
  { setTimeout: delay } = require('node:timers/promises');
const source = (file) => fs.readFileSync(path.join(__dirname, '../src/client/' + file), 'utf8');
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error('UI timeout');
};
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const record = {
  id: 'r',
  revision: 0,
  status: 'requested',
  kind: 'other-time',
  firstName: 'Synthetic',
  phone: '+79990000000',
  date: '2030-01-01',
  time: '09:00',
  duration: 30,
  staffId: 'a',
  services: [{ name: 'Synthetic service' }],
};
function internal(t, width) {
  const w = new JSDOM(
    '<section id="booking-requests-panel"><div data-booking-request-content></div><p data-booking-request-message></p></section>',
    { url: 'http://localhost/', runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  Object.defineProperty(w, 'innerWidth', { value: width });
  w.eval(source('modules/booking-time.js'));
  w.eval(source('modules/booking-requests.js'));
  w.eval(source('modules/booking-request-view.js'));
  const state = { account: { id: 'a', organizationId: 'o' }, currentView: 'services', busy: false };
  const calls = [],
    actions = {
      esc,
      $: (s) => w.document.querySelector(s),
      formatDate: (v) => v,
      formatMinutes: (v) => v + ' мин',
      invalidateDirectory() {},
      invalidateCalendarRead() {},
      request: async (url, options) => {
        calls.push({ url, body: options && JSON.parse(options.body) });
        if (url.includes('/contacts')) return { items: [], needsAdministrator: false };
        if (url.endsWith('time-options')) return { times: ['10:00', '11:00'] };
        if (url.endsWith('accept'))
          return {
            ...record,
            revision: 1,
            status: 'accepted',
            date: JSON.parse(options.body).date,
            time: JSON.parse(options.body).time,
          };
        return { items: [record], cursor: null };
      },
    };
  Object.assign(actions, w.eval('createBookingTime')(state, actions));
  Object.assign(actions, w.eval('createBookingRequestView')(state, actions));
  w.eval(source('modules/booking-request-list.js'));
  Object.assign(
    actions,
    {
      readBackground: (url) => actions.request(url),
      renderBookingInbox() {},
      refreshBookingInbox: async () => {},
    },
    w.eval('createBookingRequestList')(state, actions),
  );
  w.eval('createBookingRequests')(state, actions).mountBookingRequests({
    canManage: true,
    members: [],
  });
  return { w, state, actions, calls };
}
for (const width of [390, 1440])
  test(
    'manager chooses a real time, accepts once and removes the processed request at ' + width,
    async (t) => {
      const f = internal(t, width);
      await until(() => f.actions.$('[data-booking-request-action=choose]'));
      f.actions.$('[data-booking-request-action=choose]').click();
      await until(() => f.actions.$('[data-request-time="10:00"]'));
      assert.match(f.w.document.body.textContent, /согласованное с клиентом/);
      f.actions.$('[data-request-time="10:00"]').click();
      f.actions.$('[data-request-time-save]').click();
      f.actions.$('[data-request-time-save]').click();
      await until(() => !f.state.busy && !f.actions.$('.booking-request'));
      assert.match(f.actions.$('[data-booking-request-message]').textContent, /Запись добавлена/);
      assert.equal(f.actions.$('[data-proposal-link]'), null);
      assert.equal(f.calls.filter((c) => c.url.endsWith('/accept')).length, 1);
      assert.deepEqual(f.calls.at(-1).body, {
        id: 'r',
        revision: 0,
        date: '2030-01-01',
        time: '10:00',
      });
    },
  );
test('date input refreshes once and a delayed Safari change does not reset a selected time', async (t) => {
  const f = internal(t, 390);
  await until(() => f.actions.$('[data-booking-request-action=choose]'));
  f.actions.$('[data-booking-request-action=choose]').click();
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  const input = f.actions.$('[data-request-date]');
  input.value = '2030-01-02';
  input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  f.actions.$('[data-request-time="10:00"]').click();
  input.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  await delay(20);
  assert.equal(f.actions.$('[data-request-time-save]').disabled, false);
  assert.equal(f.actions.$('[data-request-time="10:00"]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.calls.filter((c) => c.url.endsWith('/time-options')).length, 2);
  f.actions.$('[data-request-time-save]').click();
  await until(() => !f.state.busy && !f.actions.$('.booking-request'));
  assert.equal(f.calls.at(-1).body.date, '2030-01-02');
});
test('unknown chosen-time acceptance freezes its payload for retry and ignores a switched organization', async (t) => {
  const f = internal(t, 390);
  await until(() => f.actions.$('[data-booking-request-action=choose]'));
  f.actions.$('[data-booking-request-action=choose]').click();
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  f.actions.$('[data-request-time="10:00"]').click();
  const bodies = [];
  f.actions.request = async (url, options) => {
    bodies.push(options.body);
    throw Error('Synthetic lost response');
  };
  f.actions.$('[data-request-time-save]').click();
  await until(() => !f.state.busy);
  assert.equal(f.actions.$('[data-request-date]').disabled, true);
  f.actions.$('[data-request-time-save]').click();
  await until(() => !f.state.busy && bodies.length === 2);
  assert.equal(bodies[0], bodies[1]);
  let resolve;
  f.actions.request = () => new Promise((r) => (resolve = r));
  f.actions.$('[data-request-time-save]').click();
  f.state.account.organizationId = 'other';
  resolve({ ...record, status: 'accepted' });
  await until(() => !f.state.busy);
  assert.ok(f.actions.$('.booking-request'));
});
test('manager can reload time after a date change fails, without closing the editor', async (t) => {
  const f = internal(t, 390);
  await until(() => f.actions.$('[data-booking-request-action=choose]'));
  f.actions.$('[data-booking-request-action=choose]').click();
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  const original = f.actions.request;
  let fail = true;
  f.actions.request = async (url, options) => {
    if (url.endsWith('time-options') && fail) throw Error('Synthetic time loading failure');
    return original(url, options);
  };
  const input = f.actions.$('[data-request-date]');
  input.value = '2030-01-02';
  input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  await until(
    () => f.actions.$('[data-request-time-refresh]').textContent === 'Повторить загрузку',
  );
  assert.equal(f.actions.$('[data-request-time-save]').disabled, true);
  assert.equal(f.actions.$('[data-request-time-refresh]').disabled, false);
  fail = false;
  f.actions.$('[data-request-time-refresh]').click();
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  f.actions.$('[data-request-time="10:00"]').click();
  input.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  await delay(10);
  assert.equal(f.actions.$('[data-request-time-save]').disabled, false);
  f.actions.$('[data-request-time-save]').click();
  await until(() => !f.state.busy && !f.actions.$('.booking-request'));
  assert.equal(f.calls.at(-1).body.date, '2030-01-02');
});
test('empty date clears old time and stale availability cannot overwrite the new day', async (t) => {
  const f = internal(t, 390);
  await until(() => f.actions.$('[data-booking-request-action=choose]'));
  f.actions.$('[data-booking-request-action=choose]').click();
  await until(() => f.actions.$('[data-request-time="10:00"]'));
  const input = f.actions.$('[data-request-date]');
  const calls = f.calls.length;
  input.value = '';
  input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  assert.equal(f.calls.length, calls);
  assert.equal(f.actions.$('[data-request-time-save]').disabled, true);
  assert.equal(f.actions.$('[data-request-time-refresh]').disabled, true);
  let oldReply;
  f.actions.request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.date === '2030-01-02')
      return new Promise((resolve) => {
        oldReply = resolve;
      });
    return { times: ['12:00'] };
  };
  input.value = '2030-01-02';
  input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  input.value = '2030-01-03';
  input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  await until(() => f.actions.$('[data-request-time="12:00"]'));
  f.actions.$('[data-request-time="12:00"]').click();
  oldReply({ times: ['09:00'] });
  await delay(10);
  assert.equal(f.actions.$('[data-request-time="09:00"]'), null);
  assert.equal(f.actions.$('[data-request-time="12:00"]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.actions.$('[data-request-time-save]').disabled, false);
});
function publicReply(t, width) {
  const w = new JSDOM('<main></main>', {
    url: 'http://localhost/booking.html#reply=synthetic-secret',
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  Object.defineProperty(w, 'innerWidth', { value: width });
  w.eval(source('public/reply.js'));
  const info = {
    organization: { name: '<img src=x onerror=evil>' },
    staff: { name: 'Synthetic specialist', specialty: 'Synthetic profession' },
    date: '2030-01-01',
    time: '10:00',
    duration: 30,
    services: [{ name: '<script>evil</script>' }],
    state: 'waiting',
  };
  const calls = [];
  let fail = false;
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('proposal-response') && fail) throw Error('Synthetic lost reply');
    return url.endsWith('proposal-response') ? { ...info, state: 'agreed' } : info;
  };
  const root = w.document.querySelector('main');
  const page = w.eval('createBookingReplyPage')(root, request);
  return {
    w,
    root,
    page,
    calls,
    setFail: (v) => {
      fail = v;
    },
  };
}
for (const width of [390, 1440])
  test(
    'a full day offers hours and at most four exact times without show-more clicks at ' + width,
    async (t) => {
      const f = internal(t, width);
      await until(() => f.actions.$('[data-booking-request-action=choose]'));
      const original = f.actions.request;
      f.actions.request = async (url, options) =>
        url.endsWith('time-options')
          ? {
              times: Array.from(
                { length: 96 },
                (_, i) =>
                  String(Math.floor(i / 4)).padStart(2, '0') +
                  ':' +
                  String((i % 4) * 15).padStart(2, '0'),
              ),
            }
          : original(url, options);
      f.actions.$('[data-booking-request-action=choose]').click();
      await until(() => f.actions.$('[data-request-hour="23"]'));
      assert.equal(f.actions.$('[data-request-more-times]'), null);
      assert.equal(f.actions.$('[data-booking-request-refresh]'), null);
      assert.equal(f.w.document.querySelectorAll('[data-request-time]').length, 4);
      assert.equal(f.actions.$('[data-request-time-save]').disabled, true);
      f.actions.$('[data-request-hour="23"]').click();
      assert.deepEqual(
        [...f.w.document.querySelectorAll('[data-request-time]')].map((b) => b.dataset.requestTime),
        ['23:00', '23:15', '23:30', '23:45'],
      );
      f.actions.$('[data-request-time="23:30"]').click();
      assert.equal(f.actions.$('[data-request-time-save]').disabled, false);
      f.actions.$('[data-request-hour="00"]').click();
      assert.equal(f.actions.$('[data-request-time-save]').disabled, true);
    },
  );
for (const width of [390, 1440])
  test(
    'public confirmation is explicit, escapes text and does not claim a final appointment at ' +
      width,
    async (t) => {
      const f = publicReply(t, width);
      await f.page.initialize();
      assert.equal(f.root.querySelectorAll('img,script').length, 0);
      assert.match(f.root.textContent, /Время не резервируется/);
      f.root.querySelector('[data-reply=agree]').click();
      await until(() => !f.root.querySelector('[data-reply]'));
      assert.match(f.root.textContent, /Организация завершит оформление/);
      assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), {
        secret: 'synthetic-secret',
        decision: 'agree',
      });
      assert.equal(f.calls.at(-1).url.includes('synthetic-secret'), false);
    },
  );
test('unknown client reply permits only an identical retry, never the opposite decision', async (t) => {
  const f = publicReply(t, 390);
  await f.page.initialize();
  f.setFail(true);
  f.root.querySelector('[data-reply=agree]').click();
  await until(() => !f.root.querySelector('[data-reply=agree]').disabled);
  assert.equal(f.root.querySelector('[data-reply=decline]').disabled, true);
  f.root.querySelector('[data-reply=agree]').click();
  await until(() => f.calls.length === 3 && !f.root.querySelector('[data-reply=agree]').disabled);
  assert.equal(f.calls[1].options.body, f.calls[2].options.body);
  f.setFail(false);
  f.root.querySelector('[data-reply=agree]').click();
  await until(() => !f.root.querySelector('[data-reply]'));
});
