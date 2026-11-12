// PREPARED WORK-ONLY. Root executes only after review; no real HTTP/provider/device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helper = fs.existsSync(path.join(__dirname, 'helpers/passive-view-fixture.cjs'))
  ? './helpers/passive-view-fixture.cjs' : './passive-view-fixture.cjs';
const { fixture, deferred, response } = require(helper);

function scheduleReply(f, revision) {
  return {
    revision, staffId: 'owner', from: f.date(), to: f.date(),
    timeZone: f.state.timeZone, members: structuredClone(f.state.workspace.members),
    days: {}, staffDays: {}, closures: {},
  };
}
function appointment(id) {
  return { id, patientId: 'p', staffId: 'owner', date: '2026-10-05', time: '12:00', duration: 30 };
}
function hiddenFanout(f, mark) {
  return f.calls.slice(mark.calls).filter((c) =>
    c.visibility === 'hidden' && c.method === 'GET' &&
    // Workspace revision reconciliation is a legitimate source read, not redraw fanout.
    new URL(c.route, 'https://synthetic.test/').pathname !== '/api/workspace');
}

test('all five late passive calendar completions defer paint and redraw-derived hidden HTTP', async (t) => {
  for (const kind of ['zone', 'records', 'schedule', 'rooms-busy', 'rooms-revision']) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      await f.primeCalendar();
      const gate = deferred();
      let pending;
      if (kind === 'zone') {
        f.handle('/api/cabinet/time-zone', () => gate.promise);
        pending = f.actions.refreshCabinetTimeZone({ force: true });
      } else if (kind === 'records') {
        f.handle('/api/cabinet/calendar?', () => gate.promise);
        pending = f.actions.loadCalendarRecords({ force: true });
      } else if (kind === 'schedule') {
        f.handle('/api/work-schedules?', () => gate.promise);
        pending = f.actions.loadCalendarSchedule({ force: true });
      } else {
        f.handle('/api/workspace/availability?', () => gate.promise);
        pending = f.actions.loadRoomAvailability({ force: true });
      }
      await f.flush();
      const oldCalendar = f.$('.calendar-panel');
      f.hidden(true);
      const mark = f.mark();
      if (kind === 'zone') gate.resolve({ timeZone: 'Europe/Samara' });
      if (kind === 'records') {
        f.catalog.appointments = [appointment('late-record')];
        gate.resolve({ appointments: f.catalog.appointments, version: 'late-v', validUntil: 9999999999999 });
      }
      if (kind === 'schedule') {
        f.catalog.scheduleRevision = 2;
        gate.resolve(scheduleReply(f, 2));
      }
      if (kind === 'rooms-busy') {
        f.catalog.busy = [{ id: 'late-busy', date: f.date(), time: '12:00', duration: 30 }];
        gate.resolve({ revision: f.state.workspace.revision, busy: f.catalog.busy });
      }
      if (kind === 'rooms-revision') {
        f.handle('/api/workspace', (call) => call.route.startsWith('/api/workspace/availability?')
          ? { revision: 2, busy: [] } : { ...structuredClone(f.state.workspace), revision: 2 });
        gate.resolve({ revision: 2, busy: [] });
      }
      await pending;
      await f.flush();
      assert.equal(f.$('.calendar-panel'), oldCalendar, 'hidden completion must not replace calendar DOM');
      assert.equal(f.stats.calendarPaints, mark.paints.calendarPaints);
      assert.deepEqual(hiddenFanout(f, mark), [], 'no newly started redraw-derived GET while hidden');
      if (kind === 'zone') {
        assert.equal(f.state.timeZone, 'Europe/Samara', 'validated live clock must change immediately');
        assert.equal(f.date(), '2026-10-06', 'today-following anchor must change before any visible pump');
      }
      if (kind === 'records') f.handle('/api/cabinet/calendar?', () => ({ unchanged: true }));
      else if (kind === 'schedule') f.handle('/api/work-schedules?', null);
      else if (kind.startsWith('rooms-')) f.handle('/api/workspace/availability?', null);
      else f.handle('/api/cabinet/time-zone', null);
      await f.resume();
      assert.notEqual(f.$('.calendar-panel'), oldCalendar, 'current cached presentation must flush on resume');
      if (kind === 'zone') {
        assert.equal(f.$('.calendar-panel').dataset.zone, 'Europe/Samara');
        assert.equal(f.$('.calendar-panel').dataset.date, '2026-10-06');
      }
      if (kind === 'records') assert.equal(f.$('.calendar-panel').dataset.records, 'late-record');
      if (kind === 'schedule') assert.equal(f.$('.calendar-panel').dataset.schedule, '2');
      if (kind === 'rooms-busy') assert.equal(f.$('.calendar-panel').dataset.busy, 'late-busy');
      if (kind === 'rooms-revision') assert.equal(f.$('.calendar-panel').dataset.workspace, '2');
      f.assertNoMutation();
    });
  }
});

test('normal awaited calendar/card/clients navigation keeps its DOM-complete contract even during initial prerender', async (t) => {
  const f = fixture(t, { lazy: false });
  f.state.data = [{ id: 'client', name: 'Synthetic Client', phone: '', visits: [], appointments: [] }];
  f.visibilityState('prerender', false); // JSDOM hidden=true is not the browser hidden lifecycle.
  f.state.sessionReady = false;
  await f.actions.setView('calendar');
  assert.ok(f.$('#calendar-new'), 'bootstrap awaited view must have a usable calendar');
  f.state.sessionReady = true;
  await f.actions.setView('clients');
  assert.ok(f.$('[data-patient="client"]'), 'normal list navigation is synchronous after await');
  f.state.selectedId = 'client';
  await f.actions.setView('card');
  assert.equal(f.$('#detail').textContent, 'client');
  assert.equal(await f.actions.runAssistantAction({ type: 'calendar', date: '2026-10-07', mode: 'day' }), true);
  assert.equal(f.$('.calendar-panel').dataset.date, '2026-10-07');
  assert.equal(await f.actions.runAssistantAction({ type: 'clientCard', patientId: 'client' }), true);
  assert.equal(f.$('#detail').textContent, 'client');
  assert.equal(await f.actions.runAssistantAction({ type: 'clients', query: 'Synthetic' }), true);
  assert.ok(f.$('[data-patient="client"]'));
  f.hidden(true, false);
  await f.actions.setView('calendar');
  assert.ok(f.$('#calendar-new'), 'only passive redraw is deferred, not normal awaited setView');
  f.assertNoMutation();
});

test('visible cached redraw remains immediate and starts no extra HTTP round after the one source read', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  const mark = f.mark(), old = f.$('.calendar-panel');
  f.catalog.appointments = [appointment('visible-record')];
  await f.actions.loadCalendarRecords({ force: true });
  await f.flush();
  assert.notEqual(f.$('.calendar-panel'), old);
  assert.equal(f.$('.calendar-panel').dataset.records, 'visible-record');
  assert.equal(f.stats.calendarPaints, mark.paints.calendarPaints + 1);
  assert.equal(f.calls.length - mark.calls, 1, 'ordinary primed redraw must not create new reads');
  f.assertNoMutation();
});

test('dirty cached records still paint when visible refresh returns unchanged', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  const gate = deferred();
  f.handle('/api/cabinet/calendar?', () => gate.promise);
  const pending = f.actions.loadCalendarRecords({ force: true });
  await f.flush();
  f.hidden(true);
  gate.resolve({ appointments: [appointment('cached-new')], version: 'new-version', validUntil: 9999999999999 });
  await pending; await f.flush();
  f.handle('/api/cabinet/calendar?', () => ({ unchanged: true }));
  await f.resume();
  assert.equal(f.$('.calendar-panel').dataset.records, 'cached-new');
  const painted = f.stats.calendarPaints;
  await f.actions.loadCalendarRecords({ force: true });
  await f.flush();
  assert.equal(f.stats.calendarPaints, painted, 'unchanged response alone must not cause a redundant redraw');
  f.assertNoMutation();
});

test('visible flush precedes the 500ms resume coalescer, is not blocked by an open editor, and defaults the next form to the live date', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  await f.actions.refreshBackground({ reason: 'resume' });
  await f.flush();
  await f.actions.openAppointmentForm(f.actions.calendarNewAppointment());
  const mode = f.state.editorMode, content = f.$('#form-content');
  f.$('[name="date"]').value = '2030-01-17';
  f.$('[name="notes"]').value = 'Keep entered draft';
  const old = f.$('.calendar-panel');
  f.hidden(true);
  f.actions.applyCabinetTimeZone('Europe/Samara');
  assert.equal(f.date(), '2026-10-06');
  assert.equal(f.$('.calendar-panel'), old, 'hidden underlay must remain deferred while live anchor changes');
  await f.advance(100); // No 4s tick and still inside the existing 500ms focus coalescer.
  await f.resume();
  assert.notEqual(f.$('.calendar-panel'), old, 'visibility must reconcile the underlay immediately');
  assert.equal(f.$('.calendar-panel').dataset.date, '2026-10-06');
  assert.equal(f.$('#form-content'), content);
  assert.equal(f.$('#editor').open, true);
  assert.equal(f.state.editorMode, mode);
  assert.equal(f.$('[name="date"]').value, '2030-01-17');
  assert.equal(f.$('[name="notes"]').value, 'Keep entered draft');
  f.actions.closeEditor();
  await f.actions.openAppointmentForm(f.actions.calendarNewAppointment());
  assert.equal(f.$('[name="date"]').value, '2026-10-06', 'cancel -> immediate new form must not wait for a pump');
  assert.equal(f.$('[data-slot-date]').dataset.slotDate, '2026-10-06', 'old slot DOM must not survive visible flush');
  f.assertNoMutation();
});

test('a legitimate explicit POST can complete hidden with outcomeUnknown; passive redraw must not retry it or replace recovery/draft', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  await f.actions.openAppointmentForm(f.actions.calendarNewAppointment());
  f.$('[name="notes"]').value = 'Unknown-save draft';
  const gate = deferred();
  f.handle('/api/cabinet/changes', () => gate.promise);
  const originalBody = JSON.stringify({ revision: 1, patients: [], services: [] });
  const saving = f.actions.request('/api/cabinet/changes', { method: 'PATCH', body: originalBody })
    .catch((error) => error);
  await f.flush();
  f.hidden(true);
  f.actions.applyCabinetTimeZone('Europe/Samara');
  const mutation = f.calls.find((c) => c.method === 'PATCH');
  assert.equal(mutation.signal.aborted, false, 'ordinary hidden transition must not cancel an explicit write');
  gate.reject(Error('Synthetic lost acknowledgement'));
  const error = await saving;
  assert.equal(error.outcomeUnknown, true);
  const receipt = Object.freeze({ idempotencyKey: 'synthetic-receipt', originalBody });
  f.recordUnknownReceipt(receipt);
  const mode = f.state.editorMode, content = f.$('#form-content'), message = f.$('#form-error').textContent;
  await f.resume();
  assert.equal(f.receipt(), receipt);
  assert.equal(f.state.editorMode, mode);
  assert.equal(f.$('#form-content'), content);
  assert.equal(f.$('[name="notes"]').value, 'Unknown-save draft');
  assert.equal(f.$('#form-error').textContent, message);
  assert.equal(f.$('#form-content').inert, true);
  assert.equal(f.$('#save-editor').disabled, true);
  assert.equal(f.calls.filter((c) => !['GET', 'HEAD'].includes(c.method)).length, 1);
});



// RED02 append: stale operation provenance and deferred presentation ownership.
// Original RED01 prefix is retained byte-for-byte; these controls use public effects.
test('a new organization starts its own zone read immediately; old completion/finally cannot apply or detach the current request', async (t) => {
  const f = fixture(t), old = deferred(), current = deferred();
  await f.primeCalendar();
  f.handle('/api/cabinet/time-zone', (call) =>
    call.scope.endsWith('|org') ? old.promise : current.promise);
  const oldTask = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  f.hidden(true);
  f.state.account = { ...f.state.account, organizationId: 'new-org' };
  // Hidden refresh has always been gated at entry; resume visibility without its automatic pump.
  f.hidden(false, false);
  const currentTask = f.actions.refreshCabinetTimeZone();
  await f.flush();
  assert.equal(f.readCalls('/api/cabinet/time-zone').length, 2, 'old scope pending/TTL must not suppress current scope');
  old.resolve({ timeZone: 'Europe/Samara' });
  await oldTask; await f.flush();
  assert.equal(f.state.timeZone, 'Europe/Moscow', 'stale old organization must not update the live clock');
  const joined = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  assert.equal(f.readCalls('/api/cabinet/time-zone').length, 2, 'old finally must not clear the new current pending owner');
  current.resolve({ timeZone: 'Asia/Kamchatka' });
  await Promise.all([currentTask, joined]); await f.flush();
  assert.equal(f.state.timeZone, 'Asia/Kamchatka');
  assert.equal(f.date(), '2026-10-06');
  f.assertNoMutation();
});

test('a completed old organization zone TTL does not postpone a first non-forced read for the new organization', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  f.handle('/api/cabinet/time-zone', (call) => ({
    timeZone: call.scope.endsWith('|org') ? 'Europe/Moscow' : 'Asia/Kamchatka',
  }));
  await f.actions.refreshCabinetTimeZone({ force: true });
  const before = f.readCalls('/api/cabinet/time-zone').length;
  f.state.account = { ...f.state.account, organizationId: 'new-org' };
  await f.actions.refreshCabinetTimeZone();
  assert.equal(f.readCalls('/api/cabinet/time-zone').length, before + 1);
  assert.equal(f.state.timeZone, 'Asia/Kamchatka');
  f.assertNoMutation();
});

test('room availability cache and request identity distinguish the same account ID in another organization', async (t) => {
  const f = fixture(t), old = deferred(), current = deferred();
  await f.primeCalendar();
  const before = f.readCalls('/api/workspace/availability?').length;
  f.handle('/api/workspace/availability?', (call) =>
    call.scope.endsWith('|org') ? old.promise : current.promise);
  const oldTask = f.actions.loadRoomAvailability({ force: true });
  await f.flush();
  f.hidden(true);
  f.state.account = { ...f.state.account, organizationId: 'new-org' };
  const currentTask = f.actions.loadRoomAvailability();
  await f.flush();
  assert.equal(f.readCalls('/api/workspace/availability?').length, before + 2, 'new org needs a distinct non-force cache key');
  current.resolve({ revision: 1, busy: [{ id: 'current-org-busy', date: f.date(), time: '13:00', duration: 30 }] });
  await currentTask; await f.flush();
  old.resolve({ revision: 1, busy: [{ id: 'old-org-busy', date: f.date(), time: '12:00', duration: 30 }] });
  await oldTask; await f.flush();
  f.catalog.busy = [{ id: 'current-org-busy', date: f.date(), time: '13:00', duration: 30 }];
  f.handle('/api/workspace/availability?', null);
  const rendered = [], render = f.actions.calendarHtml;
  f.actions.calendarHtml = () => { const html = render(); rendered.push(html); return html; };
  await f.resume();
  assert.equal(f.$('.calendar-panel').dataset.busy, 'current-org-busy');
  assert.ok(rendered.every((html) => !html.includes('old-org-busy')), 'old busy result must never be painted even transiently');
  f.assertNoMutation();
});

test('late old calendar sources and dirty flags cannot repaint a departed account/organization/view/range', async (t) => {
  const matrix = [
    ['records', 'account'], ['records', 'range'],
    ['schedule', 'organization'], ['schedule', 'view'],
    ['rooms', 'organization'], ['rooms', 'range'],
  ];
  for (const [kind, change] of matrix) {
    await t.test(kind + ':' + change, async (t) => {
      const f = fixture(t), gate = deferred();
      await f.primeCalendar();
      const prefix = kind === 'records' ? '/api/cabinet/calendar?'
        : kind === 'schedule' ? '/api/work-schedules?' : '/api/workspace/availability?';
      let reads = 0;
      f.handle(prefix, () => {
        if (++reads === 1) return gate.promise;
        if (kind === 'records') return { appointments: [], version: 'current', validUntil: 9999999999999 };
        if (kind === 'schedule') return scheduleReply(f, 2);
        return { revision: f.state.workspace.revision, busy: [] };
      });
      const pending = kind === 'records' ? f.actions.loadCalendarRecords({ force: true })
        : kind === 'schedule' ? f.actions.loadCalendarSchedule({ force: true })
          : f.actions.loadRoomAvailability({ force: true });
      await f.flush();
      f.hidden(true);
      await f.actions.setView('calendar', { redraw: true }); // Old-view dirty owner, never an old snapshot.
      if (change === 'account') f.state.account = { ...f.state.account, id: 'new-owner' };
      if (change === 'organization') f.state.account = { ...f.state.account, organizationId: 'new-org' };
      if (change === 'range') f.state.calendarAnchorDate = f.actions.parseDate('2026-10-07');
      await f.actions.setView(change === 'view' ? 'clients' : 'calendar');
      await f.flush();
      const rendered = [], render = f.actions.calendarHtml;
      f.actions.calendarHtml = () => { const html = render(); rendered.push(html); return html; };
      const oldResult = kind === 'records'
        ? { appointments: [appointment('old-marker')], version: 'old', validUntil: 9999999999999 }
        : kind === 'schedule' ? { ...scheduleReply(f, 999), from: '2026-10-05', to: '2026-10-05' }
          : { revision: f.state.workspace.revision, busy: [{ id: 'old-marker', date: '2026-10-05', time: '12:00', duration: 30 }] };
      gate.resolve(oldResult);
      await pending; await f.flush();
      const paints = f.stats.calendarPaints;
      await f.resume();
      assert.ok(rendered.every((html) => !html.includes('old-marker') && !html.includes('data-schedule="999"')));
      if (change === 'view') {
        assert.equal(f.state.currentView, 'clients');
        assert.equal(f.stats.calendarPaints, paints, 'flush must not navigate back to the departed calendar');
        assert.equal(f.$('#global-view').hidden, true);
      } else {
        assert.equal(f.$('.calendar-panel').dataset.date, change === 'range' ? '2026-10-07' : '2026-10-05');
      }
      f.assertNoMutation();
    });
  }
});



// RED03 append: resume coalescing may suppress force reads, never the existing pump.
test('a coalesced visible resume restarts ordinary interval reads without an immediate duplicate calendar request', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  await f.actions.refreshBackground({ reason: 'resume' });
  await f.flush();
  const before = f.readCalls('/api/cabinet/calendar?');
  const lastStart = before.at(-1).at;
  f.hidden(true);
  await f.advance(100);
  await f.resume();
  assert.equal(f.readCalls('/api/cabinet/calendar?').length, before.length, 'coalesced resume must not force another immediate read');
  await f.advance(14900);
  const after = f.readCalls('/api/cabinet/calendar?');
  assert.equal(after.length, before.length + 1, 'ordinary 15s calendar refresh must continue after the hidden timer was cleared');
  assert.equal(after.at(-1).at - lastStart, 15000);
  f.assertNoMutation();
});



// RED04 preventive positive control: already successful explicit navigation owns its paint.
test('an explicit visible calendar paint supersedes old hidden dirty work before a coalesced resume or ordinary tick', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  await f.actions.refreshBackground({ reason: 'resume' }); await f.flush();
  f.hidden(true);
  f.actions.applyCabinetTimeZone('Europe/Samara');
  await f.flush();
  await f.advance(100);
  f.hidden(false, false);
  await f.actions.setView('calendar'); await f.flush();
  const node = f.$('.calendar-panel'), paints = f.stats.calendarPaints, calls = f.calls.length;
  await f.resume();
  await f.actions.refreshBackground(); await f.flush();
  assert.equal(f.$('.calendar-panel'), node, 'no second cached repaint after a real successful explicit calendar paint');
  assert.equal(f.stats.calendarPaints, paints);
  assert.equal(f.calls.length, calls, 'coalescing may resume the timer but cannot add immediate forced reads');
  f.assertNoMutation();
});



// RED05 append: the second workspace await and a current query at civil midnight.
test('a late old workspace reconciliation cannot apply to a new account scope or rearm its calendar paint', async (t) => {
  const f = fixture(t), workspace = deferred();
  await f.primeCalendar();
  await f.actions.refreshBackground({ reason: 'resume' }); await f.flush();
  const template = f.actions.calendarHtml;
  f.actions.calendarHtml = () => template() + f.actions.roomFilterHtml();
  f.handle('/api/workspace/availability?', (call) => ({
    revision: call.scope.endsWith('|org') ? 2 : 1, busy: [],
  }));
  f.handle('/api/workspace', () => workspace.promise);
  const old = f.actions.loadRoomAvailability({ force: true });
  await f.flush();
  assert.equal(f.readCalls('/api/workspace').filter((c) =>
    new URL(c.route, 'https://synthetic.test/').pathname === '/api/workspace').length, 1);
  f.hidden(true);
  f.state.account = { ...f.state.account, organizationId: 'new-org' };
  const newWorkspace = {
    ...structuredClone(f.state.workspace), revision: 1,
    rooms: [
      { id: 'new-a', name: 'Current Room A', active: true, staffIds: ['owner'] },
      { id: 'new-b', name: 'Current Room B', active: true, staffIds: ['owner'] },
    ],
  };
  f.state.workspace = newWorkspace;
  await f.actions.setView('calendar'); await f.flush();
  // Clear any legitimate new-scope source repaint through the normal immediate path.
  await f.actions.setView('calendar'); await f.flush();
  const currentNode = f.$('.calendar-panel'), paints = f.stats.calendarPaints;
  workspace.resolve({
    ...structuredClone(newWorkspace), revision: 2,
    rooms: [
      { id: 'old-a', name: 'Old Organization Room A', active: true, staffIds: ['owner'] },
      { id: 'old-b', name: 'Old Organization Room B', active: true, staffIds: ['owner'] },
    ],
  });
  await old; await f.flush();
  assert.equal(f.$('.calendar-panel'), currentNode, 'stale second-await completion must not paint while hidden');
  f.handle('/api/workspace/availability?', null); f.handle('/api/workspace', null);
  await f.advance(100);
  await f.resume();
  assert.equal(f.$('.calendar-panel'), currentNode, 'stale completion must not queue a current dirty redraw');
  assert.equal(f.stats.calendarPaints, paints);
  assert.match(f.$('#calendar-room-filter').textContent, /Current Room A/);
  assert.doesNotMatch(f.$('#global-view').textContent, /Old Organization Room/);
  // Public room selector content, not private dirty flags, proves current ownership.
  assert.equal(f.actions.roomsFor('owner')[0].id, 'new-a');
  f.assertNoMutation();
});

test('a seeded passive clients view refreshes its current-today query once on visible resume after midnight', async (t) => {
  const f = fixture(t, { view: 'clients', paged: true });
  f.$('#workspace').insertAdjacentHTML('beforeend',
    '<span id="filter-count-appointment"></span><span id="filter-count-recent"></span>');
  f.state.directory = [require(helper).patient('old-day', 'Old Day Client')];
  f.actions.initializeDirectory({
    total: 1, matched: 1, counts: { all: 1, appointment: 1, recent: 1 }, nextCursor: null,
  });
  f.actions.renderList();
  assert.equal(f.$('#filter-count-appointment').textContent, '1');
  assert.equal(f.readCalls('/api/cabinet/directory?').length, 0);
  f.handle('/api/cabinet/directory?', () => ({
    directory: [require(helper).patient('new-day', 'Current Day Client')], total: 1, matched: 1,
    counts: { all: 1, appointment: 0, recent: 0 }, nextCursor: null,
  }));
  f.hidden(true);
  await f.advance(30 * 60 * 1000); // Moscow23:30 -> midnight. No pending query/timer or manualinput.
  assert.equal(f.readCalls('/api/cabinet/directory?').length, 0);
  await f.resume(); await f.advance(0);
  const reads = f.readCalls('/api/cabinet/directory?');
  assert.equal(reads.length, 1);
  assert.equal(new URL(reads[0].route, 'https://synthetic.test/').searchParams.get('today'), '2026-10-06');
  assert.equal(f.$('#filter-count-appointment').textContent, '0');
  assert.equal(f.$('#filter-count-recent').textContent, '0');
  assert.ok(f.$('[data-patient="new-day"]'));
  f.focus(); await f.flush(); await f.advance(160);
  assert.equal(f.readCalls('/api/cabinet/directory?').length, 1);
  f.assertNoMutation();
});
