const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const postcss = require('postcss');
const project = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(project, name), 'utf8');

function fixture(t, multiUser = true) {
  const window = new JSDOM(
    '<main class="workspace workspace-designed card-mode"><section class="detail" id="detail"></section></main>',
    {
      runScripts: 'outside-only',
      url: 'http://synthetic.test',
    },
  ).window;
  t.after(() => window.close());
  window.structuredClone = structuredClone;
  const patient = {
    id: 'synthetic-patient',
    name: 'Клиент Демонстрационный',
    phone: '+79000000000',
    visits: Array.from({ length: 7 }, (_, i) => ({
      id: `visit-${i}`,
      date: '2026-09-01',
      procedure: `Процедура ${i}`,
      photos: [],
    })),
    appointments: Array.from({ length: 12 }, (_, i) => ({
      id: `appointment-${i}`,
      date: i ? '2026-10-14' : '2026-10-12',
      time: '12:00',
      duration: 60,
      service: `Демонстрационная услуга ${i}`,
      status: 'scheduled',
      staffId: 'staff',
      confirmationKey: `synthetic-key-${i}`,
    })),
  };
  patient.appointments.push(
    {
      id: 'completed',
      date: '2026-09-01',
      time: '10:00',
      service: 'Проведённая процедура',
      status: 'completed',
      completedVisitId: 'visit-0',
    },
    {
      id: 'cancelled',
      date: '2026-10-10',
      time: '11:00',
      service: 'Отменённая процедура',
      status: 'cancelled',
    },
    {
      id: 'no-show',
      date: '2026-10-11',
      time: '12:00',
      service: 'Пропущенная процедура',
      status: 'no_show',
    },
  );
  patient.visits[0].appointmentId = 'completed';
  const state = {
    multiUser,
    account: { id: 'owner', organizationId: 'synthetic-org' },
    currentView: 'card',
    activeTab: 'visits',
    selectedId: patient.id,
    data: [patient],
    uploadItems: [],
    editorMode: {},
  };
  const actions = {
    $: (selector) => window.document.querySelector(selector),
    patient: () => patient,
    viewPatient: () => patient,
    patientView: () => null,
    esc: (value) =>
      String(value).replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
      ),
    formatDate: (value) => value,
    formatPhone: (value) => value,
    formatMinutes: (value) => `${value} мин`,
    plural: () => 'записей',
    canEditPatient: () => true,
    canEditRecord: () => true,
    patientMarkHtml: () => '',
    videoConsentHtml: () => '',
    patientConnectionsHtml: () =>
      '<details class="patient-connections"><summary>Уведомления</summary></details>',
    invalidatePrint: () => {},
    printablePatient: () => false,
    buildPrintCard: () => {},
    loadPatientTelegram: () => {},
    cabinetToday: () => '2026-10-13',
    cabinetClock: () => ({ date: '2026-10-13', hour: 12, minute: 0 }),
    timeLabel: () => '12:00',
    validateVisitDuration: () => '',
    accountId: () => 'owner',
    save: async () => {},
    closeEditor: () => {},
    parseDate: (value) => new Date(value),
    setView: (view) => {
      state.currentView = view;
    },
    toast: () => {},
  };
  window.eval(source('src/shared/appointment-status.cjs'));
  Object.assign(actions, window.createAppointmentStatuses());
  for (const [module, factory] of [
    ['manual-confirmation', 'createManualConfirmation'],
    ['appointment-outcomes', 'createAppointmentOutcomes'],
    ['appointments', 'createAppointments'],
    ['appointment-panel', 'createAppointmentPanel'],
    ['visit-save', 'createVisitSave'],
    ['card', 'createCard'],
  ]) {
    window.eval(source(`src/client/modules/${module}.js`));
    Object.assign(actions, window[factory](state, actions));
  }
  return { window, patient, state, actions, $: actions.$ };
}

test('card keeps every upcoming and unprocessed appointment in one keyboard-accessible list above its tabs', (t) => {
  const f = fixture(t),
    before = JSON.stringify(f.patient);
  f.actions.renderDetail();
  const list = f.$('.patient-appointments-list');
  assert.equal(list.tabIndex, 0);
  assert.equal(list.getAttribute('role'), 'region');
  assert.match(list.getAttribute('aria-label'), /прокручиваемый список/);
  assert.equal(list.querySelectorAll('[data-appointment-row]').length, 12);
  assert.equal(f.$('.patient-appointments-count').textContent, '12');
  assert.ok(list.compareDocumentPosition(f.$('.tabs')) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(
    list.querySelector('[data-appointment-row="appointment-0"]').textContent,
    /Прошедшая запись/,
  );
  for (const attribute of [
    'data-complete-appointment',
    'data-telegram-edit',
    'data-card-appointment',
  ])
    assert.equal(list.querySelectorAll(`[${attribute}]`).length, 12);
  assert.equal(list.querySelectorAll('[data-appointment-outcome="cancelled"]').length, 12);
  assert.equal(list.querySelectorAll('[data-appointment-outcome="no_show"]').length, 1);
  assert.equal(list.querySelectorAll('[data-manual-confirm]').length, 11);
  for (const closed of ['completed', 'cancelled', 'no-show'])
    assert.equal(list.querySelector(`[data-appointment-row="${closed}"]`), null);
  assert.equal(JSON.stringify(f.patient), before);
});

test('read-only appointment rows preserve content and do not acquire editing controls', (t) => {
  const f = fixture(t);
  f.actions.canEditRecord = () => false;
  f.actions.canEditPatient = () => false;
  f.actions.renderDetail();
  const list = f.$('.patient-appointments-list');
  assert.equal(list.querySelectorAll('[data-appointment-row]').length, 12);
  assert.equal(list.querySelector('button'), null);
  assert.match(list.textContent, /Демонстрационная услуга 11/);
});

test('local appointment rendering retains its controls inside the same scroll region', (t) => {
  const f = fixture(t, false);
  f.actions.renderDetail();
  const list = f.$('.patient-appointments-list');
  assert.equal(list.tabIndex, 0);
  assert.equal(list.querySelectorAll('.patient-appointment-row').length, 12);
  assert.equal(list.querySelectorAll('[data-complete-appointment]').length, 12);
  assert.equal(list.querySelector('[data-card-appointment="completed"]'), null);
  assert.ok(list.compareDocumentPosition(f.$('.tabs')) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
});

test('walk-in action precedes history content in populated and empty states, with original action ids', (t) => {
  const f = fixture(t);
  f.actions.renderDetail();
  assert.equal(f.$('.visit-history-heading').firstElementChild.id, 'new-visit');
  assert.match(f.$('#new-visit').textContent, /Добавить посещение без записи/);
  assert.equal(f.$('#visit-history-list').children.length, 5);
  f.actions.showMoreVisits();
  assert.equal(f.$('#visit-history-list').children.length, 9);
  f.patient.visits = [];
  f.patient.appointments = [];
  f.actions.renderDetail();
  assert.equal(f.$('#tab-content .empty').firstElementChild.id, 'empty-new');
  assert.equal(f.$('#tab-content').querySelectorAll('.visit-add-action').length, 1);
});

test('completing a visit removes only the active row and retains the original appointment and history link', async (t) => {
  const f = fixture(t),
    appointment = f.patient.appointments[1];
  const appointmentCount = f.patient.appointments.length,
    visitCount = f.patient.visits.length;
  f.state.editorMode = { patientId: f.patient.id, appointmentId: appointment.id, serviceItems: [] };
  await f.actions.saveVisitForm({
    date: appointment.date,
    time: appointment.time,
    duration: '60',
    procedure: appointment.service,
    notes: 'Синтетическое посещение',
  });
  assert.equal(f.patient.appointments.length, appointmentCount);
  assert.equal(f.patient.appointments[1], appointment);
  assert.equal(appointment.status, 'completed');
  const visit = f.patient.visits.find((item) => item.id === appointment.completedVisitId);
  assert.equal(visit.appointmentId, appointment.id);
  assert.equal(f.patient.visits.length, visitCount + 1);
  f.actions.renderDetail();
  assert.equal(f.$(`[data-appointment-row="${appointment.id}"]`), null);
  assert.equal(f.$('.patient-appointments-count').textContent, '11');
  assert.match(f.$('#visit-history-list').textContent, /Демонстрационная услуга 1/);
  assert.equal(
    f.state.data[0].appointments.find((item) => item.id === appointment.id),
    appointment,
  );
});

test('desktop card styles keep white surfaces and leave mobile changes limited to the approved list and visit entry', () => {
  const sheet = postcss.parse(
    ['desktop-card.css', 'desktop-card-header.css']
      .map((file) => source('src/client/styles/' + file))
      .join('\n'),
  );
  const scrollBounds = [],
    surfaces = [];
  sheet.walkRules((rule) => {
    const media = [];
    for (let node = rule.parent; node; node = node.parent)
      if (node.type === 'atrule' && node.name === 'media') media.push(node.params);
    assert.ok(
      media.some((value) => value.startsWith('screen')),
      rule.selector,
    );
    const desktopOnly = media.some((value) => /min-width:\s*981px/.test(value));
    for (const selector of rule.selectors) {
      assert.ok(selector.startsWith('.workspace.workspace-designed.card-mode'));
      assert.doesNotMatch(selector, /calendar-panel|#editor|topbar|print-patient/);
      if (!desktopOnly)
        assert.match(
          selector,
          /patient-appointments-(heading|count|list)|\.empty > #empty-new:first-child/,
        );
    }
    rule.walkDecls('display', (declaration) => {
      if (declaration.value !== 'none') return;
      assert.ok(desktopOnly, 'Only the desktop designation label is redundant');
      assert.equal(
        rule.selector.replace(/\s+/g, ' '),
        '.workspace.workspace-designed.card-mode #detail .patient-card-designation > span',
        'The designation value and every card action remain visible',
      );
    });
    if (rule.selector.endsWith('.patient-appointments-list'))
      rule.walkDecls('max-height', (declaration) =>
        scrollBounds.push([desktopOnly, declaration.value]),
      );
    if (rule.selector.endsWith('> .detail') || rule.selector.endsWith('.patient-header'))
      rule.walkDecls('background', (declaration) => surfaces.push(declaration.value));
  });
  assert.deepEqual(scrollBounds, [
    [false, '300px'],
    [true, '232px'],
  ]);
  assert.deepEqual(surfaces, ['#fff', '#fff']);
});
