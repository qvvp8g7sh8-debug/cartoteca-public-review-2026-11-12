const test = require('node:test'),
  assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const entry = (f, id) => f.flow.get(f.c, f.member, f.state, id);
const noSave = (f) => assert.ok(f.patients.every((p) => p.appointments.length === 0));

test('a weak singleton still requires one confirmation and its accepted identity survives every subsequent field', () => {
  for (const acceptance of ['yes', 'name', 'click']) {
    const f = dialogueFixture();
    const first = f.start({ query: 'Анна Семёнофа' }, { openWhenComplete: true }),
      id = first.dialogue.id;
    assert.equal(first.dialogue.step, 'client');
    assert.equal(first.dialogue.options.length, 1);
    assert.equal(entry(f, id).data.patient, null);
    assert.equal(first.action, null);
    const operation =
      acceptance === 'yes'
        ? { text: 'Да' }
        : acceptance === 'name'
          ? { text: 'Анна Семёнова' }
          : { choice: first.dialogue.options[0].id };
    const accepted = f.answer(operation).result;
    assert.equal(accepted.dialogue.step, 'service');
    const identity = structuredClone(entry(f, id).data.patient);
    assert.equal(identity.id, f.patients[0].id);
    assert.equal(identity.confirmedSuggestion, true);
    for (const [text, step] of [
      ['Чистка', 'date'],
      [day, 'time'],
    ]) {
      const result = f.answer({ text }).result;
      assert.equal(result.dialogue.step, step);
      assert.deepEqual(entry(f, id).data.patient, identity);
      assert.doesNotMatch(result.text, /Анна.*верно|нужный клиент/iu);
    }
    const ready = f.answer({ text: 'В12:00' }).result;
    assert.equal(ready.dialogue, null);
    assert.equal(ready.action.patientId, identity.id);
    assert.deepEqual(entry(f, id).data.patient, identity);
    noSave(f);
  }
});

test('yes to two weak candidates never becomes a first-person default or a completed record', () => {
  const f = dialogueFixture();
  f.patients.push({ ...f.patients[0], id: 'same-name-other', phone: '+79990001002' });
  f.changed();
  const first = f.start(
      { query: 'Анна Семёнофа', serviceQuery: 'Чистка', date: day, time: '12:00' },
      { openWhenComplete: true },
    ),
    id = first.dialogue.id;
  assert.equal(first.dialogue.options.length, 2);
  const result = f.answer({ text: 'Да' }).result;
  assert.equal(result.dialogue.step, 'client');
  assert.equal(entry(f, id).data.patient, null);
  assert.equal(result.action, null);
  noSave(f);
});
