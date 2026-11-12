const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const field = (result, key) => result.dialogue?.fields.find((row) => row.key === key)?.value;
function windows() {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day, duration: 30 });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.dialogue.phase, 'period');
  f.answer({ text: 'любое время' });
  assert.equal(f.result.dialogue.phase, 'slots');
  return f;
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('ordinary positive conversational replies select the named current window without another model turn', () => {
  for (const text of [
    'второй вариант подойдет',
    'мне подойдет второй вариант',
    'давайте второе окно',
    'можно второй вариант',
  ]) {
    const f = windows();
    const expected = f.result.dialogue.options[1].label.match(/(\d{2}:\d{2})/u)[1];
    const result = f.answer({ text }).result;
    assert.equal(result.dialogue.step, 'review', text);
    assert.equal(field(result, 'time'), expected, text);
    assert.match(field(result, 'client'), /Анна/u);
    assert.equal(result.action, null);
    noSave(f);
  }
});

test('a positive wrapper remains bound to the current client list instead of treating it as a new identity', () => {
  const f = dialogueFixture({ ambiguous: true });
  f.patients[1].phone = f.patients[0].phone;
  f.start({ query: f.patients[0].phone, serviceQuery: 'Чистка', date: day, time: '10:00' });
  assert.equal(f.result.dialogue.step, 'client');
  const expected = f.result.dialogue.options[1].label;
  const result = f.answer({ text: 'мне подойдет второй вариант' }).result;
  assert.equal(result.dialogue.step, 'review');
  assert.equal(field(result, 'client'), expected);
  assert.equal(result.action, null);
  noSave(f);
});

test('negated conditional multiple and compound replies never choose a window or discard selected data', () => {
  for (const text of [
    'второй вариант не подойдет',
    'мне не подойдет второй вариант',
    'второй вариант подойдет если будет свободно',
    'если можно второй вариант',
    'можно первый или второй вариант',
    'второй и третий вариант подойдут',
    'второй вариант подойдет и открой форму',
  ]) {
    const f = windows();
    const entry = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
    const before = structuredClone(entry.data);
    try {
      f.answer({ text });
    } catch (error) {
      assert.equal(error.status, 400, text);
    }
    assert.deepEqual(entry.data, before, text);
    assert.equal(f.result.action, null, text);
    assert.equal(f.result.dialogue.step, 'time', text);
    noSave(f);
  }
});

test('conversational choices keep current version boundaries and reject an unavailable option', () => {
  const f = windows();
  const stale = f.result.dialogue.options[1].id;
  assert.throws(() => f.answer({ text: 'можно седьмой вариант' }), { status: 400 });
  const accepted = f.answer({ text: 'давайте второе окно' });
  assert.equal(accepted.result.dialogue.step, 'review');
  assert.throws(() => f.answer({ choice: stale }), { status: 409 });
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        { ...accepted.body, text: 'можно первый вариант' },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  noSave(f);
});
