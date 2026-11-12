// Synthetic, read-only responsive fixture using the real UI renderers and styles.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { normalizePatientPhoneText } = require('../../src/shared/patient-names.cjs');
const root = path.resolve(__dirname, '../..');

function appointmentActionsPreview(mode = 'card', past = false) {
  const w = new JSDOM('<dialog id="editor" class="editor-designed" data-editor-kind="appointmentActions" open><form id="editor-form"><div class="dialog-heading"><h2 id="dialog-title"></h2><button type="button" class="icon-btn" aria-label="Закрыть">×</button></div><div id="form-content"></div></form></dialog>', {
    runScripts: 'outside-only',
  }).window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  try {
    const state = { multiUser: true, account: { id: 'owner' }, data: [] };
    const actions = {
      normalizePatientPhoneText,
      $: (selector) => w.document.querySelector(selector),
      esc: (value) => String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c]),
      canEditRecord: () => true,
      canDelete: () => true,
      cabinetToday: () => '2030-01-02',
      cabinetClock: () => ({ date: '2030-01-02', hour: 12, minute: 0 }),
      formatDate: () => '8 октября 2030 г.',
      formatMinutes: (value) => value + ' минут',
      timeLabel: (value) => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0'),
      patientNameParts: p => ({ lastFirst: p.name }),
      calendarClientPhone: a => a.patientPhone || '',
      calendarAppointmentAppearance: () => ({ label: past ? 'Посещение не оформлено' : 'Ждём подтверждения клиента' }),
      clientRecords: () => state.data,
    };
    for (const [file, factory] of [
      ['src/shared/appointment-status.cjs', 'createAppointmentStatuses'],
      ['src/client/modules/appointment-outcomes.js', 'createAppointmentOutcomes'],
      ['src/client/modules/manual-confirmation.js', 'createManualConfirmation'],
      ['src/client/modules/appointments.js', 'createAppointments'],
      ['src/client/modules/appointment-panel.js', 'createAppointmentPanel'],
      ['src/client/modules/client-contact.js', 'createClientContact'],
      ['src/client/modules/notification-history.js', 'createNotificationHistory'],
    ['src/client/modules/appointment-actions.js', 'createAppointmentActions'],
    ]) {
      w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
      Object.assign(actions, w[factory](state, actions));
    }
    const a = {
      id: 'synthetic', patientId: 'synthetic-client', date: past ? '2029-01-01' : '2030-10-08',
      time: '14:00', duration: 60, service: 'Тестовая услуга', confirmationKey: 'test',
      status: 'scheduled', canRemind: true,
    };
    let content;
    if (mode === 'editor') {
      state.data = [{ id: a.patientId, name: 'Тестовый клиент', phone: '+79001234567', appointments: [a] }];
      state.editorMode = { kind: 'appointmentActions', id: a.id, patientId: a.patientId, account: state.account };
      actions.refreshAppointmentActions();
      actions.$('#editor').removeAttribute('open');
      content = actions.$('#editor').outerHTML + '<script src="/mount.js"></script>';
    } else {
      content = '<main class="layout-preview"><h2>Действия записи</h2>' +
        '<section class="telegram-patient-panel unified-appointments">' +
        actions.appointmentPanelHtml([a], a.patientId,
          { linked: true, notificationsEnabled: true, bot: { connected: true } },
          '<details class="telegram-service-menu"><summary aria-label="Служебные действия">⋯</summary><div>Отключить привязку</div></details>') +
        '</section></main>';
    }
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Проверка кнопок записи</title><link rel="stylesheet" href="/style.css">' +
      '<link rel="stylesheet" href="/ui-extra.css"><link rel="stylesheet" href="/preview.css">' +
      '</head><body>' + content + '</body></html>';
  } finally { w.close(); }
}

module.exports = { appointmentActionsPreview };
if (require.main === module) {
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'");
    response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.url, 'http://127.0.0.1');
    if (['/style.css', '/ui-extra.css'].includes(url.pathname)) {
      response.setHeader('Content-Type', 'text/css');
      response.end(require('./interface-assets.cjs').readAsset(url.pathname.slice(1)));
    } else if (url.pathname === '/preview.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end('.layout-preview{max-width:1440px;margin:24px auto;padding:0 16px}.layout-preview h2{font-size:22px}');
    } else if (url.pathname === '/mount.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end("document.querySelector('#editor').showModal()");
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(appointmentActionsPreview(url.pathname === '/editor' ? 'editor' : 'card', url.searchParams.has('past')));
    }
  });
  server.listen(4175, '127.0.0.1', () => process.stdout.write('Synthetic action preview: http://127.0.0.1:4175/\n'));
}
