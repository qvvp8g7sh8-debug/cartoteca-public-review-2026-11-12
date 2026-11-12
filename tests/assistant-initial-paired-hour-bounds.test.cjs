const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { defaults } = require('../src/server/modules/workspace/policy.cjs');
const clock = { date: '2026-10-15', hour: 10, minute: 30 };
const intent = { intent: 'prepareAppointment', date: '2026-10-16', time: '15:00' };
const select = (text) => initialTemporalConstraints(intent, text, clock);

test('an explicit paired whole-hour range with hour units cannot inherit a guessed model clock', () => {
  for (const range of ['между 14 и 16 часами', 'между 9 и 11 часами', 'между 0 и 23 часами'])
    assert.throws(() => select('Запиши Анну завтра ' + range + '.'), { status: 400 }, range);
});

test('a bounded bare pair of whole clock hours is still a range without an exact start', () => {
  for (const range of ['между 14 и 16', 'между 9 и 11', 'между 0 и 23'])
    assert.throws(() => select('Запиши Анну завтра ' + range + '.'), { status: 400 }, range);
});

test('the actual service offers real fitting slots for paired-hour ranges without adopting the model clock', async (t) => {
  const f = await assistantBoundariesFixture(t),
    d = dialogueFixture(),
    current = f.current('owner');
  const { zonedClock } = require('../src/shared/time-zone.cjs');
  const { nextDate } = require('../src/shared/work-schedule.cjs');
  const date = nextDate(zonedClock(new Date(), 'Europe/Moscow').date);
  d.members[0].accountId = current.accountId;
  d.services[0].staffId = current.accountId;
  d.patients[0].createdBy = current.accountId;
  d.c.platform.workSchedules.view = () => ({
    days: { [date]: { status: 'working', intervals: [['09:00', '18:00']] } },
    closures: {},
  });
  const c = {
    ...f.context(),
    platform: { ...d.c.platform, workspaceSettings: () => defaults(current.accountId) },
    tenantStore: d.c.tenantStore,
  };
  f.ports.codex.run = async (call) => {
    call.guard();
    call.onOutbound();
    return {
      text: JSON.stringify({
        intent: 'prepareAppointment',
        query: 'Анна Семёнова',
        serviceQuery: 'Чистка',
        date,
        time: '15:00',
      }),
    };
  };
  for (const range of ['между 14 и 16 часами', 'между 14 и 16']) {
    const result = await f.api.turn(c, {
      text: 'Запиши Анну Семёнову на Чистку завтра ' + range + '.',
      policyVersion: f.revision(),
    });
    assert.equal(result.action, null);
    assert.equal(result.dialogue.phase, 'slots');
    assert.equal(result.dialogue.fields.find((row) => row.key === 'date').value, date);
    assert.notEqual(result.dialogue.fields.find((row) => row.key === 'time')?.value, '15:00');
    assert.ok(result.dialogue.options.length >= 1 && result.dialogue.options.length <= 3);
    for (const option of result.dialogue.options) {
      const match = /(\d{2}:\d{2})–(\d{2}:\d{2})/u.exec(option.label);
      assert.ok(match);
      assert.ok(match[1] > '14:00');
      assert.ok(match[2] <= '16:00');
      assert.equal(
        Number(match[2].slice(0, 2)) * 60 +
          Number(match[2].slice(3)) -
          (Number(match[1].slice(0, 2)) * 60 + Number(match[1].slice(3))),
        30,
      );
    }
    assert.equal(d.patients[0].appointments.length, 0);
    assert.equal(Object.keys(f.readState().reservations).length, 0);
  }
});

test('numbers inside names or service labels do not become a paired clock range', () => {
  for (const text of [
    'Запиши Анну 14 и 16 завтра в 15:00.',
    'Запиши Анну на услугу Уход 14 и 16 завтра в 15:00.',
    'Запиши Анну на услугу Уход 30 и 40 завтра в 15:00.',
  ])
    assert.deepEqual(select(text), { date: '2026-10-16', time: '15:00' }, text);
  for (const text of [
    'Запиши Анну на услугу Между 14 и 16 на завтра.',
    'Запиши Анну между кабинетами 14 и 16 завтра в 15:00.',
  ])
    assert.doesNotThrow(() => select(text), text);
});

test('existing explicit numeric bounds retain their refusal', () => {
  for (const text of [
    'Запиши Анну завтра между 14:00 и 16:00.',
    'Запиши Анну завтра после 14:30.',
    'Запиши Анну завтра не раньше 14:30.',
    'Запиши Анну после 18 октября.',
  ])
    assert.throws(() => select(text), { status: 400 }, text);
});

test('the negative old-action case remains conservative rather than reusing model temporal fields', () => {
  assert.deepEqual(select('Не переноси старую запись, подготовь новую для Анны завтра в 14:00.'), {
    date: null,
    time: null,
  });
});
