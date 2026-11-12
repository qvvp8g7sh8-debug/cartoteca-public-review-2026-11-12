const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTimeText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { initialTemporalConstraints } = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const { intentRequestConstraints } = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { resolveService } = require('../src/server/modules/assistant/actions/availability-context.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-16', hour: 6, minute: 0 };
const constraints = text => initialTemporalConstraints({ intent: 'prepareAppointment' }, text, clock);
const proposal = values => ({
  operation: 'patch',
  fields: { client: null, staff: null, service: null, date: null, time: null, duration: null, ...values },
  choice: null,
  field: null,
});

test('a dash clock with an explicit meridiem supports morning evening and night without changing bare numeric tokens', () => {
  for (const [text, expected] of [
    ['7-30 утра', '07:30'],
    ['в 7 - 30 утра.', '07:30'],
    ['на 7–30 вечером', '19:30'],
    ['7—30 ночи', '07:30'],
    ['12-00 ночи', '00:00'],
    ['12-00 дня', '12:00'],
  ]) assert.equal(parseTimeText(text), expected, text);
  for (const text of [
    '7-30', '17-10', '7-300 утра', '7-3 утра', '7-70 утра', '25-30 утра',
    '14-30 утра', '7-30 утра или 8-30 утра', 'не в 7-30 утра', 'примерно в 7-30 утра',
    '2026-07-30', '17.10.2026',
  ]) assert.equal(parseTimeText(text), null, text);
});

test('the complete booking utterance pins the literal dash clock independently from model values and appointment length', () => {
  const text = 'Запиши Юлю на 7-30 утра на пилинг.';
  assert.deepEqual(constraints(text), { time: '07:30' });
  assert.deepEqual(intentRequestConstraints({ intent: 'prepareAppointment' }, text), {});
  assert.deepEqual(constraints('Запиши Юлю завтра на 7–30 утра на пилинг на 45 минут.'), {
    date: '2026-10-17', time: '07:30',
  });
  assert.deepEqual(constraints('Запиши Юлю на пилинг номер 7-30.'), {});
  assert.deepEqual(constraints('Запиши Юлю на 17.10.'), { date: null, time: null });
  assert.deepEqual(constraints('Запиши Юлю на 2026-10-18.'), { date: '2026-10-18' });
});

test('dash clock ambiguity invalid meridiem final correction and bounds keep existing temporal safeguards', () => {
  for (const text of [
    'Запиши Юлю завтра на 7-70 утра.',
    'Запиши Юлю завтра в 14-30 утра.',
    'Запиши Юлю завтра примерно в 7-30 утра.',
    'Запиши Юлю завтра в 7-30 утра или в 8-30 утра.',
  ]) assert.deepEqual(constraints(text), { date: '2026-10-17', time: null }, text);
  assert.deepEqual(constraints('Запиши Юлю завтра на 7-30 утра, точнее на 9-30 утра.'), {
    date: '2026-10-17', time: '09:30',
  });
  for (const text of [
    'Запиши Юлю завтра после 7-30 утра.',
    'Запиши Юлю завтра до 7-30 утра.',
    'Запиши Юлю завтра между 7-30 утра и 8-30 утра.',
  ]) assert.throws(() => constraints(text), { status: 400 }, text);
});

function phraseFixture() {
  const f = dialogueFixture();
  Object.assign(f.patients[0], { firstName: 'Юля', lastName: 'Синтетическая', name: 'Юля Синтетическая' });
  f.services.splice(0, f.services.length,
    { id: 'almond', name: 'Миндальный пилинг', duration: 30, staffId: 'owner' },
    { id: 'milk', name: 'Молочный пилинг', duration: 60, staffId: 'owner' },
  );
  let result = f.start({ date: day, time: '10:00', duration: 45 });
  const entry = () => f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  return {
    f, entry,
    get result() { return result; },
    model(text, values) {
      const body = { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text };
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      assert.ok(snapshot, text);
      result = f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock, proposal(values), snapshot);
      return result;
    },
    open() {
      result = f.flow.continueDialogue(f.c, {
        dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text: 'открой форму',
      }, f.state, f.member, f.clock);
      return result;
    },
  };
}

test('a generic peeling request returns named catalog choices without inventing a service or forcing the first result', () => {
  const h = phraseFixture();
  assert.deepEqual(resolveService(h.f.services, 'пилинг').map(row => row.id), ['almond', 'milk']);
  h.model('Запиши Юлю на 7-30 утра на пилинг.', {
    client: 'Юлю', service: 'пилинг', time: '07:30',
  });
  const data = h.entry().data;
  assert.equal(h.result.dialogue.step, 'service');
  assert.equal(data.patient.id, h.f.patients[0].id);
  assert.equal(data.clientQuery, 'Юлю');
  assert.equal(data.time, '07:30');
  assert.equal(data.date, day);
  assert.equal(data.duration, 45);
  assert.equal(data.serviceChosen, false);
  assert.equal(data.serviceQuery, 'пилинг');
  assert.deepEqual([...h.entry().options.values()].filter(row => row.value).map(row => row.value), [
    'almond', 'milk',
  ]);
  assert.equal(h.result.action, null);
  assert.ok(h.f.patients.every(row => row.appointments.length === 0));
});

test('a full-phrase continuation correction preserves client date and duration and opens only an ordinary manual form', () => {
  const h = phraseFixture();
  h.model('Запиши Юлю на 7-30 утра на пилинг.', {
    client: 'Юлю', service: 'пилинг', time: '07:30',
  });
  h.model('Тогда молочный пилинг, точнее на 9-30 утра.', {
    service: 'молочный пилинг', time: '09:30',
  });
  const data = h.entry().data;
  assert.equal(data.patient.id, h.f.patients[0].id);
  assert.equal(data.service.id, 'milk');
  assert.equal(data.date, day);
  assert.equal(data.time, '09:30');
  assert.equal(data.duration, 45);
  assert.equal(h.result.dialogue.step, 'review');
  assert.equal(h.result.action, null);
  const ready = h.open();
  assert.equal(ready.dialogue, null);
  assert.equal(ready.action.type, 'prepareAppointment');
  assert.equal(ready.action.patientId, h.f.patients[0].id);
  assert.equal(ready.action.time, '09:30');
  assert.equal(ready.action.duration, 45);
  assert.deepEqual(ready.action.serviceIds, ['milk']);
  assert.ok(h.f.patients.every(row => row.appointments.length === 0));
});

test('a model cannot expand raw Юлю or generic пилинг into unspoken identity service or clock values', () => {
  for (const changes of [
    { client: 'Юлю', service: 'Миндальный пилинг', time: '07:30' },
    { client: 'Юлю', service: 'пилинг', time: '19:30' },
  ]) {
    const h = phraseFixture(), before = structuredClone(h.entry().data);
    h.model('Запиши Юлю на 7-30 утра на пилинг.', changes);
    assert.deepEqual(h.entry().data, before);
    assert.equal(h.result.action, null);
    assert.ok(h.f.patients.every(row => row.appointments.length === 0));
  }
});


test('an unconsumed dash range or malformed meridiem clock cannot be replaced with a model-invented point time', () => {
  for (const clockText of ['7-30-8-30 утра', '7–30–8–30 утра', '7-30-8:30 утра', '7-30-8.30 утра', '7-30-8,30 утра', '7-300 утра', '7-3 утра']) {
    assert.equal(parseTimeText('в' + clockText), null, clockText);
    assert.deepEqual(constraints('Запиши Юлю завтра в' + clockText + ' на пилинг.'), {
      date: '2026-10-17', time: null,
    }, clockText);
    assert.deepEqual(constraints('Запиши Юлю завтра в ' + clockText + ' на пилинг.'), {
      date: '2026-10-17', time: null,
    }, clockText);
  }
  assert.deepEqual(constraints('Запиши Юлю завтра на пилинг номер 7-30.'), { date: '2026-10-17' });
});

test('a full-phrase continuation retains client date and duration while rejecting a model point time for the explicit dash range', () => {
  const h = phraseFixture();
  h.model('Запиши Юлю в7-30-8-30 утра на пилинг.', {
    client: 'Юлю', service: 'пилинг', time: '07:30',
  });
  const data = h.entry().data;
  assert.equal(data.patient.id, h.f.patients[0].id);
  assert.equal(data.date, day);
  assert.equal(data.time, null);
  assert.equal(data.duration, 45);
  assert.equal(h.result.action, null);
  assert.ok(h.result.dialogue);
  assert.ok(h.f.patients.every(row => row.appointments.length === 0));
});

test('a proven canonical name proposal retains the spoken short name and explicit dash clock',()=>{
 const h=phraseFixture();h.model('Запиши Юлю на 7-30 утра на пилинг.',{client:'Юлия',service:'пилинг',time:'07:30'});
 assert.equal(h.entry().data.clientQuery,'Юлю');assert.equal(h.entry().data.time,'07:30');assert.equal(h.entry().data.serviceChosen,false);assert.equal(h.result.action,null);
 assert.ok(h.f.patients.every(row=>row.appointments.length===0));
});
