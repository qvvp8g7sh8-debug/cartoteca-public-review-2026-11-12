const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const field = (r, key) => r.dialogue?.fields.find((row) => row.key === key)?.value;
function fixture() {
  const f = dialogueFixture();
  f.services.splice(0, f.services.length, { id: 'primary', name: 'Первичная консультация', duration: 30, staffId: 'owner' });
  f.start({ query: 'Анна Семёнова', date: day, time: '10:00', duration: 45 });
  assert.equal(f.result.dialogue.step, 'service');
  return f;
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('a courteous service answer resolves the actual catalog while retaining explicit draft values', () => {
  for (const text of ['давайте первичную консультацию', 'давайте на первичную консультацию', 'выбираю первичную консультацию', 'хочу на первичную консультацию', 'первичную консультацию, пожалуйста', 'пожалуйста, первичную консультацию']) {
    const f = fixture();
    const result = f.answer({ text }).result;
    assert.equal(result.dialogue.step, 'review', text);
    assert.equal(field(result, 'service'), 'Первичная консультация', text);
    assert.equal(field(result, 'date'), day, text);
    assert.equal(field(result, 'time'), '10:00', text);
    assert.equal(field(result, 'duration'), '45 мин', text);
    const ready = f.answer({ text: 'открой форму' }).result;
    assert.deepEqual(ready.action.serviceIds, ['primary'], text);
    assert.equal(ready.action.duration, 45, text);
    noSave(f);
  }
});

test('a literal catalog title takes priority over a conversational interpretation', () => {
  const f = fixture();
  f.services.push({ id: 'literal', name: 'Давайте первичную консультацию', duration: 60, staffId: 'owner' });
  const result = f.answer({ text: 'Давайте первичную консультацию' }).result;
  assert.equal(field(result, 'service'), 'Давайте первичную консультацию');
  assert.deepEqual(f.answer({ text: 'открой форму' }).result.action.serviceIds, ['literal']);
  noSave(f);
});

test('an ambiguous courteous service answer stays a choice and never picks the first match', () => {
  const f = fixture();
  f.services.push({ id: 'repeat', name: 'Повторная консультация', duration: 20, staffId: 'owner' });
  const result = f.answer({ text: 'давайте консультацию' }).result;
  assert.equal(result.dialogue.step, 'service');
  assert.equal(field(result, 'service'), undefined);
  assert.equal(result.dialogue.options.length, 2);
  assert.equal(result.action, null);
  noSave(f);
});

test('negations alternatives conditions and extra commands never become an affirmative service choice', () => {
  for (const text of ['давайте не первичную консультацию', 'первичную или повторную консультацию, пожалуйста', 'хочу на первичную консультацию если можно', 'давайте первичную консультацию и открой форму', 'давайте первичную консультацию и сохрани']) {
    const f = fixture();
    try { f.answer({ text }); } catch (error) { assert.equal(error.status, 400, text); }
    assert.equal(f.result.dialogue.step, 'service', text);
    assert.equal(field(f.result, 'service'), undefined, text);
    assert.equal(f.result.action, null, text);
    assert.equal(field(f.result, 'duration'), '45 мин', text);
    noSave(f);
  }
});

test('a polite answer searches only the selected employee catalog', () => {
  const f = fixture();
  f.services.splice(0, f.services.length, { id: 'own', name: 'Чистка', duration: 30, staffId: 'owner' }, { id: 'foreign', name: 'Первичная консультация', duration: 30, staffId: 'foreign' });
  const result = f.answer({ text: 'давайте первичную консультацию' }).result;
  assert.equal(result.dialogue.step, 'service');
  assert.equal(field(result, 'service'), undefined);
  assert.equal(result.action, null);
  assert.ok(result.dialogue.options.every((row) => !row.label.includes('Первичная')));
  noSave(f);
});
