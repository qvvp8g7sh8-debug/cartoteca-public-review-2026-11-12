const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
function create(constraints, intent = {}) {
  const f = dialogueFixture();
  let result = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Анна Семёнова',
      serviceQuery: 'Чистка',
      date: day,
      ...intent,
    },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    constraints,
  );
  return {
    f,
    get result() {
      return result;
    },
    answer(operation) {
      const body = {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        ...operation,
      };
      result = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
      return { body, result };
    },
  };
}
const field = (r, key) => r.dialogue?.fields.find((row) => row.key === key)?.value;
const draft = (x) => x.f.flow.get(x.f.c, x.f.member, x.f.state, x.result.dialogue.id).data;
const pendingExact = (x) => {
  const stored = x.f.flow.get(x.f.c, x.f.member, x.f.state, x.result.dialogue.id);
  assert.ok(
    [...stored.options.values()].every((row) => row.kind !== 'slot'),
    'A displayed free interval is not a selected or exact slot',
  );
  assert.equal(stored.data.time, null);
  assert.equal(
    stored.data.timeRequired,
    true,
    'An unresolved original clock still requires an explicit valid clock or period',
  );
  assert.equal(x.result.action, null);
};
const noSave = (f) => assert.ok(f.patients.every((p) => p.appointments.length === 0));

test('a rejected original clock cannot be replaced by all-day windows or a model-selected clock', () => {
  const constraints = initialTemporalConstraints(
    { intent: 'prepareAppointment', time: '14:30' },
    'Запиши Анну 5 января 2099 в 14:70.',
    { date: day, hour: 8, minute: 0 },
  );
  const x = create(constraints, { time: '14:30' });
  assert.equal(x.result.dialogue.step, 'time');
  pendingExact(x);
  assert.match(field(x.result, 'client'), /Анна/);
  assert.equal(field(x.result, 'date'), day);
  assert.equal(field(x.result, 'time'), undefined);
  x.answer({ text: 'подбери свободное время' });
  pendingExact(x);
  assert.equal(x.result.action, null);
  x.answer({ text: 'в 14:30' });
  assert.equal(x.result.dialogue.step, 'review');
  const done = x.answer({ text: 'открой форму' }).result;
  assert.equal(done.action.time, '14:30');
  noSave(x.f);
});

test('an initially missing time first offers free intervals and only an explicit interval choice asks for exact candidate slots', () => {
  const x = create({});
  assert.equal(x.result.dialogue.step, 'time');
  assert.equal(x.result.dialogue.phase, 'period');
  assert.ok(x.result.dialogue.options.length > 0);
  const before = x.f.flow.get(x.f.c, x.f.member, x.f.state, x.result.dialogue.id);
  assert.ok([...before.options.values()].every((row) => row.kind === 'freeRange'));
  assert.equal(before.data.time, null);
  assert.equal(x.result.action, null);
  x.answer({ choice: x.result.dialogue.options[0].id });
  const after = x.f.flow.get(x.f.c, x.f.member, x.f.state, x.result.dialogue.id);
  assert.equal(x.result.dialogue.phase, 'slots');
  assert.ok(after.options.size > 0 && after.options.size <= 3);
  assert.ok([...after.options.values()].every((row) => row.kind === 'slot'));
  assert.equal(after.data.time, null);
  assert.equal(x.result.action, null);
  noSave(x.f);
});

test('a busy clarified point offers full ranges and an explicit nearest request breaks an equal-distance tie toward the earlier window', () => {
  const x = create({ time: null });
  x.f.busy.push({ date: day, time: '14:30', duration: 30, staffId: 'owner' });
  x.answer({ text: 'в 14:30' });
  assert.equal(x.result.dialogue.step, 'time');
  assert.ok(x.result.dialogue.options.length > 0);
  assert.equal(x.result.dialogue.phase, 'period');
  assert.match(x.result.text, /Свободно с 09:00 до 14:30, с 15:00 до 18:00/u);
  assert.equal(x.result.action, null);
  x.answer({ text: 'предложи ближайшее время' });
  assert.equal(x.result.dialogue.phase, 'slots');
  assert.equal(x.result.dialogue.options.length, 1);
  assert.match(x.result.dialogue.options[0].label, /14:00–14:30/);
  assert.equal(draft(x).timeRequired, false);
  assert.equal(x.result.action, null);
  noSave(x.f);
});

test('separate invalid duration and clock requirements preserve other fields and are answered independently', () => {
  const x = create({ requireDuration: true, time: null });
  assert.equal(x.result.dialogue.step, 'duration');
  x.answer({ text: '45 минут' });
  assert.equal(x.result.dialogue.step, 'time');
  pendingExact(x);
  assert.equal(field(x.result, 'duration'), '45 мин');
  x.answer({ text: 'в 10:00' });
  assert.equal(x.result.dialogue.step, 'review');
  const done = x.answer({ text: 'запиши' }).result;
  assert.equal(done.action.duration, 45);
  assert.equal(done.action.time, '10:00');
  noSave(x.f);
});

test('retrying a time clarification is stable and cancellation cannot revive the preparation', () => {
  const x = create({ time: null });
  const accepted = x.answer({ text: 'в 10:00' });
  assert.deepEqual(
    x.f.flow.continueDialogue(x.f.c, accepted.body, x.f.state, x.f.member, x.f.clock),
    accepted.result,
  );
  const id = x.result.dialogue.id;
  x.answer({ cancel: true });
  assert.equal(x.result.dialogue, null);
  assert.throws(
    () =>
      x.f.flow.continueDialogue(
        x.f.c,
        { dialogueId: id, dialogueVersion: 0, text: 'открой' },
        x.f.state,
        x.f.member,
        x.f.clock,
      ),
    { status: 409 },
  );
  noSave(x.f);
});

test('an explicit any-time answer retracts only the unclear original clock and permits actual windows', () => {
  for (const text of ['любое время', 'в любое время', 'любое окно']) {
    const x = create({ time: null });
    pendingExact(x);
    x.answer({ text });
    assert.ok(x.result.dialogue.options.length > 0, text);
    assert.equal(field(x.result, 'date'), day, text);
    assert.match(field(x.result, 'client'), /Анна/u, text);
    assert.equal(x.result.action, null, text);
    const expected = x.result.dialogue.options[0].label.match(/(\d{2}:\d{2})/u)[1];
    x.answer({ choice: x.result.dialogue.options[0].id });
    const done = x.answer({ text: 'открой форму' }).result;
    assert.equal(done.action.time, expected, text);
    noSave(x.f);
  }
});

test('a negated conditional or compound any-time answer cannot retract the original clock requirement', () => {
  for (const text of [
    'не любое время',
    'любое время если будет свободно',
    'любое время и открой форму',
    'любое время после 15:00',
  ]) {
    const x = create({ time: null });
    try {
      x.answer({ text });
    } catch (error) {
      assert.equal(error.status, 400, text);
    }
    pendingExact(x);
    assert.equal(field(x.result, 'time'), undefined, text);
    assert.equal(x.result.action, null, text);
    noSave(x.f);
  }
});

test('any-time explicitly clears a previously selected clock rather than secretly keeping it as a lower bound', () => {
  const x = create({}, { time: '14:30' });
  assert.equal(x.result.dialogue.step, 'review');
  x.answer({ text: 'любое время' });
  assert.match(x.result.dialogue.options[0].label, /09:00/);
  assert.equal(draft(x).time, null);
  assert.equal(draft(x).slotAfterTime, '');
  assert.equal(draft(x).timeWindow.kind, 'any');
  assert.equal(field(x.result, 'date'), day);
  assert.equal(x.result.action, null);
  noSave(x.f);
});

test('an ordinary free-time request retains the already selected clock as its search basis', () => {
  const x = create({}, { time: '14:30' });
  x.answer({ text: 'подбери свободное время' });
  assert.match(x.result.dialogue.options[0].label, /14:30/);
  assert.equal(x.result.action, null);
  noSave(x.f);
});
