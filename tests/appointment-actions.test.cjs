// Prepared for the next explicitly requested test stage; synthetic data only.
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');
const { normalizePatientPhoneText } = require('../src/shared/patient-names.cjs');
const root = path.resolve(__dirname, '..');
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, { role = 'owner', mobile = false } = {}) {
  const w = new JSDOM(
    '<dialog id="editor"><form><h2 id="dialog-title"></h2><div id="form-content"></div></form></dialog>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  if (mobile) Object.defineProperty(w.navigator, 'userAgent', { value: 'iPhone' });
  w.matchMedia = () => ({ matches: mobile });
  const a = {
    id: 'a',
    date: '2030-01-03',
    time: '10:00',
    duration: 30,
    service: 'Synthetic',
    staffId: 'owner',
    status: 'scheduled',
    confirmationKey: 'synthetic-key',
  };
  const p = {
    id: 'p',
    name: 'Synthetic Client',
    phone: '+79001234567',
    appointments: [a],
    visits: [],
  };
  const state = {
    multiUser: true,
    currentView: 'calendar',
    account: { id: 'owner', organizationId: 'org', role },
    data: [p],
    uploadItems: [],
    busy: false,
    editorMode: null,
    calendarRecords: [],
  };
  const calls = { saved: 0, edited: [], errors: [], requests: [] };
  const $ = (selector) => w.document.querySelector(selector);
  const actions = {
    $,
    normalizePatientPhoneText,
    esc: (value) =>
      String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    patientNameParts: (patient) => ({ lastFirst: patient.name }),
    canDelete: () => state.account.role === 'owner',
    canEditRecord: (a) => state.account.role !== 'cosmetologist' || a.staffId === state.account.id,
    ensurePatient: async (id) => state.data.find((p) => p.id === id),
    calendarAppointmentAppearance: (a) => ({
      label:
        a.status === 'completed'
          ? 'Проведено'
          : a.manualConfirmedAt
            ? 'Подтверждена вручную'
            : 'Ждём клиента',
    }),
    calendarClientPhone: (a) => a.patientPhone || '',
    cabinetToday: () => '2030-01-02',
    cabinetClock: () => ({ date: '2030-01-02', hour: 12, minute: 0 }),
    formatDate: (value) => value,
    formatMinutes: (value) => value + ' мин',
    timeLabel: (value) =>
      String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0'),
    clientRecords: () => state.data,
    openDialog: () => $('#editor').setAttribute('open', ''),
    requestEditorClose: async () => {
      $('#editor').removeAttribute('open');
      state.editorMode = null;
    },
    closeEditor: () => {
      $('#editor').removeAttribute('open');
      state.editorMode = null;
    },
    openAppointmentForm: (...args) => calls.edited.push(args),
    confirmAction: async () => true,
    save: async () => {
      calls.saved++;
    },
    rollback() {},
    setView() {},
    invalidateCalendarRead() {},
    loadPatientTelegram: async () => {},
    toast: (text) => calls.errors.push(text),
    request: async (url, options) => {
      calls.requests.push({ url, body: JSON.parse(options.body) });
      return { appointmentId: 'a', manualConfirmedAt: 123 };
    },
  };
  for (const [file, name] of [
    ['src/shared/appointment-status.cjs', 'createAppointmentStatuses'],
    ['src/client/modules/manual-confirmation.js', 'createManualConfirmation'],
    ['src/client/modules/appointment-outcomes.js', 'createAppointmentOutcomes'],
    ['src/client/modules/client-contact.js', 'createClientContact'],
    ['src/client/modules/notification-history.js', 'createNotificationHistory'],
    ['src/client/modules/appointment-actions.js', 'createAppointmentActions'],
  ]) {
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    Object.assign(actions, w[name](state, actions));
  }
  actions.bindAppointmentActionEvents();
  return {
    w,
    state,
    actions,
    p,
    a,
    calls,
    $,
    open: () => actions.openAppointmentActions({ ...a, patientId: p.id }),
  };
}
for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
  test(
    'inspector opens without saving and keeps visible role-scoped actions: ' + role,
    async (t) => {
      const f = fixture(t, { role });
      await f.open();
      assert.equal(f.state.editorMode.kind, 'appointmentActions');
      assert.ok(f.$('[data-edit-appointment-action]'));
      assert.ok(f.$('[data-complete-appointment]'));
      assert.ok(f.$('[data-appointment-outcome="cancelled"]'));
      assert.equal(f.$('[data-appointment-outcome="no_show"]'), null);
      assert.equal(Boolean(f.$('[data-delete-appointment-action]')), role === 'owner');
      assert.equal(f.$('details:not([data-notification-history])'), null);
      assert.equal(f.$('[data-notification-history]').open, false);
      assert.equal(f.$('input,select,textarea'), null);
      assert.equal(f.calls.saved, 0);
      assert.equal(f.$('[href^="tel:"]'), null);
      f.$('[data-edit-appointment-action]').click();
      await settle();
      assert.equal(f.calls.edited.length, 1);
      assert.equal(f.calls.edited[0][0].id, 'a');
    },
  );
}
test('calendar details open personal chats before the full client card is loaded', async (t) => {
  const f = fixture(t);
  const account = f.state.account;
  f.state.lazyReads = true;
  f.state.data = [];
  f.actions.readAppointmentEditor = async () => ({
    kind: 'appointment-edit-v1',
    patient: { id: f.p.id, name: f.p.name, phone: f.p.phone },
    appointment: f.a,
  });
  f.w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  f.actions.bindClientContactEvents();
  await f.open();
  const button = f.$('[data-client-message]');
  assert.equal(button.disabled, false);
  f.state.account = { id: 'another-account' };
  button.click();
  assert.equal(f.$('#client-contact-dialog'), null);
  f.state.account = account;
  button.click();
  assert.equal(f.$('#client-contact-dialog')?.open, true);
  assert.deepEqual(
    [...f.w.document.querySelectorAll('#client-contact-dialog a')].map((link) => link.href),
    ['https://t.me/+79001234567', 'https://wa.me/79001234567'],
  );
  assert.equal(f.state.data.length, 0);
  assert.equal(f.calls.saved, 0);
});
test('mobile call and messaging are explicit, missing phone disables contact actions', async (t) => {
  const f = fixture(t, { mobile: true });
  await f.open();
  assert.equal(f.$('[href^="tel:"]').getAttribute('href'), 'tel:+79001234567');
  assert.match(f.$('[data-client-message]').textContent, /Написать/);
  f.p.phone = '';
  f.actions.refreshAppointmentActions();
  assert.equal(f.$('[data-client-message]').disabled, true);
  assert.equal(f.$('[href^="tel:"]'), null);
  assert.equal(f.calls.saved, 0);
});
test('confirmation is not offered twice; completion and closed outcomes do not offer editing', async (t) => {
  const f = fixture(t);
  await f.open();
  f.actions.bindManualConfirmationEvents();
  f.$('[data-manual-confirm]').click();
  await settle();
  assert.equal(f.calls.requests.length, 1);
  assert.equal(f.calls.requests[0].url, '/api/appointments/confirmation');
  assert.equal(f.$('[data-manual-confirm][data-confirm-value="true"]'), null);
  assert.ok(f.$('[data-manual-confirm][data-confirm-value="false"]'));
  f.a.notificationConfirmedAt = 456;
  f.actions.refreshAppointmentActions();
  assert.equal(f.$('[data-manual-confirm]'), null);
  f.a.status = 'completed';
  f.actions.refreshAppointmentActions();
  assert.equal(f.$('[data-edit-appointment-action]'), null);
  assert.equal(f.$('[data-delete-appointment-action]'), null);
  assert.match(f.$('[data-complete-appointment]').textContent, /Открыть посещение/);
  f.a.status = 'cancelled';
  f.actions.refreshAppointmentActions();
  assert.equal(f.$('[data-complete-appointment]'), null);
  assert.ok(f.$('[data-book-again]'));
  assert.equal(f.calls.saved, 0);
});
test('delete can be cancelled and refuses a changed record before save', async (t) => {
  const f = fixture(t);
  await f.open();
  f.actions.confirmAction = async () => false;
  f.$('[data-delete-appointment-action]').click();
  await settle();
  assert.equal(f.p.appointments.length, 1);
  assert.equal(f.calls.saved, 0);
  f.actions.confirmAction = async () => true;
  f.actions.ensurePatient = async () => {
    f.state.data = [{ ...f.p, appointments: [{ ...f.a, time: '11:00' }] }];
    return f.state.data[0];
  };
  f.$('[data-delete-appointment-action]').click();
  await settle();
  assert.equal(f.calls.saved, 0);
  assert.match(f.calls.errors.at(-1), /изменилась/);
  assert.equal(f.state.data[0].appointments[0].time, '11:00');
});
test('delete affects only the selected saved appointment and preserves other cards', async (t) => {
  const f = fixture(t);
  f.state.data.push({ id: 'other', appointments: [{ ...f.a, id: 'other-a' }] });
  await f.open();
  f.$('[data-delete-appointment-action]').click();
  await settle();
  assert.equal(f.calls.saved, 1);
  assert.equal(f.p.appointments.length, 0);
  assert.equal(f.state.data[1].appointments.length, 1);
  assert.equal(f.$('#editor').open, false);
});
test('anonymous occupancy, another specialist and stale account cannot open an inspector', async (t) => {
  const f = fixture(t, { role: 'cosmetologist' });
  await f.actions.openAppointmentActions({ ...f.a, patientId: 'p', busy: true });
  assert.equal(f.$('#editor').open, false);
  f.a.staffId = 'other';
  await f.open();
  assert.equal(f.$('#editor').open, false);
  let finish;
  f.a.staffId = 'owner';
  f.actions.ensurePatient = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = f.open();
  f.state.account = { id: 'different', organizationId: 'different' };
  finish(f.p);
  await pending;
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.calls.saved, 0);
});

function pointRead(f) {
  const reads = [];
  f.state.lazyReads = true;
  f.actions.readAppointmentEditor = () =>
    new Promise((resolve, reject) => reads.push({ resolve, reject }));
  return {
    reads,
    value: { kind: 'appointment-edit-v1', patient: f.p, appointment: f.a },
  };
}
test('opening reacts before its point read, repeated taps share the first successful read', async (t) => {
  const f = fixture(t),
    { reads, value } = pointRead(f);
  const first = f.open(),
    second = f.open();
  assert.equal(reads.length, 1);
  assert.equal(f.$('#editor').open, true);
  assert.equal(f.state.editorMode.loading, true);
  assert.match(f.$('[role="status"]').textContent, /Загружаем/);
  assert.equal(
    f.$('[data-edit-appointment-action],[data-manual-confirm],[data-complete-appointment]'),
    null,
  );
  reads[0].resolve(value);
  await Promise.all([first, second]);
  assert.ok(f.$('[data-edit-appointment-action]'));
  assert.equal(f.state.editorMode.loading, false);
  assert.equal(f.calls.saved, 0);
});
test('closed, departed, changed account scope and replaced views cannot reopen late details', async (t) => {
  for (const invalidate of [
    (f) => f.actions.closeEditor(),
    (f) => f.w.dispatchEvent(new f.w.Event('pagehide')),
    (f) => {
      f.state.account = { ...f.state.account };
    },
    (f) => {
      f.state.account.organizationId = 'other';
    },
    (f) => {
      f.state.account.role = 'cosmetologist';
    },
    (f) => {
      f.state.currentView = 'clients';
    },
  ]) {
    const f = fixture(t),
      { reads, value } = pointRead(f),
      opening = f.open();
    let fullReads = 0;
    f.actions.ensurePatient = async () => {
      fullReads++;
      return f.p;
    };
    invalidate(f);
    reads[0].resolve(value);
    await opening;
    assert.equal(f.$('#editor').open, false);
    assert.equal(f.$('[data-edit-appointment-action]'), null);
    assert.equal(f.calls.saved, 0);
    assert.equal(fullReads, 0);
  }
});
test('failed point read offers an explicit read retry without full-card fallback or save', async (t) => {
  const f = fixture(t),
    { reads, value } = pointRead(f);
  let fullReads = 0;
  f.actions.ensurePatient = async () => {
    fullReads++;
    return f.p;
  };
  const opening = f.open();
  reads[0].reject(Object.assign(Error('Нет связи. Повторите загрузку.'), { status: 503 }));
  await opening;
  assert.equal(f.state.editorMode.loading, true);
  assert.match(f.$('[role="alert"]').textContent, /Нет связи/);
  f.$('[data-retry-appointment-action]').click();
  await settle();
  assert.equal(reads.length, 2);
  reads[1].resolve(value);
  await settle();
  assert.ok(f.$('[data-edit-appointment-action]'));
  assert.equal(fullReads, 0);
  assert.equal(f.calls.saved, 0);
});
test('an old failed read cannot replace a different appointment loading or its success', async (t) => {
  const f = fixture(t),
    { reads, value } = pointRead(f),
    first = f.open();
  const other = { ...f.a, id: 'other' };
  const second = f.actions.openAppointmentActions({ ...other, patientId: f.p.id });
  await settle();
  assert.equal(reads.length, 2);
  reads[1].resolve({ ...value, appointment: other });
  await second;
  reads[0].reject(Error('old error'));
  await first;
  assert.equal(f.state.editorMode.id, 'other');
  assert.equal(f.$('[role="alert"]'), null);
  assert.equal(f.calls.errors.length, 0);
});

test('real point GET cancellation releases scheduler capacity across slow distinct opens and closes', async (t) => {
  const http = require('node:http'),
    cleanup = [],
    openings = [];
  const f = fixture({ after: (fn) => cleanup.push(fn) });
  const received = [],
    aborted = [];
  const server = http.createServer((req, res) => {
    const id = new URL(req.url, 'http://synthetic.test').searchParams.get('appointmentId');
    received.push(id);
    if (id !== 'latest') {
      res.on('close', () => {
        if (!res.writableEnded) aborted.push(id);
      });
      return; // Real transport remains pending until the client aborts it.
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ kind: 'appointment-edit-v1', patient: f.p, appointment: { ...f.a, id } }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    f.actions.cancelReadTasks?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled(openings);
    cleanup.forEach((fn) => fn());
  });
  f.w.AbortController = AbortController;
  f.w.fetch = (url, options) => fetch('http://127.0.0.1:' + server.address().port + url, options);
  f.state.lazyReads = true;
  for (const [file, name] of [
    ['src/client/core/read-scheduler.js', 'createReadScheduler'],
    ['src/client/core/session.js', 'createSession'],
    ['src/client/core/cabinet-queries.js', 'createCabinetQueries'],
  ]) {
    f.w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    Object.assign(f.actions, f.w[name](f.state, f.actions));
  }
  const until = async (check) => {
    const deadline = Date.now() + 2000;
    while (!check()) {
      assert.ok(Date.now() < deadline, 'latest point read must not wait for obsolete GET timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  for (let index = 0; index < 6; index++) {
    const id = 'slow-' + index;
    openings.push(f.actions.openAppointmentActions({ ...f.a, id, patientId: f.p.id }));
    await until(() => received.includes(id));
    if (index % 2 === 0) {
      f.actions.closeEditor();
      f.$('#editor').dispatchEvent(new f.w.Event('close'));
    }
  }
  const started = Date.now();
  const latest = f.actions.openAppointmentActions({ ...f.a, id: 'latest', patientId: f.p.id });
  openings.push(latest);
  // A delayed native close event from an older dialog must not abort this opening.
  f.$('#editor').dispatchEvent(new f.w.Event('close'));
  await until(() => f.state.editorMode?.id === 'latest' && !f.state.editorMode.loading);
  await latest;
  await until(() => aborted.length === 6);
  assert.ok(Date.now() - started < 2000);
  assert.equal(received.filter((id) => id === 'latest').length, 1);
  assert.ok(f.$('[data-edit-appointment-action]'));
  assert.equal(f.calls.errors.length, 0);
  assert.equal(f.calls.saved, 0);
});
