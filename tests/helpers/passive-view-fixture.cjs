// WORK-ONLY draft. No providers, browser process, server, database or real timers.
// Installed location: tests/helpers/passive-view-fixture.cjs.
// WORK location: work/assistant-night-20261017/late-view-red-01/.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const installedRoot = path.resolve(__dirname, '../..');
const root = fs.existsSync(path.join(installedRoot, 'src/client/core/navigation.js'))
  ? installedRoot : path.resolve(__dirname, '../../..');
const { normalizePatientPhoneText } = require(path.join(root, 'src/shared/patient-names.cjs'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const response = (data, status = 200) => ({ syntheticHttp: true, data, status });
const patient = (id, name = id) => ({
  id, name, phone: '', visits: [], appointments: [], visitCount: 0,
});
function fixture(t, options = {}) {
  const w = new JSDOM(
    '<!doctype html><nav class="app-nav"><button class="app-nav-item" data-view="calendar"></button>' +
    '<button class="app-nav-item" data-view="clients"></button><button class="app-nav-item" data-view="card"></button></nav>' +
    '<div id="load-status"></div><main id="workspace"><input id="search"><span id="count"></span>' +
    '<span id="list-result-count"></span><div id="patient-list"></div><div id="detail"></div></main>' +
    '<section id="global-view"></section><div id="toast"></div>' +
    '<dialog id="editor"><h2 id="dialog-title"></h2><button id="close-editor"></button>' +
    '<form id="editor-form"><div id="form-content"></div><p id="form-error"></p>' +
    '<button id="save-editor" type="submit">Сохранить</button></form></dialog>',
    { url: 'https://synthetic.test/', runScripts: 'outside-only', pretendToBeVisual: true },
  ).window;
  let now = Date.parse('2026-10-05T20:30:00Z'), timerId = 0, visibility = 'visible';
  const timers = new Map(), calls = [], routes = new Map(), signals = [], errors = [];
  const stats = { calendarPaints: 0, listPaints: 0, layout: 0, clock: 0, assistantMounts: 0 };
  const RealDate = w.Date;
  w.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => visibility !== 'visible' });
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => visibility });
  w.structuredClone = structuredClone;
  w.AbortController = AbortController;
  w.setTimeout = (fn, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { fn, due: now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.setInterval = () => { throw Error('This fixture permits no new interval'); };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false; this.dispatchEvent(new w.Event('close'));
  };
  const html = Object.getOwnPropertyDescriptor(w.Element.prototype, 'innerHTML');
  Object.defineProperty(w.Element.prototype, 'innerHTML', {
    configurable: true,
    get() { return html.get.call(this); },
    set(value) {
      if (this.id === 'patient-list') stats.listPaints++;
      return html.set.call(this, value);
    },
  });
  const state = {
    multiUser: true, sessionReady: true, settingsReady: true,
    account: { id: 'owner', organizationId: 'org', role: 'owner', displayName: 'Synthetic Owner' },
    timeZone: 'Europe/Moscow', revision: 1, currentView: options.view || 'calendar',
    calendarAnchorDate: new w.Date(2026, 9, 5), calendarMode: 'day', calendarGrouping: 'staff',
    calendarLoadPeriod: 'week', selectedScheduleStaff: '', selectedRoomId: '',
    calendarRecords: [], calendarOverview: null, personalEvents: [], calendarPersonalOverview: null,
    data: [], directory: [], lazyReads: options.lazy !== false, pagedReads: Boolean(options.paged),
    patientSort: 'first', clientFilter: 'all', selectedId: null, activeTab: 'visits',
    busy: false, editorMode: null, assistantGeneration: 0, assistantEditor: null,
    uploadItems: [], SERVICE_CATEGORIES: [],
    workspace: {
      revision: 1, enabled: true, staffRules: [],
      rooms: [{ id: 'room', name: 'Synthetic room', active: true, preventOverlap: true, staffIds: ['owner'] }],
      members: [{ accountId: 'owner', role: 'owner', status: 'active', displayName: 'Synthetic Owner' }],
    },
    roomBusy: [], roomCacheKey: '',
  };
  const catalog = { appointments: [], busy: [], scheduleRevision: 1, directory: [patient('initial', 'Initial Client')] };
  function defaultData(route) {
    const url = new URL(route, 'https://synthetic.test/'), params = url.searchParams;
    if (url.pathname === '/api/auth/session') return { user: state.account, assistant: null };
    if (url.pathname === '/api/cabinet/time-zone') return { timeZone: state.timeZone };
    if (url.pathname === '/api/cabinet/calendar') return {
      appointments: structuredClone(catalog.appointments), personalEvents: [],
      version: 'version-' + catalog.appointments.map((a) => a.id).join('-'), validUntil: 9999999999999,
    };
    if (url.pathname === '/api/work-schedules') return {
      revision: catalog.scheduleRevision, staffId: params.get('staffId'),
      from: params.get('from'), to: params.get('to'), timeZone: state.timeZone,
      members: structuredClone(state.workspace.members), days: {}, staffDays: {}, closures: {},
    };
    if (url.pathname === '/api/workspace/availability') return {
      revision: state.workspace.revision, busy: structuredClone(catalog.busy),
    };
    if (url.pathname === '/api/workspace') return structuredClone(state.workspace);
    if (url.pathname === '/api/cabinet/directory') return {
      directory: structuredClone(catalog.directory), total: catalog.directory.length,
      matched: catalog.directory.length, counts: { all: catalog.directory.length }, nextCursor: null,
    };
    throw Error('Unexpected synthetic HTTP route: ' + url.pathname);
  }
  w.fetch = async (route, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const call = {
      route: String(route), method, at: now, visibility,
      scope: [state.account?.id, state.account?.organizationId].join('|'), signal: init.signal,
    };
    calls.push(call); signals.push(init.signal);
    const entry = [...routes].find(([prefix]) => String(route).startsWith(prefix));
    const result = await (entry ? entry[1](call, init) : defaultData(String(route)));
    const body = result?.syntheticHttp ? result.data : result;
    const status = result?.syntheticHttp ? result.status : 200;
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  function install(file, factory) {
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    Object.assign(actions, w[factory](state, actions));
  }
  let saveStatus = '', knownReceipt = null;
  const actions = {
    normalizePatientPhoneText,
    canEditServices: () => false, configureServiceView() {},
    renderBookingInbox() {}, refreshBookingInbox() {},
    renderBookingHealth() {}, refreshBookingHealth() {}, invalidatePrint() {},
    mountAssistant() { stats.assistantMounts++; },
    positionCalendarEvents() { stats.layout++; }, updateCurrentTime() { stats.clock++; },
    renderDetail() { actions.$('#detail').textContent = state.selectedId || ''; },
    accountId: () => state.account?.id || '', accountRole: () => state.account?.role,
    canManageTeam: () => false, bookingHealthInterval: () => 30000,
    bookingHealthDeadline: () => Infinity, bookingInboxInterval: () => 30000,
    bookingInboxDeadline: () => Infinity, earlyAccessVisible: () => false,
    improvementsVisible: () => false, syncVisibleTelegram() {},
    patientMatchesSearch: (p, q) => p.name.toLowerCase().includes(q.toLowerCase()),
    patientNameParts: (p) => ({ first: p.name, last: '', full: p.name, lastFirst: p.name }),
    patientFullName: (p) => p.name, patientDesignationHtml: () => '',
    countVisits: () => 0, isActiveAppointment: (a) => a.status !== 'cancelled',
    clientContactActionsHtml: () => '',
    confirmSettingsLeave: async () => true, rememberLoadedPatient() {},
    confirmAction: async () => true, photosPending: () => false,
    cancelPhotoProcessing() {}, mountServiceGroupControl() {}, mountCalendarCreationTabs() {},
    resetCalendarCreationTabs() {}, updatePhotoSaveButton() {},
    cabinetSaveStatus: () => saveStatus,
    renderSaveRecovery() {
      if (!saveStatus) return;
      actions.$('#form-error').textContent = 'Synthetic unknown save receipt';
      actions.$('#form-content').inert = true;
      actions.$('#save-editor').disabled = true;
    },
    appointmentPatientPickerHtml: () => '<input id="appointment-patient" name="patientId" value="">',
    patientFieldsHtml: () => '', staffField: () => '<label><select name="staffId"><option value="owner">Owner</option></select></label>',
    servicesForStaff: () => [], serviceDuration: () => 60, serviceCategory: () => 'other',
    formatMinutes: (value) => String(value), canEditRecord: () => true, isClosedAppointment: () => false,
    mountAppointmentProcedures() {}, refreshAppointmentSchedule() {},
    mountAppointmentPatientPicker() {}, refreshAppointmentRooms() {},
    calendarHtml() {
      stats.calendarPaints++;
      const schedule = actions.calendarLoadSchedule();
      return '<section class="calendar-panel" data-zone="' + state.timeZone + '" data-date="' +
        actions.isoDate(state.calendarAnchorDate) + '" data-schedule="' + (schedule?.revision || 0) +
        '" data-workspace="' + state.workspace.revision + '" data-records="' + state.calendarRecords.map((a) => a.id).join(',') +
        '" data-busy="' + state.roomBusy.map((a) => a.id).join(',') +
        '"><button id="calendar-new">New</button><div class="time-scroll"><div class="time-grid">' +
        '<button data-slot-date="' + actions.isoDate(state.calendarAnchorDate) +
        '" data-slot-time="12:00">Slot</button></div></div></section>';
    },
  };
  for (const [file, factory] of [
    ['src/client/shared/format.js', 'createFormat'],
    ['src/shared/time-zone.cjs', 'createZonedClock'],
    ['src/client/core/session.js', 'createSession'],
    ['src/client/modules/cabinet-time.js', 'createCabinetTime'],
    ['src/client/core/cabinet-queries.js', 'createCabinetQueries'],
    ['src/client/core/patient-view.js', 'createPatientView'],
    ['src/client/modules/work-schedules.js', 'createWorkSchedules'],
    ['src/client/modules/rooms.js', 'createRooms'],
    ['src/client/modules/workspace-data.js', 'createWorkspaceData'],
    ['src/client/modules/calendar-columns.js', 'createCalendarColumns'],
    ['src/client/core/client-directory.js', 'createClientDirectory'],
    ['src/client/modules/clients.js', 'createClients'],
    ['src/client/core/editor.js', 'createEditor'],
    ['src/client/modules/appointments.js', 'createAppointments'],
    ['src/client/modules/assistant-commands.js', 'createAssistantCommands'],
    ['src/client/core/navigation.js', 'createNavigation'],
    ['src/client/core/background-refresh.js', 'createBackgroundRefresh'],
  ]) install(file, factory);
  actions.toast = (message) => errors.push(message);
  actions.bindBackgroundEvents();
  actions.bindRoomEvents();
  t.after(async () => {
    w.dispatchEvent(new w.Event('pagehide'));
    timers.clear(); routes.clear();
    // Settle already-owned callback work while the synthetic DOM is still valid.
    // No new wall-clock timer or forced request is introduced by cleanup.
    await flush();
    w.close();
  });
  async function advance(milliseconds) {
    const target = now + milliseconds;
    for (let n = 0; n < 200; n++) {
      const next = [...timers].filter(([, value]) => value.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) { now = target; await flush(); return; }
      now = next[1].due; timers.delete(next[0]); next[1].fn(); await flush();
    }
    throw Error('Synthetic callback bound exceeded');
  }
  function visibilityState(value, dispatch = true) {
    visibility = value;
    if (dispatch) w.document.dispatchEvent(new w.Event('visibilitychange'));
  }
  async function resume({ dispatch = true, reason = 'resume' } = {}) {
    visibilityState('visible', dispatch);
    await actions.refreshBackground({ reason }); await flush();
  }
  async function primeCalendar() {
    await actions.setView('calendar'); await flush();
    await Promise.all([
      actions.loadCalendarRecords(), actions.loadCalendarSchedule(), actions.loadRoomAvailability(),
    ]);
    await flush();
  }
  function seedDirectory(items = catalog.directory, more = null) {
    catalog.directory = structuredClone(items); state.directory = structuredClone(items);
    actions.initializeDirectory({
      total: items.length, matched: items.length,
      counts: { all: items.length }, nextCursor: more,
    });
    actions.renderList();
  }
  return {
    w, state, actions, catalog, calls, stats, timers, errors, signals,
    $: (s) => w.document.querySelector(s), flush, advance, resume, primeCalendar, seedDirectory,
    hidden: (value = true, dispatch = true) => visibilityState(value ? 'hidden' : 'visible', dispatch),
    visibilityState, focus: () => w.dispatchEvent(new w.Event('focus')),
    pagehide: () => w.dispatchEvent(new w.Event('pagehide')),
    pageshow: () => w.dispatchEvent(new w.Event('pageshow')),
    handle: (prefix, handler) => handler ? routes.set(prefix, handler) : routes.delete(prefix),
    readCalls: (prefix = '') => calls.filter((c) => c.method === 'GET' && c.route.startsWith(prefix)),
    mark: () => ({ calls: calls.length, paints: { ...stats } }),
    date: () => actions.isoDate(state.calendarAnchorDate),
    recordUnknownReceipt(value) { knownReceipt = value; saveStatus = 'unknown'; actions.renderSaveRecovery(); },
    receipt: () => knownReceipt,
    assertNoMutation() { assert.deepEqual(calls.filter((c) => !['GET', 'HEAD'].includes(c.method)), []); },
  };
}
module.exports = { fixture, deferred, flush, response, patient, root };
