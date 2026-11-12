const test = require('node:test');
const assert = require('node:assert/strict');
const { handoff } = require('../src/server/modules/assistant/actions/actions.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
function fixture() {
  const f = dialogueFixture();
  f.state.policy.commands.calendar = true;
  f.members.push(
    { accountId: 'staff-a', displayName: 'Ирина Орлова', role: 'cosmetologist', status: 'active' },
    { accountId: 'staff-b', displayName: 'Ирина Петрова', role: 'cosmetologist', status: 'active' },
  );
  return f;
}
function clarify(f, intent) {
  const before = JSON.stringify(f.patients);
  const result = handoff(f.c, intent, f.state, f.clock);
  assert.equal(result.action, null);
  for (const key of ['dialogue', 'fields', 'slots', 'availability'])
    assert.equal(result[key], undefined);
  assert.match(result.text, /повторите.*(?:запрос.*целиком|полный запрос)/iu);
  assert.doesNotMatch(result.text, /(?:сохранил|запомнил|продолжим с прежн)/iu);
  assert.equal(JSON.stringify(f.patients), before);
  return result;
}
test('standalone calendar staff ambiguity asks for a complete request with full staff name and date', () => {
  const result = clarify(fixture(), { intent: 'calendar', staffQuery: 'Ирина', date: day });
  assert.match(result.text, /полное имя.*дат/iu);
  assert.match(result.text, /разрешённое вам расписание/iu);
});
test('standalone availability staff ambiguity requires the complete period and duration again', () => {
  const result = clarify(fixture(), {
    intent: 'availability',
    staffQuery: 'Ирина',
    date: day,
    duration: 30,
  });
  assert.match(result.text, /полное имя.*период.*длительность/iu);
});
test('standalone availability service ambiguity asks to repeat the service and performer instead of retaining a hidden search', () => {
  const f = fixture();
  f.services.push({ ...f.services[0], id: 'clean-other', staffId: 'staff-a' });
  const result = clarify(f, { intent: 'availability', serviceQuery: 'Чистка', date: day });
  assert.match(result.text, /точное название услуги.*полное имя.*период/iu);
  assert.match(result.text, /не буду угадывать длительность/iu);
});
test('standalone availability duration conflict explains the two complete corrected-request alternatives', () => {
  const result = clarify(fixture(), {
    intent: 'availability',
    serviceQuery: 'Чистка',
    date: day,
    duration: 45,
  });
  assert.match(result.text, /без услуги.*длительностью выбранной услуги/iu);
});
test('an active preparation still accepts an opaque staff choice within its current dialogue', () => {
  const f = fixture();
  const first = f.start({ query: 'Анна Семёнова', staffQuery: 'Ирина', date: day, time: '10:00' });
  assert.equal(first.dialogue.step, 'staff');
  assert.equal(first.dialogue.options.length, 2);
  const { result } = f.answer({ choice: first.dialogue.options[0].id });
  assert.equal(result.dialogue.id, first.dialogue.id);
  assert.ok(result.dialogue.version > first.dialogue.version);
  assert.notEqual(result.dialogue.step, 'staff');
  assert.doesNotMatch(result.text, /повторите.*(?:целиком|полный запрос)/iu);
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});
