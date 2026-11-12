const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { setTimeout: delay } = require('node:timers/promises');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/notification-history.js'),
  'utf8',
);
async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  throw Error('History UI timeout');
}
function fixture(t, patientId = 'p', appointmentId = 'a') {
  const w = new JSDOM('<main></main>', {
    runScripts: 'outside-only',
    url: 'https://synthetic.test/',
  }).window;
  t.after(() => w.close());
  w.eval(source);
  const state = { account: { id: 'staff', organizationId: 'org' }, timeZone: 'Europe/Moscow' },
    calls = [];
  const actions = {
    esc: (value) =>
      String(value).replace(
        /[&<>"']/g,
        (character) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
      ),
    request: (url) => new Promise((resolve, reject) => calls.push({ url, resolve, reject })),
  };
  const ui = w.eval('createNotificationHistory')(state, actions);
  const host = w.document.querySelector('main');
  host.innerHTML = ui.notificationHistoryHtml(patientId, appointmentId);
  ui.bindNotificationHistoryEvents();
  return { w, state, ui, host, calls, section: host.querySelector('details') };
}

test('history details load lazily, coalesce pending opens and distinguish accepted from client/staff confirmation', async (t) => {
  const f = fixture(t),
    content = f.section.querySelector('[data-notification-history-content]');
  await delay(10);
  assert.equal(f.calls.length, 0);
  f.section.open = true;
  await until(() => f.calls.length === 1);
  f.section.dispatchEvent(new f.w.Event('toggle'));
  assert.equal(f.calls.length, 1);
  const url = new URL(f.calls[0].url, 'https://synthetic.test/');
  assert.equal(url.pathname, '/api/notifications/history');
  assert.equal(url.searchParams.get('patientId'), 'p');
  assert.equal(url.searchParams.get('appointmentId'), 'a');
  f.calls[0].resolve({
    limited: true,
    items: [
      { kind: 'reminder', channel: 'telegram', status: 'accepted', acceptedAt: 1900000000000 },
      {
        kind: 'confirmation',
        channel: 'max',
        status: 'client-confirmed',
        confirmedAt: 1900000001000,
      },
      {
        kind: 'confirmation',
        channel: 'manual',
        status: 'staff-confirmed',
        confirmedAt: 1900000002000,
      },
      { kind: 'moved', channel: 'max', status: 'unknown', createdAt: null },
    ],
  });
  await until(() => content.querySelectorAll('li').length === 4);
  assert.match(content.textContent, /Принято сервисом/);
  assert.match(content.textContent, /Клиент подтвердил/);
  const manual = [...content.querySelectorAll('li')].find((row) =>
    row.textContent.includes('Подтверждено сотрудником'),
  );
  assert.ok(manual);
  assert.doesNotMatch(manual.querySelector('strong').textContent, /клиента/i);
  assert.match(content.textContent, /Результат неизвестен|Время не сохранено/);
  assert.match(content.textContent, /доступная часть истории/);
  assert.match(content.textContent, /не подтверждает его прочтение/);
});

for (const scope of ['organization', 'account', 'closed', 'detached'])
  test('pending history cannot render after ' + scope + ' changes', async (t) => {
    const f = fixture(t);
    f.section.open = true;
    await until(() => f.calls.length === 1);
    if (scope === 'organization') f.state.account.organizationId = 'other-org';
    if (scope === 'account') f.state.account = { id: 'other-staff', organizationId: 'org' };
    if (scope === 'closed') f.section.open = false;
    if (scope === 'detached') f.host.replaceChildren();
    f.calls[0].resolve({
      limited: false,
      items: [{ kind: 'created', channel: 'telegram', status: 'accepted' }],
    });
    await delay(10);
    assert.equal(f.section.querySelector('li'), null);
    assert.doesNotMatch(f.host.textContent, /Принято сервисом/);
  });

test('history identifiers and error content are escaped, retry is explicit and unknown labels stay inert', async (t) => {
  const patient = 'p" onclick="evil<svg>',
    appointment = 'a&other=1';
  const f = fixture(t, patient, appointment);
  assert.equal(f.section.dataset.patientId, patient);
  assert.equal(f.section.dataset.notificationAppointmentId, appointment);
  assert.equal(f.section.hasAttribute('onclick'), false);
  f.section.open = true;
  await until(() => f.calls.length === 1);
  assert.equal(
    new URL(f.calls[0].url, 'https://synthetic.test/').searchParams.get('patientId'),
    patient,
  );
  f.calls[0].reject(Error('Synthetic <img src=x onerror=evil()>'));
  await until(() => f.section.querySelector('[data-notification-history-retry]'));
  assert.match(f.section.textContent, /Synthetic <img/);
  assert.equal(f.section.querySelector('img'), null);
  f.section.querySelector('[data-notification-history-retry]').click();
  await until(() => f.calls.length === 2);
  f.calls[1].resolve({
    limited: false,
    items: [{ kind: '<svg onload=evil()>', channel: '<img>', status: '<script>', createdAt: null }],
  });
  await until(() => f.section.querySelector('li'));
  assert.equal(f.section.querySelector('svg,img,script'), null);
  assert.match(
    f.section.textContent,
    /Уведомление|Картотека|Состояние уточняется|Время не сохранено/,
  );
});

test('empty history shows a factual empty state and refreshes only after explicit user action', async (t) => {
  const f = fixture(t);
  f.section.open = true;
  await until(() => f.calls.length === 1);
  f.calls[0].resolve({ items: [], limited: false });
  await until(() => f.section.textContent.includes('История отправок пока пуста'));
  assert.equal(f.section.querySelector('ul'), null);
  assert.equal(f.calls.length, 1);
  f.section.querySelector('[data-notification-history-retry]').click();
  await until(() => f.calls.length === 2);
  f.calls[1].resolve({ items: [], limited: false });
  await delay(5);
  assert.equal(f.w.localStorage.length, 0);
});

test('history summary and retry never enter the actual calendar click dispatcher while a real calendar record still opens', async (t) => {
  const f = fixture(t),
    opened = [];
  Object.assign(f.state, {
    currentView: 'calendar',
    lazyReads: false,
    data: [
      { id: 'p', appointments: [{ id: 'a', date: '2030-01-02', time: '14:30', duration: 30 }] },
    ],
  });
  f.w.document.body.insertAdjacentHTML(
    'beforeend',
    '<section id="global-view"><button id="synthetic-calendar-record" data-calendar-patient="p" data-appointment-id="a">Запись календаря</button></section><input id="search"><form id="editor-form"><div id="form-content"></div></form><div id="client-filters"></div><div class="name-sort"></div>',
  );
  const actions = new Proxy(
    {
      $: (selector) => f.w.document.querySelector(selector),
      handleCalendarLoadNavigation: () => false,
      handleCalendarLoadClick: () => false,
      openAppointmentActions: (record) => opened.push(record),
      renderList() {},
      submit() {},
      rollback() {},
      toast: (message) => assert.fail(message),
    },
    {
      get(target, key) {
        if (typeof key === 'string' && key.startsWith('bind')) return () => {};
        return target[key];
      },
    },
  );
  f.w.eval(fs.readFileSync(path.join(__dirname, '../src/client/core/events.js'), 'utf8'));
  f.w.eval('bindEvents')(f.state, actions);
  f.section.querySelector('summary').click();
  await until(() => f.calls.length === 1);
  assert.equal(opened.length, 0, 'History summary must not open the appointment inspector');
  const url = new URL(f.calls[0].url, 'https://synthetic.test/');
  assert.equal(url.searchParams.get('patientId'), 'p');
  assert.equal(url.searchParams.get('appointmentId'), 'a');
  f.calls[0].resolve({ items: [], limited: false });
  await until(() => f.section.querySelector('[data-notification-history-retry]'));
  f.section.querySelector('[data-notification-history-retry]').click();
  await until(() => f.calls.length === 2);
  assert.equal(opened.length, 0, 'History retry must not reopen its inspector');
  f.calls[1].resolve({ items: [], limited: false });
  await delay(5);
  f.w.document.querySelector('#synthetic-calendar-record').click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, 'a');
});
