const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveService } = require('../src/server/modules/assistant/actions/availability-context.cjs');
const { parseDateText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { repairOperation } = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const { applyRepair } = require('../src/server/modules/assistant/dialogue/dialogue-repair-apply.cjs');
const { applySearchRepair } = require('../src/server/modules/assistant/dialogue/dialogue-search-repair.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-16', hour: 10, minute: 30 };
const service = (id, name) => ({ id, name, staffId: 'owner', duration: 30 });
const current = (extra = {}) => ({ step: 'date', data: { date: null, time: '15:00', duration: 30 }, options: new Map(), ...extra });

test('spoken service titles tolerate terminal STT punctuation and safe complete-word case forms', () => {
  const services = [service('primary', 'Первичная консультация'), service('repeat', 'Повторная консультация')];
  for (const text of ['первичная консультация', 'первичную консультацию', 'Первичная консультация.', 'первичную консультацию?!', 'первичной консультации'])
    assert.deepEqual(resolveService(services, text).map((item) => item.id), ['primary'], text);
  for (const text of ['первую консультацию', 'первич', 'первичную консул', 'повторную первичную консультацию'])
    assert.deepEqual(resolveService(services, text), [], text);
});

test('short full-word service queries retain every catalog match and never prefer the first duplicate', () => {
  const services = [service('primary', 'Первичная консультация — диагностика'), service('repeat', 'Повторная консультация')];
  assert.deepEqual(resolveService(services, 'первичную консультацию').map((item) => item.id), ['primary']);
  assert.deepEqual(resolveService(services, 'консультацию').map((item) => item.id), ['primary', 'repeat']);
  services.push(service('other-primary', 'Первичная консультация — расширенная'));
  assert.deepEqual(resolveService(services, 'первичную консультацию').map((item) => item.id), ['primary', 'other-primary']);
  assert.deepEqual(resolveService([service('clean', 'Чистка')], 'Чист'), []);
});

test('natural service text progresses through the real local dialogue without an ordinal or Save', () => {
  const f = dialogueFixture();
  f.services.splice(0, f.services.length, service('primary', 'Первичная консультация'));
  assert.equal(f.start({ query: 'Анну Семёнову', date: day, time: '10:00' }).dialogue.step, 'service');
  const result = f.answer({ text: 'первичную консультацию.' }).result;
  assert.equal(result.dialogue.step, 'review');
  assert.equal(result.dialogue.fields.find((item) => item.key === 'service').value, 'Первичная консультация');
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
  assert.equal(f.busy.length, 0);
});

test('spoken ordinal dates and numeric ordinal suffixes use the organization year only for nonpast dates', () => {
  for (const text of ['семнадцатого октября', '17-го октября', '17го октября', 'на 17-е октября', 'семнадцатого октября 2026 года', '17-го октября 2026 года'])
    assert.equal(parseDateText(text, clock), '2026-10-17', text);
  assert.equal(parseDateText('двадцать первого октября', clock), '2026-10-21');
  assert.equal(parseDateText('тридцать первого декабря', clock), '2026-12-31');
  assert.equal(parseDateText('на завтра', clock), '2026-10-17');
  assert.equal(parseDateText('17 октября 2027 года', clock), '2027-10-17');
  assert.equal(parseDateText('15 октября', clock), null);
  assert.equal(parseDateText('17 января', clock), null);
  assert.equal(parseDateText('17 января', { date: '2026-12-31' }), null);
  assert.equal(parseDateText('17 января 2027', { date: '2026-12-31' }), '2027-01-17');
});

test('natural date forms preserve invalid-date, missing-month, conflicting-year and negation guards', () => {
  for (const text of ['семнадцатого', 'на 17-е', '31 ноября', '29 февраля', '17 октября 27', '17 октября 20267', '17 октября 2026 2027', '17 октября две тысячи двадцать шестого года', '17 октября или 18 октября', '17 октября и 18 октября', 'не 17 октября', 'нет, 17 октября', 'в понедельник 17 октября 2026'])
    assert.equal(parseDateText(text, clock), null, text);
});

test('ordinary date-only and named date corrections retain the same supported natural forms', () => {
  for (const text of ['семнадцатого октября', 'дату на 17-го октября', 'поменяй дату на семнадцатое октября 2026 года', 'на завтра']) {
    const operation = repairOperation(current(), text, clock);
    assert.equal(operation.kind, 'patch', text);
    assert.deepEqual(operation.edits, [{ field: 'date', text: '2026-10-17' }]);
    assert.equal(operation.confirm, false);
  }
});

test('one date and a recognized request for any free time become an atomic date-plus-slots operation', () => {
  for (const text of ['завтра любое время', 'завтра подбери свободное время', 'на семнадцатое октября в любое время']) {
    const entry = current();
    const operation = repairOperation(entry, text, clock);
    assert.equal(operation.kind, 'patch', text);
    assert.deepEqual(operation.edits, [{ field: 'date', text: '2026-10-17' }]);
    assert.equal(operation.seekSlots, true);
    assert.equal(operation.confirm, false);
    assert.deepEqual(applyRepair(entry, operation, clock), {});
    assert.equal(entry.data.date, '2026-10-17');
    assert.equal(entry.data.time, null);
    assert.equal(entry.data.seekSlots, true);
  }
});

test('ambiguous dates or vague time ranges do not become a partial date-plus-slot mutation', () => {
  for (const text of ['завтра или послезавтра любое время', 'завтра после обеда', 'завтра примерно в 15:00', '17 октября и 18 октября любое время']) {
    const entry = current(), before = structuredClone(entry.data);
    const operation = repairOperation(entry, text, clock);
    assert.equal(operation.kind, 'localHelp', text);
    assert.deepEqual(entry.data, before);
  }
});

test('date-plus-any-time asks for actual free windows without selecting one or saving the appointment', () => {
  const f = dialogueFixture();
  const next = '2099-01-06';
  f.c.platform.workSchedules.view = () => ({ days: { [next]: { status: 'working', intervals: [['09:00', '18:00']] } }, closures: {} });
  assert.equal(f.start({ query: 'Анну Семёнову', serviceQuery: 'Чистка' }).dialogue.step, 'date');
  const result = f.answer({ text: 'завтра любое время' }).result;
  assert.equal(result.dialogue.step, 'time');
  assert.equal(result.dialogue.fields.find((field) => field.key === 'date').value, next);
  assert.ok(result.dialogue.options.length > 0);
  const draft = f.flow.get(f.c, f.member, f.state, result.dialogue.id).data;
  assert.equal(draft.time, null, 'a time window is not an exact appointment start');
  assert.equal(draft.timeWindow.kind, 'any');
  assert.equal(result.dialogue.fields.find((field) => field.key === 'time').value, 'в любое время');
  const offered = result.dialogue.options[0];
  const exact = f.flow.get(f.c, f.member, f.state, result.dialogue.id).options.get(offered.id);
  assert.equal(exact.kind, 'slot');
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
  const chosen = f.answer({ text: 'вариант один' }).result;
  assert.equal(chosen.dialogue.step, 'review');
  assert.equal(chosen.dialogue.fields.find((field) => field.key === 'time').value, exact.value.time);
  assert.equal(chosen.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('any-time repair clears stale time bounds in an existing bounded availability search', () => {
  const entry = current({ availabilitySearch: { intent: { intent: 'availability', date: '2026-10-16', endDate: '2026-10-18', time: '14:00', endTime: '16:00', duration: 30 } } });
  const operation = repairOperation(entry, 'завтра любое время', clock);
  assert.equal(operation.kind, 'patch');
  applySearchRepair(entry, operation, clock);
  assert.equal(entry.availabilitySearch.intent.date, '2026-10-17');
  assert.equal(entry.availabilitySearch.intent.endDate, '2026-10-17');
  assert.equal(entry.availabilitySearch.intent.time, undefined);
  assert.equal(entry.availabilitySearch.intent.endTime, undefined);
  assert.equal(entry.availabilitySearch.intent.duration, 30);
});
