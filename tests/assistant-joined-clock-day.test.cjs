const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeClockSeparators,
  parseDateText,
  parseTimeText,
} = require('../src/server/modules/assistant/language/time/temporal.cjs');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-16', hour: 6, minute: 0 };
const constraints = (text, current = clock) =>
  initialTemporalConstraints({ intent: 'prepareAppointment' }, text, current);
const proposal = (values) => ({
  operation: 'patch',
  fields: {
    client: null,
    staff: null,
    service: null,
    date: null,
    time: null,
    duration: null,
    ...values,
  },
  choice: null,
  field: null,
});

test('an explicit day marker separates the joined clock and day without requiring a meridiem', () => {
  const original = 'Запиши анюсименову на консультацию на 8-30-20 числа.';
  assert.equal(
    normalizeClockSeparators(original),
    'Запиши анюсименову на консультацию на 8:30 20 числа.',
  );
  for (const [text, time] of [
    ['на 8-30-20 числа.', '08:30'],
    ['в 08 – 30 – 20 числа', '08:30'],
    ['в 18—45—20 ЧИСЛА', '18:45'],
    ['на 0-00-20 числа', '00:00'],
    ['на 23-59-20 числа', '23:59'],
  ]) {
    assert.equal(parseTimeText(text), time, text);
    assert.equal(parseDateText(text, clock), '2026-10-20', text);
    assert.deepEqual(
      constraints('Запиши Анну на консультацию ' + text),
      { date: null, dateProposal: { day: 20, date: '2026-10-20' }, time },
      text,
    );
  }
});

test('a numbered day uses only the organization current month and validates relative and weekday context', () => {
  assert.equal(parseDateText('20 числа', clock), '2026-10-20');
  assert.equal(parseDateText('16 числа', clock), '2026-10-16');
  assert.equal(parseDateText('во вторник 20 числа', clock), '2026-10-20');
  assert.equal(parseDateText('завтра 17 числа', clock), '2026-10-17');
  assert.equal(parseDateText('29 числа', { date: '2028-02-16' }), '2028-02-29');
  assert.equal(parseDateText('31 числа', { date: '2026-12-16' }), '2026-12-31');
  for (const text of [
    '15 числа',
    '0 числа',
    '32 числа',
    '200 числа',
    '20 числа или 21 числа',
    'примерно 20 числа',
    'не 20 числа',
    'завтра 20 числа',
    'в понедельник 20 числа',
    '20 числа ноября',
    '20 числа в ноябре',
    '20 числа следующего месяца',
    '20 числа в 2027 году',
    '20 числа 2027',
    '2027 20 числа',
    '2026-10-21 20 числа',
  ])
    assert.equal(parseDateText(text, clock), null, text);
  assert.equal(parseDateText('31 числа', { date: '2026-11-16' }), null);
  assert.equal(parseDateText('29 числа', { date: '2027-02-16' }), null);
  assert.equal(parseDateText('1 числа', { date: '2026-12-31' }), null);
  assert.equal(parseDateText('пятого', clock), null);
  assert.deepEqual(constraints('Запиши Анну на 8-30-31 числа', { date: '2026-11-16' }), {
    date: null,
    dateProposal: { day: 31, date: null },
    time: '08:30',
  });
});

test('bare triplets ranges malformed clocks and impossible day tokens remain unanswered instead of lending a point time to the model', () => {
  for (const tail of ['8-30-20', '8-05', '8-30-8-30 утра', '8-30-8:30 утра', '8-30-8.30 утра'])
    assert.equal(parseTimeText('на ' + tail), null, tail);
  for (const tail of [
    '8-70-20 числа',
    '25-30-20 числа',
    '8-300-20 числа',
    '8-3-20 числа',
    '8-30-0 числа',
    '8-30-32 числа',
    '8-30-200 числа',
    '8-30-8-30 числа',
    '7-30 - 8-30-20 числа',
    '7-30, 8-30-20 числа',
    '7-30 и 8-30-20 числа',
    '7–30 – 8–30–20 числа',
    '7-30-8:30-20 числа',
    '7-30-8.30-20 числа',
    '- 8-30-20 числа',
  ]) {
    assert.equal(parseTimeText('на ' + tail), null, tail);
    const result = constraints('Запиши Анну на консультацию на ' + tail);
    assert.equal(result.time, null, tail);
    assert.equal(result.date, null, tail);
  }
  assert.equal(parseDateText('8-70-20 числа', clock), null);
  assert.deepEqual(constraints('Запиши Анну на 8-30-20 числа или на 9-30-21 числа'), {
    date: null,
    time: null,
  });
  assert.deepEqual(constraints('Запиши Анну примерно на 8-30-20 числа'), {
    date: '2026-10-20',
    time: null,
  });
  assert.deepEqual(constraints('Запиши Анну на 8-30-20 числа и на 9:30'), {
    date: null,
    dateProposal: { day: 20, date: '2026-10-20' },
    time: null,
  });
  assert.deepEqual(constraints('Запиши Анну на 8-30-20 числа, точнее на 9-45-21 числа'), {
    date: null,
    dateProposal: { day: 21, date: '2026-10-21' },
    time: '09:45',
  });
  assert.throws(() => constraints('Запиши Анну после 8-30-20 числа'), { status: 400 });
  assert.throws(() => constraints('Запиши Анну на 7-30 до 8-30-20 числа'), { status: 400 });
});

function modelFixture() {
  const f = dialogueFixture();
  Object.assign(f.services[0], { name: 'Консультация', duration: 30 });
  f.c.platform.workSchedules.view = () => ({
    days: { '2099-01-20': { status: 'working', intervals: [['07:00', '20:00']] } },
    closures: {},
  });
  let result = f.start();
  const entry = () => f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  return {
    f,
    entry,
    get result() {
      return result;
    },
    model(text, fields) {
      const body = {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        text,
      };
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      assert.ok(snapshot, text);
      result = f.flow.applyModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
        proposal(fields),
        snapshot,
      );
      return result;
    },
    confirmDate() {
      result = f.flow.continueDialogue(f.c, {
        dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text: 'да',
      }, f.state, f.member, f.clock);
      return result;
    },
    open() {
      result = f.flow.continueDialogue(
        f.c,
        {
          dialogueId: result.dialogue.id,
          dialogueVersion: result.dialogue.version,
          text: 'открой форму',
        },
        f.state,
        f.member,
        f.clock,
      );
      return result;
    },
  };
}

test('a model continuation uses raw joined clock and day to prepare an ordinary form without saving', () => {
  const h = modelFixture();
  h.model('Запиши Анну Семёнову на консультацию на 8-30-20 числа.', {
    client: 'Анну Семёнову',
    service: 'консультацию',
    date: '2099-01-20',
    time: '08:30',
  });
  assert.equal(h.result.dialogue.step, 'date');
  assert.equal(h.entry().data.date, null);
  assert.deepEqual(h.entry().data.dateProposal, { day: 20, date: '2099-01-20' });
  h.confirmDate();
  assert.equal(h.result.dialogue.step, 'review');
  assert.equal(h.entry().data.date, '2099-01-20');
  assert.equal(h.entry().data.time, '08:30');
  assert.equal(h.result.action, null);
  const ready = h.open();
  assert.equal(ready.dialogue, null);
  assert.equal(ready.action.type, 'prepareAppointment');
  assert.equal(ready.action.date, '2099-01-20');
  assert.equal(ready.action.time, '08:30');
  assert.equal(ready.action.patientId, h.f.patients[0].id);
  assert.ok(h.f.patients.every((row) => row.appointments.length === 0));
});

test('the model cannot substitute a different date or clock for a raw joined expression', () => {
  for (const fields of [
    { date: '2099-01-21', time: '08:30' },
    { date: '2099-01-20', time: '20:30' },
  ]) {
    const h = modelFixture();
    h.model('Запиши Анну Семёнову на консультацию на 8-30-20 числа.', {
      client: 'Анну Семёнову',
      service: 'консультацию',
      ...fields,
    });
    assert.equal(h.entry().data.date, null);
    assert.deepEqual(h.entry().data.dateProposal, { day: 20, date: '2099-01-20' });
    assert.equal(h.entry().data.time, fields.time === '08:30' ? '08:30' : null);
    h.confirmDate();
    assert.equal(h.entry().data.date, '2099-01-20');
    assert.equal(h.entry().data.time, fields.time === '08:30' ? '08:30' : null);
    assert.equal(h.result.action, null);
    assert.ok(h.f.patients.every((row) => row.appointments.length === 0));
  }
});

test('malformed joined expressions retract the proposed temporal values without saving an appointment', () => {
  for (const tail of ['8-70-20 числа', '8-30-32 числа', '7-30 - 8-30-20 числа']) {
    const h = modelFixture();
    h.model('Запиши Анну Семёнову на консультацию на ' + tail, {
      client: 'Анну Семёнову',
      service: 'консультацию',
      date: '2099-01-20',
      time: '08:30',
    });
    assert.equal(h.entry().data.date, null, tail);
    assert.equal(h.entry().data.time, null, tail);
    assert.equal(h.result.action, null);
    assert.ok(h.f.patients.every((row) => row.appointments.length === 0));
  }
});
