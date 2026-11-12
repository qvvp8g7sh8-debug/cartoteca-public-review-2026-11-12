const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
function fixture(t, width) {
  const w = new JSDOM('<main id="root"></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  w.matchMedia = () => ({ matches: width <= 700 });
  const actions = {
    esc: (x) =>
      String(x).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    canEditRecord: () => true,
    cabinetToday: () => new Date().toISOString().slice(0, 10),
    formatDate: (x) => x,
    formatMinutes: (x) => x + ' минут',
  };
  w.eval(fs.readFileSync(path.join(root, 'src/shared/appointment-status.cjs'), 'utf8'));
  Object.assign(actions, w.createAppointmentStatuses());
  actions.cabinetClock = () => ({ date: actions.cabinetToday(), hour: 12, minute: 0 });
  actions.timeLabel = (value) =>
    String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/appointment-outcomes.js'), 'utf8'));
  Object.assign(actions, w.createAppointmentOutcomes({ multiUser: true }, actions));
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/manual-confirmation.js'), 'utf8'));
  Object.assign(actions, w.createManualConfirmation({ multiUser: true }, actions));
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/appointment-panel.js'), 'utf8'));
  Object.assign(actions, w.createAppointmentPanel({}, actions));
  const result = { linked: true, bot: { connected: true }, notificationsEnabled: true },
    a = {
      appointmentId: 'a',
      date: '2030-01-01',
      time: '12:15',
      service: 'Test Procedure',
      duration: 45,
      startsAt: Date.parse('2030-01-01T12:15:00Z'),
      canRemind: true,
    };
  function render(appointments, details = result) {
    w.document.querySelector('#root').innerHTML = actions.appointmentPanelHtml(
      appointments,
      'p',
      details,
      '<span class="connection-menu">⋯</span>',
    );
    return w.document.querySelector('#root');
  }
  return { w, a, result, render, actions };
}
for (const width of [390, 1440])
  test(
    'unified appointment shows date, service and confirmation once with preserved actions at width ' +
      width,
    (t) => {
      const f = fixture(t, width),
        panel = f.render([{ ...f.a, confirmedAt: 123 }]);
      for (const value of [
        '2030-01-01 · 12:15',
        'Test Procedure',
        '45 минут',
        'Подтверждена клиентом',
      ])
        assert.equal(panel.textContent.split(value).length, 2);
      assert.equal(panel.querySelectorAll('[role="status"]').length, 1);
      assert.equal(panel.querySelector('[data-telegram-remind]'), null);
      assert.ok(panel.querySelector('[data-complete-appointment="a"]'));
      assert.ok(panel.querySelector('[data-telegram-edit="a"]'));
      assert.equal(
        panel.querySelector('[data-telegram-edit="a"]').hasAttribute('data-card-appointment'),
        false,
      );
      assert.ok(panel.querySelector('.appointment-info-heading [data-card-appointment="a"]'));
      assert.equal(panel.querySelector('h3'), null);
      assert.equal(panel.querySelector('select'), null);
    },
  );
test('all future and overdue appointments remain visible; only actionable reminders have a button', (t) => {
  const f = fixture(t, 390),
    appointments = [
      { ...f.a, appointmentId: 'past', date: '2020-01-01', startsAt: 1 },
      ...Array.from({ length: 25 }, (_, i) => ({ ...f.a, appointmentId: 'future' + i })),
    ];
  let panel = f.render(appointments);
  assert.equal(panel.querySelectorAll('[data-appointment-row]').length, 26);
  assert.match(
    panel.querySelector('[data-appointment-row="past"]').textContent,
    /Прошедшая запись/,
  );
  assert.equal(panel.querySelector('[data-telegram-remind="past"]'), null);
  assert.equal(panel.querySelectorAll('[data-telegram-remind]').length, 25);
  assert.equal(panel.querySelectorAll('.connection-menu').length, 1);
  for (const deliveryStatus of ['pending', 'sending', 'sent', 'failed']) {
    panel = f.render([{ ...f.a, deliveryStatus }]);
    assert.equal(panel.querySelector('[data-telegram-remind]'), null);
    assert.equal(panel.querySelectorAll('[role="status"]').length, 1);
  }
  for (const changes of [
    { linked: false },
    { bot: { connected: false } },
    { notificationsEnabled: false },
  ])
    assert.equal(
      f.render([f.a], { ...f.result, ...changes }).querySelector('[data-telegram-remind]'),
      null,
    );
  panel = f.render([{ ...f.a, upcoming: false }]);
  assert.equal(panel.querySelector('[data-telegram-remind]'), null);
  assert.match(panel.textContent, /Прошедшая запись/);
  panel = f.render([{ ...f.a, canRemind: false }]);
  assert.equal(panel.querySelector('button'), null);
});
test('empty panel keeps connection controls, and procedure names are plain text rather than markup', (t) => {
  const f = fixture(t, 390);
  let panel = f.render([]);
  assert.match(panel.textContent, /Создайте запись/);
  assert.equal(panel.querySelector('button'), null);
  assert.ok(panel.querySelector('.connection-menu'));
  panel = f.render([{ ...f.a, service: '<img src=x onerror=alert(1)>' }]);
  assert.equal(panel.querySelector('img'), null);
  assert.match(panel.textContent, /<img src=x/);
});
test('delivery-ready appointment opens before connection details without an obsolete delivery selector', (t) => {
  const f = fixture(t, 390);
  f.actions.request = () => {
    throw Error('Rendering an appointment must not request a delivery preference');
  };
  const a = { ...f.a, deliveryReady: true, deliveryChannel: 'max' };
  let panel = f.render([a], null);
  assert.ok(panel.querySelector('[data-appointment-row="a"]'));
  assert.equal(panel.querySelector('[data-telegram-remind]'), null);
  assert.equal(panel.querySelector('.appointment-delivery-actions'), null);
  assert.equal(panel.querySelector('select'), null);
  assert.ok(panel.querySelector('.telegram-strip-tools'));
  panel = f.render([a]);
  assert.ok(panel.querySelector('[data-telegram-remind="a"]'));
  assert.equal(panel.querySelector('[data-delivery-preference]'), null);
  assert.equal(panel.querySelector('select'), null);
});
