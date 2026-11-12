const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, deferred, response } = require('./helpers/passive-view-fixture.cjs');

test('cached calendar underlay flush is immediate while auth and mandatory zone hold all network-derived work', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  await f.actions.openAppointmentForm(f.actions.calendarNewAppointment());
  const form = f.$('#form-content'),
    editorMode = f.state.editorMode;
  f.$('[name="date"]').value = '2030-01-17';
  f.$('[name="notes"]').value = 'Keep entered draft';
  f.hidden(true, false);
  f.actions.applyCabinetTimeZone('Europe/Samara');
  const old = f.$('.calendar-panel'),
    auth = deferred(),
    zone = deferred(),
    preload = deferred();
  f.w.eval(fs.readFileSync('src/client/core/read-scheduler.js', 'utf8'));
  Object.assign(f.actions, f.w.createReadScheduler(f.state));
  const background = f.actions.scheduleRead(() => preload.promise, { priority: 'background' });
  f.handle('/api/auth/session', () => auth.promise);
  f.handle('/api/cabinet/time-zone', () => zone.promise);
  let directoryFlush = 0,
    clientFlush = 0;
  const originalDirectory = f.actions.flushDirectoryReads,
    originalClient = f.actions.flushClientList;
  f.actions.flushDirectoryReads = () => {
    directoryFlush++;
    return originalDirectory();
  };
  f.actions.flushClientList = () => {
    clientFlush++;
    return originalClient();
  };
  const mark = f.mark(),
    priorities = [];
  const request = f.actions.request;
  f.actions.request = (url, options) => {
    priorities.push([url, options?.priority]);
    return request(url, options);
  };
  f.hidden(false, false);
  const pending = f.actions.refreshBackground({ reason: 'resume' });
  await f.flush();
  assert.notEqual(f.$('.calendar-panel'), old);
  assert.equal(f.$('.calendar-panel').dataset.date, '2026-10-06');
  assert.equal(f.$('#form-content'), form);
  assert.equal(f.state.editorMode, editorMode);
  assert.equal(f.$('#editor').open, true);
  assert.equal(f.$('[name="date"]').value, '2030-01-17');
  assert.equal(f.$('[name="notes"]').value, 'Keep entered draft');
  assert.equal(f.stats.assistantMounts, mark.paints.assistantMounts);
  assert.equal(directoryFlush, 0);
  assert.equal(clientFlush, 0);
  assert.deepEqual(
    f.calls.slice(mark.calls).map((call) => call.route),
    ['/api/auth/session'],
  );
  auth.resolve({ user: f.state.account });
  await f.flush();
  assert.deepEqual(
    f.calls.slice(mark.calls).map((call) => call.route),
    ['/api/auth/session', '/api/cabinet/time-zone'],
  );
  assert.equal(priorities.find(([url]) => url === '/api/cabinet/time-zone')[1], 'calendar');
  assert.equal(directoryFlush, 0);
  assert.equal(clientFlush, 0);
  zone.resolve({ timeZone: 'Europe/Samara' });
  await pending;
  await f.flush();
  assert.equal(directoryFlush, 1);
  assert.equal(clientFlush, 1);
  assert.equal(f.$('[name="date"]').value, '2030-01-17');
  assert.equal(f.$('[name="notes"]').value, 'Keep entered draft');
  preload.resolve();
  await background;
  f.assertNoMutation();
});

test('successful resume applies fresh zone before issuing the current-range calendar read', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  const mark = f.mark();
  f.handle('/api/cabinet/time-zone', () => ({ timeZone: 'Europe/Samara' }));
  await f.actions.refreshBackground({ reason: 'resume' });
  await f.flush();
  const reads = f.calls.slice(mark.calls).filter((call) => call.method === 'GET');
  const auth = reads.findIndex((call) => call.route === '/api/auth/session');
  const zone = reads.findIndex((call) => call.route === '/api/cabinet/time-zone');
  const calendar = reads.findIndex((call) => call.route.startsWith('/api/cabinet/calendar?'));
  assert.ok(auth >= 0 && zone > auth && calendar > zone);
  assert.match(reads[calendar].route, /from=2026-10-06/);
  assert.equal(f.state.timeZone, 'Europe/Samara');
  assert.equal(f.$('.calendar-panel').dataset.date, '2026-10-06');
  f.assertNoMutation();
});

test('required resume zone failure preserves the last confirmed zone and blocks clinical refresh until a fresh retry', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  const mark = f.mark();
  f.handle('/api/cabinet/time-zone', () => response({ error: 'Synthetic zone unavailable' }, 503));
  await f.actions.refreshBackground({ reason: 'resume' });
  await f.flush();
  assert.equal(f.state.timeZone, 'Europe/Moscow');
  assert.equal(
    f.readCalls('/api/cabinet/calendar?').filter((call) => f.calls.indexOf(call) >= mark.calls)
      .length,
    0,
  );
  f.handle('/api/cabinet/time-zone', () => ({ timeZone: 'Europe/Samara' }));
  await f.advance(2100);
  await f.actions.refreshBackground();
  await f.flush();
  assert.equal(f.state.timeZone, 'Europe/Samara');
  assert.ok(
    f.calls
      .slice(mark.calls)
      .some((call) => call.route.startsWith('/api/cabinet/calendar?from=2026-10-06')),
  );
  f.assertNoMutation();
});

test('required resume joining an optional timezone read observes its raw rejection and keeps clinical work gated', async (t) => {
  const f = fixture(t);
  await f.primeCalendar();
  const zone = deferred(),
    mark = f.mark();
  f.handle('/api/cabinet/time-zone', () => zone.promise);
  const optional = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  const resume = f.actions.refreshBackground({ reason: 'resume' });
  await f.flush();
  assert.equal(
    f.calls.slice(mark.calls).filter((call) => call.route === '/api/cabinet/time-zone').length,
    1,
    'required subscriber coalesces the owned transport',
  );
  zone.reject(Error('Synthetic shared timezone transport failure'));
  await Promise.all([optional, resume]);
  await f.flush();
  assert.equal(f.state.timeZone, 'Europe/Moscow');
  assert.equal(
    f.calls.slice(mark.calls).some((call) => call.route.startsWith('/api/cabinet/calendar?')),
    false,
    'optional failure must not unblock mandatory calendar freshness',
  );
  f.handle('/api/cabinet/time-zone', () => ({ timeZone: 'Europe/Samara' }));
  await f.advance(600);
  await f.actions.refreshBackground({ reason: 'resume' });
  await f.flush();
  assert.equal(f.state.timeZone, 'Europe/Samara');
  assert.ok(
    f.calls
      .slice(mark.calls)
      .some((call) => call.route.startsWith('/api/cabinet/calendar?from=2026-10-06')),
  );
  f.assertNoMutation();
});
