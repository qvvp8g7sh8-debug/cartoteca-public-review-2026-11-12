const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(
  path.join(__dirname, '../src/client/core/phone-landscape.js'),
  'utf8',
);
const calendar = `<section class="calendar-panel">
  <div class="mobile-calendar-heading"><button class="mobile-today">Сегодня</button></div>
  <div class="calendar-toolbar"><div class="calendar-actions">
    <button data-calendar-prev>Назад</button><button data-calendar-next>Вперёд</button>
    <div class="calendar-mode" aria-label="Вид календаря">
      <button class="active" data-calendar-mode="day">День</button>
      <button data-calendar-mode="week">Неделя</button>
      <button data-calendar-mode="month">Месяц</button>
      <button data-calendar-mode="list">Список</button>
    </div>
    <div class="calendar-booking-tools"><button data-open-work-schedule>Рабочие дни</button></div>
  </div></div>
  <div class="mobile-date-navigation"><button class="date-picker-toggle">Дата</button></div>
  <div class="calendar-selection"><select data-staff><option value="all">Все</option>
    <option value="specialist">Специалист</option></select></div>
  <div class="calendar-layout"><div class="calendar-timeboard">
    <div class="calendar-day-tools"><button data-early-hours>Ранние часы</button></div>
    <div class="time-scroll"><div class="time-grid" data-first-minute="420">
      <div class="time-row"><div class="time-slot"></div><div class="time-slot"></div></div>
    </div></div>
  </div></div>
</section>`;

function fixture(t, options = {}) {
  const w = new JSDOM(`<main id="global-view">${calendar}</main>
    <dialog id="editor" open><input value="Несохранённый черновик"></dialog>`, {
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  const device = {
    width: 390,
    height: 844,
    screenWidth: 390,
    screenHeight: 844,
    coarse: true,
    viewportHeight: 844,
    offsetTop: 0,
    ...options,
  };
  Object.defineProperties(w, {
    innerWidth: { get: () => device.width },
    innerHeight: { get: () => device.height },
    visualViewport: { value: new w.EventTarget() },
  });
  Object.defineProperties(w.screen, {
    width: { get: () => device.screenWidth },
    height: { get: () => device.screenHeight },
  });
  Object.defineProperties(w.visualViewport, {
    height: { get: () => device.viewportHeight },
    offsetTop: { get: () => device.offsetTop },
  });
  const pointer = new w.EventTarget();
  Object.defineProperty(pointer, 'matches', { get: () => device.coarse });
  w.matchMedia = () => pointer;
  const frames = new Map();
  let frameId = 0;
  w.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  w.cancelAnimationFrame = (id) => frames.delete(id);
  const state = {
    multiUser: true,
    currentView: 'calendar',
    phoneLandscape: false,
    calendarMode: 'day',
    calendarLoadPeriod: 'week',
    calendarGrouping: 'room',
    calendarAnchorDate: new w.Date(2030, 1, 5),
    selectedScheduleStaff: 'all',
    selectedRoomId: 'room-2',
    monthPickerOpen: false,
  };
  const calls = [];
  const actions = Object.fromEntries(
    ['positionCalendarEvents', 'updateCurrentTime', 'setView', 'loadCalendarRecords',
      'loadCalendarSchedule', 'loadRoomAvailability', 'request'].map((name) => [
      name, () => calls.push(name),
    ]),
  );
  w.eval(source);
  Object.assign(actions, w.createPhoneLandscape(state, actions));
  const $ = (selector) => w.document.querySelector(selector);
  const row = $('.time-row');
  row.getBoundingClientRect = () => ({ height: 96 });
  row.firstElementChild.getBoundingClientRect = () => ({
    width: w.document.body.classList.contains('phone-landscape') ? 280 : 210,
  });
  function flush() {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback();
  }
  function rotate(width, height) {
    Object.assign(device, {
      width, height, screenWidth: width, screenHeight: height, viewportHeight: height,
    });
    w.dispatchEvent(new w.Event('resize'));
    w.dispatchEvent(new w.Event('orientationchange'));
    flush();
  }
  return { w, device, state, calls, actions, $, frames, flush, rotate };
}

test('real coarse phone enables landscape shell only while rotated', (t) => {
  const f = fixture(t);
  f.actions.bindPhoneLandscapeEvents();
  assert.equal(f.w.document.body.classList.contains('phone-landscape'), false);
  f.rotate(844, 390);
  assert.equal(f.state.phoneLandscape, true);
  assert.equal(f.w.document.body.classList.contains('phone-landscape'), true);
  assert.equal(f.w.document.body.style.getPropertyValue('--phone-landscape-height'), '390px');
  f.rotate(390, 844);
  assert.equal(f.state.phoneLandscape, false);
  assert.equal(f.w.document.body.classList.contains('phone-landscape'), false);
  assert.equal(f.w.document.body.style.getPropertyValue('--phone-landscape-height'), '');
});

for (const options of [
  { coarse: false, width: 844, height: 390 },
  { width: 980, height: 450, screenWidth: 1280, screenHeight: 800 },
]) {
  test(`desktop and coarse tablet do not adopt phone shell: ${JSON.stringify(options)}`, (t) => {
    const f = fixture(t, options);
    f.actions.bindPhoneLandscapeEvents();
    assert.equal(f.state.phoneLandscape, false);
    assert.equal(f.actions.preservePhoneCalendarOnResize(), false);
    assert.equal(f.$('.phone-calendar-filters'), null);
  });
}

test('inactive desktop never schedules animation frames on resize or view mutations', async (t) => {
  const f = fixture(t, { coarse: false, width: 1440, height: 900,
    screenWidth: 1440, screenHeight: 900 });
  const errors = [];
  f.w.requestAnimationFrame = undefined;
  f.w.addEventListener('error', (event) => {
    errors.push(event.error?.message || event.message);
    event.preventDefault();
  });
  f.actions.bindPhoneLandscapeEvents();
  f.$('#global-view').append(f.w.document.createElement('section'));
  f.w.dispatchEvent(new f.w.Event('resize'));
  f.w.dispatchEvent(new f.w.Event('orientationchange'));
  f.w.visualViewport.dispatchEvent(new f.w.Event('resize'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(errors, []);
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.phoneLandscape, false);
  assert.equal(f.state.calendarMode, 'day');
  assert.equal(f.$('.phone-calendar-filters'), null);
});

for (const mode of ['day', 'week', 'month', 'list', 'load']) {
  test(`rotation preserves ${mode} calendar selection and editor without fetching data`, (t) => {
    const f = fixture(t);
    f.state.calendarMode = mode;
    const initial = { ...f.state };
    const editor = f.$('#editor');
    const draft = editor.querySelector('input');
    f.actions.bindPhoneLandscapeEvents();
    assert.equal(f.actions.preservePhoneCalendarOnResize(), true);
    f.flush();
    f.rotate(844, 390);
    f.rotate(390, 844);
    assert.deepEqual(f.state, initial);
    assert.equal(f.$('#editor'), editor);
    assert.equal(f.$('#editor input'), draft);
    assert.equal(draft.value, 'Несохранённый черновик');
    assert.equal(editor.hasAttribute('open'), true);
    assert.equal(f.actions.preservePhoneCalendarOnResize(), true);
    assert.ok(f.calls.every((name) => ['positionCalendarEvents', 'updateCurrentTime'].includes(name)));
  });
}

test('opening portrait keyboard cannot enable landscape; landscape uses visible viewport', (t) => {
  const f = fixture(t);
  f.actions.bindPhoneLandscapeEvents();
  f.device.viewportHeight = 300;
  f.w.visualViewport.dispatchEvent(new f.w.Event('resize'));
  f.flush();
  assert.equal(f.state.phoneLandscape, false);
  f.rotate(844, 390);
  f.device.viewportHeight = 214;
  f.device.offsetTop = 18;
  f.w.visualViewport.dispatchEvent(new f.w.Event('resize'));
  f.flush();
  assert.equal(f.state.phoneLandscape, true);
  assert.equal(f.w.document.body.style.getPropertyValue('--phone-landscape-height'), '214px');
  assert.equal(f.w.document.body.style.getPropertyValue('--phone-viewport-top'), '18px');
});

test('legacy phone layout is not replaced by the v2 landscape shell', (t) => {
  const f = fixture(t);
  f.state.multiUser = false;
  f.actions.bindPhoneLandscapeEvents();
  f.rotate(844, 390);
  assert.equal(f.state.phoneLandscape, false);
  assert.equal(f.actions.preservePhoneCalendarOnResize(), false);
});

test('rotation keeps the visible schedule minute and relative horizontal column', (t) => {
  const f = fixture(t);
  f.actions.bindPhoneLandscapeEvents();
  const scroll = f.$('.time-scroll');
  scroll.scrollTop = 160;
  scroll.scrollLeft = 315;
  scroll.dispatchEvent(new f.w.Event('scroll'));
  f.rotate(844, 390);
  assert.equal(scroll.scrollTop, 160);
  assert.equal(scroll.scrollLeft, 420);
  f.rotate(390, 844);
  assert.equal(scroll.scrollTop, 160);
  assert.equal(scroll.scrollLeft, 315);
});

test('visible viewport movement updates shell without recalculating calendar events', (t) => {
  const f = fixture(t);
  f.actions.bindPhoneLandscapeEvents();
  f.rotate(844, 390);
  const calls = f.calls.length;
  f.device.viewportHeight = 225;
  f.device.offsetTop = 20;
  f.w.visualViewport.dispatchEvent(new f.w.Event('resize'));
  f.w.visualViewport.dispatchEvent(new f.w.Event('scroll'));
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.calls.length, calls);
  assert.equal(f.w.document.body.style.getPropertyValue('--phone-landscape-height'), '225px');
  assert.equal(f.w.document.body.style.getPropertyValue('--phone-viewport-top'), '20px');
});

test('controls move reversibly with their values, identities and existing listeners', (t) => {
  const f = fixture(t);
  const containers = ['.calendar-actions', '.mobile-calendar-heading',
    '.mobile-date-navigation', '.calendar-booking-tools', '.calendar-timeboard'];
  const children = containers.map((selector) => [f.$(selector), [...f.$(selector).children]]);
  const selection = f.$('[data-staff]');
  selection.value = 'specialist';
  const workDays = f.$('[data-open-work-schedule]');
  let workClicks = 0;
  workDays.addEventListener('click', () => workClicks++);
  f.actions.bindPhoneLandscapeEvents();
  f.rotate(844, 390);
  assert.equal(f.$('.phone-calendar-filters [data-open-work-schedule]'), workDays);
  assert.equal(f.$('.phone-calendar-filters [data-staff]'), selection);
  workDays.click();
  assert.equal(workClicks, 1);
  assert.equal(selection.value, 'specialist');
  f.rotate(390, 844);
  for (const [container, original] of children) assert.deepEqual([...container.children], original);
  assert.equal(f.$('.phone-calendar-filters'), null);
  assert.equal(f.$('[data-phone-calendar-mode]'), null);
  assert.equal(f.$('.phone-landscape-date-label'), null);
  assert.equal(selection.value, 'specialist');
  workDays.click();
  assert.equal(workClicks, 2);
});

test('compact mode selector delegates once to existing calendar action', (t) => {
  const f = fixture(t);
  let clicks = 0;
  f.$('[data-calendar-mode="month"]').addEventListener('click', () => clicks++);
  f.actions.bindPhoneLandscapeEvents();
  f.actions.bindPhoneLandscapeEvents();
  f.rotate(667, 375);
  const picker = f.$('[data-phone-calendar-mode]');
  assert.ok(picker);
  picker.value = 'month';
  picker.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  assert.equal(clicks, 1);
  assert.equal(f.w.document.querySelectorAll('.phone-calendar-filters').length, 1);
});
