const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const field = (r, key) => r.dialogue?.fields.find((row) => row.key === key)?.value;
function start() {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day, time: '15:00', duration: 80 });
  assert.equal(f.result.dialogue.step, 'review');
  f.answer({ text: 'подбери свободное время' });
  assert.match(f.result.dialogue.options[0].label, /15:00–16:20/);
  return f;
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('repeating an ordinary window request with the current version retains its existing clock basis', () => {
  const f = start();
  const accepted = f.answer({ text: 'подбери свободное время' });
  assert.match(accepted.result.dialogue.options[0].label, /15:00–16:20/);
  assert.deepEqual(f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock), accepted.result);
  assert.equal(field(f.result, 'duration'), '80 мин');
  assert.equal(f.result.action, null);
  noSave(f);
});

test('changing only duration retains the requested clock basis and prepares the selected actual window', () => {
  const f = start();
  f.answer({ text: 'поменяй длительность на 45 минут' });
  assert.equal(field(f.result, 'duration'), '45 мин');
  assert.match(f.result.dialogue.options[0].label, /15:00–15:45/);
  f.answer({ choice: f.result.dialogue.options[0].id });
  const done = f.answer({ text: 'открой форму' }).result;
  assert.equal(done.action.time, '15:00');
  assert.equal(done.action.duration, 45);
  noSave(f);
});

test('changing the service retains the clock basis and a manually specified duration', () => {
  const f = start();
  f.services.push({ id: 'massage', name: 'Массаж', duration: 30, staffId: 'owner' });
  f.answer({ text: 'поменяй услугу на массаж' });
  assert.equal(field(f.result, 'service'), 'Массаж');
  assert.equal(field(f.result, 'duration'), '80 мин');
  assert.match(f.result.dialogue.options[0].label, /15:00–16:20/);
  assert.equal(f.result.action, null);
  noSave(f);
});

test('changing the date preserves the clock basis on that new working date', () => {
  const f = start();
  const next = '2099-01-06';
  f.c.platform.workSchedules.view = () => ({ days: { [day]: { status: 'working', intervals: [['09:00', '18:00']] }, [next]: { status: 'working', intervals: [['09:00', '18:00']] } }, closures: {} });
  f.answer({ text: 'поменяй дату на завтра' });
  assert.equal(field(f.result, 'date'), next);
  assert.match(f.result.dialogue.options[0].label, /2099-01-06 · 15:00–16:20/);
  assert.equal(f.result.action, null);
  noSave(f);
});

test('an explicit time edit or any-time answer retracts the old search basis without choosing a start from its free period', () => {
  for (const [operation, phase] of [[{ edit: 'time' }, 'period'], [{ text: 'любое время' }, 'slots']]) {
    const f = start();
    // The fixture has one 09–18 working interval and no appointment/reservation/personal occupancy.
    assert.deepEqual(f.busy, []);
    assert.deepEqual(f.c.platform.bookingRequests.reserves(), []);
    assert.deepEqual(f.c.platform.personalEvents.occupancy(), []);
    assert.deepEqual(f.c.platform.workSchedules.view().days[day].intervals, [['09:00', '18:00']]);
    f.answer(operation);
    const draft = () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id).data;
    assert.equal(f.result.dialogue.phase, phase);
    if (phase === 'period')
      assert.deepEqual(f.result.dialogue.options.map(row => row.label), ['с 09:00 до 18:00']);
    else assert.match(f.result.dialogue.options[0].label, /09:00–10:20/);
    assert.equal(draft().time, null);
    assert.equal(draft().slotAfterTime || '', '');
    assert.equal(field(f.result, 'duration'), '80 мин');
    assert.equal(f.result.action, null);
    if (phase === 'period') f.answer({ choice: f.result.dialogue.options[0].id });
    assert.equal(f.result.dialogue.phase, 'slots');
    assert.equal(draft().time, null, 'selecting the whole free period cannot pick its first start');
    assert.equal(f.result.action, null);
    f.answer({ text: 'в 09:00' });
    assert.equal(f.result.dialogue.step, 'review');
    assert.equal(field(f.result, 'time'), '09:00');
    const done = f.answer({ text: 'открой форму' }).result;
    assert.equal(done.action.time, '09:00');
    assert.equal(done.action.duration, 80);
    assert.deepEqual(done.action.serviceIds, ['clean']);
    noSave(f);
  }
});

test('a retracted clock basis reports actual busy ranges and omits gaps shorter than the retained duration', () => {
  const f = start();
  f.busy.push({ date: day, time: '10:00', duration: 90, staffId: 'owner', roomId: 'main' });
  f.changed();
  f.answer({ edit: 'time' });
  assert.equal(f.result.dialogue.phase, 'period');
  assert.deepEqual(f.result.dialogue.options.map(row => row.label), ['с 11:30 до 18:00']);
  assert.equal(field(f.result, 'duration'), '80 мин');
  assert.equal(f.flow.get(f.c, f.member, f.state, f.result.dialogue.id).data.time, null);
  assert.equal(f.result.action, null);
  noSave(f);
});
