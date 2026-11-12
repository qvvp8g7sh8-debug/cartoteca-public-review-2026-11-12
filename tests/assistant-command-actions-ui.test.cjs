const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
function fixture(t, overrides = {}) {
  const w = new JSDOM(
    '<input id="search" value="old search"><section id="form-content"><input name="date" value="2030-01-05"><input name="time" value="11:30"></section>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.eval(
    fs.readFileSync(path.resolve(__dirname, '../src/client/modules/assistant-commands.js'), 'utf8'),
  );
  const state = {
    account: { id: 'staff', organizationId: 'org' },
    assistantGeneration: 0,
    selectedId: 'old',
    activeTab: 'profile',
    calendarMode: 'day',
    currentView: 'calendar',
  };
  const views = [],
    loads = [],
    opened = [];
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    parseDate: (value) => new Date(value + 'T12:00:00'),
    weekStart: (value) => {
      const date = new Date(value);
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      return date;
    },
    setCalendarMode: (mode) => {
      state.calendarMode = mode;
    },
    setView: async (view) => {
      views.push(view);
      state.currentView = view;
    },
    ensurePatient: async (id, options) => {
      loads.push({ id, options });
      return { id };
    },
    accountId: () => state.account.id,
    servicesForStaff: (id) => [{ id: 'service-' + id, name: 'Услуга ' + id, staffId: id }],
    serviceSnapshot: (service) => ({ id: service.id, name: service.name }),
    openAppointmentForm: async (draft, source) => {
      opened.push({ draft, source });
      state.editorMode = { kind: 'appointment', id: null, source };
    },
    mountAppointmentTimePicker() {},
    ...overrides,
  };
  return {
    w,
    state,
    views,
    loads,
    opened,
    actions,
    api: w.eval('createAssistantCommands')(state, actions),
  };
}

test('calendar opens requested week/month using existing modes without entering settings', async (t) => {
  const f = fixture(t);
  await f.api.runAssistantAction({
    type: 'calendar',
    date: '2030-01-02',
    mode: 'week',
    staffId: 'staff',
  });
  assert.equal(f.state.calendarMode, 'week');
  assert.equal(f.state.calendarAnchorDate.getDay(), 1);
  assert.equal(f.state.selectedScheduleStaff, 'staff');
  assert.equal(f.state.calendarGrouping, 'staff');
  await f.api.runAssistantAction({ type: 'calendar', date: '2030-02-18', mode: 'month' });
  assert.equal(f.state.calendarMode, 'month');
  assert.equal(f.state.calendarAnchorDate.getMonth(), 1);
  assert.deepEqual(f.views, ['calendar', 'calendar']);
});

function actualAppointmentFixture(t, overrides = {}) {
  const f = fixture(t);
  f.writes = [];
  const forbiddenWrite = (name) => {
    f.writes.push(name);
    assert.fail('Preparing an assistant form cannot save: ' + name);
  };
  Object.assign(f.actions, {
    save: () => forbiddenWrite('save'),
    saveCabinet: () => forbiddenWrite('saveCabinet'),
    request: async (url, options = {}) =>
      forbiddenWrite(String(options.method || 'GET') + ' ' + url),
  });
  f.state.account.role = 'owner';
  Object.assign(f.state, { data: [], lazyReads: true, workspace: {}, SERVICE_CATEGORIES: [] });
  f.w.document.body.innerHTML =
    '<input id="search"><dialog id="editor"><h2 id="dialog-title"></h2><section id="form-content"></section></dialog>';
  Object.assign(f.actions, {
    servicesForStaff: () => [],
    isClosedAppointment: () => false,
    ensurePatient: async (id) => ({
      id,
      name: 'Синтетический клиент',
      appointments: [],
      visits: [],
    }),
    clientRecords: () => [],
    appointmentPatientPickerHtml: (patient) =>
      '<select id="appointment-patient"><option value="' +
      patient.id +
      '">Клиент</option></select>',
    patientFieldsHtml: () => '',
    staffField: (id) =>
      '<label><select name="staffId"><option value="' +
      id +
      '">Специалист</option></select></label>',
    serviceDuration: () => 30,
    isoDate: () => '2030-01-02',
    esc: (value) => String(value),
    timeLabel: (minute) =>
      String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'),
    formatMinutes: (value) => value + ' мин',
    appointmentRoomField: () => '',
    mountAppointmentProcedures() {},
    openDialog() {
      f.actions.$('#editor').open = true;
    },
    refreshAppointmentSchedule: async () => {},
    mountAppointmentPatientPicker() {},
    refreshAppointmentRooms: async () => {},
    ...overrides,
  });
  f.w.eval(
    fs.readFileSync(path.resolve(__dirname, '../src/client/modules/appointments.js'), 'utf8'),
  );
  Object.assign(f.actions, f.w.eval('createAppointments')(f.state, f.actions));
  return f;
}

for (const [change, mutate] of [
  [
    'role',
    (state) => {
      state.account.role = 'cosmetologist';
    },
  ],
  [
    'organization',
    (state) => {
      state.account.organizationId = 'other-org';
    },
  ],
  [
    'account',
    (state) => {
      state.account.id = 'other-account';
    },
  ],
  [
    'generation',
    (state) => {
      state.assistantGeneration++;
    },
  ],
])
  test(
    'real appointment factory does not open an assistant draft after pending patient load and ' +
      change +
      ' change',
    async (t) => {
      let release;
      const f = actualAppointmentFixture(t, {
        ensurePatient: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      });
      const opening = f.api.runAssistantAction({
        type: 'prepareAppointment',
        patientId: 'synthetic-patient',
        staffId: 'allowed-performer',
        date: '2030-01-02',
        time: '14:30',
        duration: 30,
      });
      mutate(f.state);
      release({
        id: 'synthetic-patient',
        name: 'Синтетический клиент',
        appointments: [],
        visits: [],
      });
      assert.equal(await opening, false);
      assert.equal(f.state.editorMode, undefined);
      assert.equal(f.state.assistantEditor, undefined);
      assert.equal(f.actions.$('#editor').open, false);
      assert.equal(f.actions.$('.voice-assistant-draft-hint'), null);
    },
  );

test('real appointment factory opens the chosen employee for a salon administrator and retains ordinary manual Save boundary', async (t) => {
  const f = actualAppointmentFixture(t);
  f.state.account = { id: 'administrator', organizationId: 'org', role: 'salon_admin' };
  const opened = await f.api.runAssistantAction({
    type: 'prepareAppointment',
    patientId: 'synthetic-patient',
    staffId: 'chosen-performer',
    date: '2030-01-02',
    time: '14:30',
    duration: 30,
  });
  assert.equal(opened, true);
  assert.equal(f.actions.$('#editor').open, true);
  assert.equal(f.actions.$('[name="staffId"]').value, 'chosen-performer');
  assert.equal(f.actions.$('[name="date"]').value, '2030-01-02');
  assert.equal(f.actions.$('[name="time"]').value, '14:30');
  assert.equal(f.actions.$('[name="duration"]').value, '30');
  assert.equal(f.state.editorMode.source, 'assistant');
  assert.equal(f.state.editorMode.id, null);
  assert.equal(
    f.actions.$('.voice-assistant-draft-hint').textContent,
    'Проверьте данные и сохраните запись.',
  );
  assert.deepEqual(f.writes, [], 'opening the normal form performs zero automatic writes');
  assert.equal(f.state.assistantEditor, f.state.editorMode);
});

test('real appointment factory preserves a newer unrelated editor while an assistant patient load finishes', async (t) => {
  let release;
  const f = actualAppointmentFixture(t, {
    ensurePatient: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const opening = f.api.runAssistantAction({
    type: 'prepareAppointment',
    patientId: 'synthetic-patient',
    staffId: 'staff',
    date: '2030-01-02',
    time: '14:30',
    duration: 30,
  });
  const newer = { kind: 'patient', id: 'newer-patient' };
  f.state.editorMode = newer;
  release({ id: 'synthetic-patient', name: 'Синтетический клиент', appointments: [], visits: [] });
  assert.equal(await opening, false);
  assert.equal(f.state.editorMode, newer);
  assert.equal(f.state.assistantEditor, undefined);
  assert.equal(f.actions.$('#editor').open, false);
});

test('client card uses fresh authorized load and ordinary card navigation', async (t) => {
  const f = fixture(t);
  await f.api.runAssistantAction({ type: 'clientCard', patientId: 'synthetic-client' });
  assert.equal(f.loads.length, 1);
  assert.equal(f.loads[0].id, 'synthetic-client');
  assert.equal(f.loads[0].options.force, true);
  assert.equal(f.state.selectedId, 'synthetic-client');
  assert.equal(f.state.activeTab, 'visits');
  assert.equal(f.actions.$('#search').value, '');
  assert.deepEqual(f.views, ['card']);
});

test('client load denied or returned after context change never opens a card', async (t) => {
  const denied = fixture(t, {
    ensurePatient: async () => {
      throw Error('Forbidden');
    },
  });
  await assert.rejects(
    denied.api.runAssistantAction({ type: 'clientCard', patientId: 'synthetic' }),
    /Forbidden/,
  );
  assert.equal(denied.state.selectedId, 'old');
  assert.deepEqual(denied.views, []);
  let release;
  const delayed = fixture(t, {
    ensurePatient: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const opening = delayed.api.runAssistantAction({ type: 'clientCard', patientId: 'synthetic' });
  delayed.state.assistantGeneration++;
  release({ id: 'synthetic' });
  await opening;
  assert.equal(delayed.state.selectedId, 'old');
  assert.deepEqual(delayed.views, []);
});

test('assistant client search resets a prior appointment filter before entering the ordinary list', async (t) => {
  const f = fixture(t);
  f.state.clientFilter = 'appointment';
  const snapshots = [];
  f.actions.setView = async (view) => {
    f.state.currentView = view;
    snapshots.push({ view, filter: f.state.clientFilter, query: f.actions.$('#search').value });
  };
  f.actions.renderList = () => snapshots.push({ render: true, filter: f.state.clientFilter });
  await f.api.runAssistantAction({ type: 'clients', query: '' });
  assert.equal(f.state.clientFilter, 'all');
  assert.deepEqual(snapshots, [
    { view: 'clients', filter: 'all', query: '' },
    { render: true, filter: 'all' },
  ]);
});

for (const [role, accountId, chosenStaff] of [
  ['owner', 'owner', 'employee'],
  ['salon_admin', 'administrator', 'employee'],
  ['cosmetologist', 'employee', 'employee'],
])
  test(
    role +
      ' hands the allowed chosen performer to an unsaved ordinary appointment form without substituting the current account',
    async (t) => {
      const f = fixture(t);
      f.state.account = { id: accountId, organizationId: 'org', role };
      await f.api.runAssistantAction({
        type: 'prepareAppointment',
        patientId: 'synthetic-patient',
        staffId: chosenStaff,
        date: '2030-01-02',
        time: '14:30',
        duration: 30,
        serviceIds: ['service-' + chosenStaff],
        roomId: 'synthetic-room',
      });
      assert.equal(f.opened.length, 1);
      assert.equal(f.opened[0].source, 'assistant');
      assert.equal(f.opened[0].draft.staffId, chosenStaff);
      assert.equal(f.opened[0].draft.patientId, 'synthetic-patient');
      assert.equal(f.opened[0].draft.date, '2030-01-02');
      assert.equal(f.opened[0].draft.time, '14:30');
      assert.equal(f.opened[0].draft.serviceItems[0].id, 'service-' + chosenStaff);
      assert.equal(f.opened[0].draft.roomId, 'synthetic-room');
      assert.equal(f.state.assistantEditor, f.state.editorMode);
      assert.equal(
        f.actions.$('#form-content').querySelectorAll('.voice-assistant-draft-hint').length,
        1,
      );
      assert.deepEqual(f.views, []);
    },
  );

test('an unrelated new appointment opened during asynchronous handoff is not claimed, cleared or decorated as an assistant draft', async (t) => {
  let release;
  const f = fixture(t, {
    openAppointmentForm: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const opening = f.api.runAssistantAction({
    type: 'prepareAppointment',
    patientId: 'synthetic',
    staffId: 'staff',
  });
  const other = { kind: 'appointment', id: null, source: 'calendar' };
  f.state.editorMode = other;
  release();
  await opening;
  assert.equal(f.state.editorMode, other);
  assert.equal(f.state.assistantEditor, undefined);
  assert.equal(f.actions.$('[name="date"]').value, '2030-01-05');
  assert.equal(f.actions.$('[name="time"]').value, '11:30');
  assert.equal(f.actions.$('.voice-assistant-draft-hint'), null);
});

test('a role or organization mutation in place while loading a card never opens the old-context patient', async (t) => {
  for (const mutate of [
    (state) => {
      state.account.role = 'cosmetologist';
    },
    (state) => {
      state.account.organizationId = 'other-org';
    },
    (state) => {
      state.account.id = 'other-user';
    },
  ]) {
    let release;
    const f = fixture(t, {
      ensurePatient: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    f.state.account.role = 'owner';
    const opening = f.api.runAssistantAction({
      type: 'clientCard',
      patientId: 'old-context-patient',
    });
    mutate(f.state);
    release({ id: 'old-context-patient' });
    await opening;
    assert.equal(f.state.selectedId, 'old');
    assert.deepEqual(f.views, []);
  }
});

test('an appointment form that did not open reports false instead of treating a swallowed ordinary form error as success', async (t) => {
  const f = fixture(t, { openAppointmentForm: async () => {} });
  const opened = await f.api.runAssistantAction({
    type: 'prepareAppointment',
    patientId: 'synthetic',
    staffId: 'staff',
    date: '2030-01-02',
    time: '14:30',
    duration: 30,
  });
  assert.equal(opened, false);
  assert.equal(f.state.editorMode, undefined);
  assert.equal(f.state.assistantEditor, undefined);
  assert.equal(f.actions.$('.voice-assistant-draft-hint'), null);
});

for (const role of ['owner', 'salon_admin'])
  test(
    role +
      ' explicit staff calendar action removes a previous room filter through the real calendar selection factory',
    async (t) => {
      const f = fixture(t);
      Object.assign(f.state, {
        account: { id: role === 'owner' ? 'owner' : 'administrator', organizationId: 'org', role },
        multiUser: true,
        calendarMode: 'month',
        calendarGrouping: 'rooms',
        selectedRoomId: 'previous-room',
        selectedScheduleStaff: 'previous-staff',
        workspace: {
          rooms: [
            { id: 'previous-room', name: 'Первый', active: true, staffIds: ['previous-staff'] },
            { id: 'other-room', name: 'Второй', active: true, staffIds: ['chosen-staff'] },
          ],
        },
      });
      const members = [
        { accountId: 'previous-staff', displayName: 'Первый сотрудник' },
        { accountId: 'chosen-staff', displayName: 'Выбранный сотрудник' },
      ];
      Object.assign(f.actions, {
        accountRole: () => role,
        calendarScheduleMembers: () => members,
        calendarEvents: () => [],
        isoDate: (date) => date.toISOString().slice(0, 10),
      });
      f.w.eval(
        fs.readFileSync(
          path.resolve(__dirname, '../src/client/modules/calendar-columns.js'),
          'utf8',
        ),
      );
      Object.assign(f.actions, f.w.eval('createCalendarColumns')(f.state, f.actions));
      f.actions.setView = async (view) => {
        f.views.push(view);
        f.actions.normalizeCalendarSelection();
      };
      await f.api.runAssistantAction({
        type: 'calendar',
        date: '2030-01-02',
        mode: 'day',
        staffId: 'chosen-staff',
      });
      assert.equal(f.state.calendarGrouping, 'staff');
      assert.equal(f.state.selectedRoomId, '');
      assert.equal(f.state.selectedScheduleStaff, 'chosen-staff');
      const columns = f.actions.calendarColumns([f.state.calendarAnchorDate]);
      assert.equal(columns.length, 1);
      assert.equal(columns[0].staffId, 'chosen-staff');
      assert.equal(columns[0].roomId, undefined);
      assert.deepEqual(f.views, ['calendar']);
      assert.deepEqual(f.opened, []);
    },
  );

for (const duration of [45, 75, 240])
  test(
    'actual assistant form retains explicit ' +
      duration +
      ' minutes when its selected catalog service is thirty minutes',
    async (t) => {
      const service = {
        id: 'synthetic-service-thirty',
        name: 'Первичная консультация',
        category: 'other',
        duration: '30 минут',
        price: 1000,
      };
      const f = actualAppointmentFixture(t, {
        servicesForStaff: () => [service],
        serviceCategory: (item) => item.category,
        durationMinutes: (value) => Number(String(value).match(/^\d+/u)?.[0] || 0),
        formatPrice: (value) => String(value),
        canEditServices: () => false,
      });
      f.state.SERVICE_CATEGORIES = [{ id: 'other', title: 'Другое' }];
      f.w.structuredClone = structuredClone;
      f.w.eval(
        fs.readFileSync(
          path.resolve(__dirname, '../src/client/modules/appointment-procedures.js'),
          'utf8',
        ),
      );
      Object.assign(f.actions, f.w.eval('createAppointmentProcedures')(f.state, f.actions));
      const opened = await f.api.runAssistantAction({
        type: 'prepareAppointment',
        patientId: 'synthetic-patient',
        staffId: 'synthetic-staff',
        date: '2030-01-02',
        time: '14:30',
        duration,
        serviceIds: [service.id],
      });
      assert.equal(opened, true);
      assert.equal(f.actions.$('#editor').open, true);
      assert.equal(f.actions.$('#appointment-duration').value, String(duration));
      assert.equal(f.actions.$('[name="staffId"]').value, 'synthetic-staff');
      assert.equal(f.state.editorMode.serviceItems.length, 1);
      assert.equal(f.state.editorMode.serviceItems[0].id, service.id);
      assert.equal(f.state.editorMode.serviceItems[0].duration, 30);
      assert.equal(f.actions.$('#appointment-service-value').value, service.name);
      assert.equal(f.actions.$('.appointment-procedure-row strong').textContent, service.name);
      assert.match(f.actions.$('#appointment-procedures-total').textContent, /30 мин/u);
      f.actions.refreshAppointmentServices();
      assert.equal(f.actions.$('#appointment-duration').value, String(duration));
      assert.equal(f.state.editorMode.id, null);
      assert.equal(f.state.editorMode.source, 'assistant');
      assert.equal(f.state.assistantEditor, f.state.editorMode);
      assert.equal(
        f.actions.$('.voice-assistant-draft-hint').textContent,
        'Проверьте данные и сохраните запись.',
      );
      assert.deepEqual(f.writes, [], 'duration handling never crosses the manual Save boundary');
      assert.deepEqual(f.views, []);
    },
  );

// CANCEL-EXECUTION-36

const committedCancellation = () => ({
  saved: true,
  cancelled: true,
  operation: 'cancel',
  text: 'Запись отменена.',
  policyVersion: 7,
  appointmentId: 'synthetic-appointment',
  action: { type: 'calendar', date: '2030-01-02', mode: 'day', staffId: 'staff' },
});
function cancellationCommandFixture(t, save) {
  const events = [],
    toasts = [];
  const f = fixture(t, {
    saveAssistantAppointment: save,
    invalidateCalendarRead: () => events.push('invalidate'),
    toast: (text) => toasts.push(text),
  });
  Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: false });
  f.state.assistantScope = { enabled: true, appointmentSavingEnabled: true, policyVersion: 7 };
  return { ...f, events, toasts };
}

test('cancel action refreshes the calendar only after the guarded executor confirms commit and never opens an editor', async (t) => {
  let release;
  const calls = [];
  const f = cancellationCommandFixture(t, (action) => {
    calls.push(action);
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.api.runAssistantAction({
    type: 'cancelAppointment',
    executionId: 'opaque-cancel-execution',
  });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.views, []);
  assert.deepEqual(f.toasts, []);
  assert.deepEqual(f.opened, []);
  release(committedCancellation());
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(f.events, ['invalidate']);
  assert.deepEqual(f.views, ['calendar']);
  assert.deepEqual(f.opened, []);
});

test('unknown cancellation outcome never invalidates the calendar or claims success', async (t) => {
  const f = cancellationCommandFixture(t, async () => {
    throw Object.assign(Error('Результат отмены пока неизвестен. Повторите проверку.'), {
      outcomeUnknown: true,
    });
  });
  await assert.rejects(
    () =>
      f.api.runAssistantAction({
        type: 'cancelAppointment',
        executionId: 'opaque-cancel-execution',
      }),
    (error) => error.outcomeUnknown === true,
  );
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.views, []);
  assert.deepEqual(f.toasts, []);
  assert.deepEqual(f.opened, []);
});

test('late cancellation commit cannot refresh or confirm over a changed account', async (t) => {
  let release;
  const f = cancellationCommandFixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.api.runAssistantAction({
    type: 'cancelAppointment',
    executionId: 'opaque-cancel-execution',
  });
  await Promise.resolve();
  f.state.account = { ...f.state.account, id: 'other-account' };
  release(committedCancellation());
  assert.equal(await pending, false);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.views, []);
  assert.deepEqual(f.toasts, []);
});

// AUTO-MOVE-37

test('move commits before refreshing the target calendar and never opens an appointment form', async (t) => {
  let release;
  const f = cancellationCommandFixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.api.runAssistantAction({ type: 'moveAppointment', executionId: 'opaque-move' });
  await Promise.resolve();
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.toasts, []);
  release({
    saved: true,
    moved: true,
    operation: 'move',
    appointmentId: 'existing-id',
    text: 'Перенёс запись.',
    policyVersion: 7,
    action: { type: 'calendar', date: '2030-01-03', staffId: 'staff' },
  });
  const result = await pending;
  assert.equal(result.moved, true);
  assert.deepEqual(f.events, ['invalidate']);
  assert.equal(f.state.calendarAnchorDate.getDate(), 3);
  assert.deepEqual(f.opened, []);
});
test('a move conflict leaves the editor closed and never claims success', async (t) => {
  const f = cancellationCommandFixture(t, async () => {
    throw Object.assign(Error('Время уже занято.'), { status: 409 });
  });
  await assert.rejects(() =>
    f.api.runAssistantAction({ type: 'moveAppointment', executionId: 'opaque-move' }),
  );
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.toasts, []);
});
