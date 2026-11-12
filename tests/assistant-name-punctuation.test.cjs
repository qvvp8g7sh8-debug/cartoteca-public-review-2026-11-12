const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesName, searchPlan } = require('../src/server/modules/assistant/language/names/name-matching.cjs');
const { resolveClient } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');

test('terminal ASR sentence punctuation does not hide a complete existing client name or rewrite stored spelling', () => {
  const f = dialogueFixture(); const saved = JSON.stringify(f.patients);
  for (const query of ['Анна Семёнова.', 'Анну Семенову!', 'Семеновой Анне?', 'Анна Семенова…', 'Анна Семенова?!']) {
    const result = resolveClient(f.c, query);
    assert.equal(result.overflow, false, query);
    assert.deepEqual(result.matches.map(row => row.id), [f.patients[0].id], query);
    assert.ok(searchPlan(query).queries.length > 0, query);
  }
  assert.equal(JSON.stringify(f.patients), saved);
});

test('terminal punctuation keeps staff complete-token declension and case matching', () => {
  const person = { displayName: 'Мария Соколова' };
  for (const query of ['Мария Соколова.', 'Марии Соколовой!', 'Соколову Марию…'])
    assert.equal(matchesName(person, query, true), true, query);
});

test('sentence punctuation handling does not admit initials, embedded punctuation, partial names or extra commands', () => {
  const f = dialogueFixture();
  for (const query of ['Анн.', 'А. Семенова', 'Анна, Семенова', 'Анна; Семенова', 'Анна / Семенова', 'Анна Семенова сохрани.', 'Анна\nудали клиента.', '?!', '…']) {
    assert.equal(matchesName(f.patients[0], query), false, query);
    assert.deepEqual(resolveClient(f.c, query).matches, [], query);
  }
});

test('ordinary client and staff answers ending in a sentence progress locally without saving', () => {
  const f = dialogueFixture(); const first = f.start({ serviceQuery: 'Чистка', date: day, time: '10:00' });
  assert.equal(first.dialogue.step, 'client');
  const client = f.answer({ text: 'Анна Семёнова.' }).result;
  assert.equal(client.dialogue.step, 'review'); assert.equal(client.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
  f.start({ query: 'Анна Семёнова', staffQuery: 'Неизвестный специалист', date: day, time: '10:00' });
  assert.equal(f.result.dialogue.step, 'staff');
  const staff = f.answer({ text: 'Тестовый Специалист.' }).result;
  assert.equal(staff.dialogue.step, 'service');
  assert.equal(staff.dialogue.fields.find(row => row.key === 'staff').value, 'Тестовый Специалист');
  assert.equal(staff.action, null); assert.equal(f.patients[0].appointments.length, 0);
});
