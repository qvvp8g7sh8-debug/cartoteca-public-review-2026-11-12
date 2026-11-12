const test = require('node:test');
const assert = require('node:assert/strict');
const { nameSuggestionPlan, rankNameSuggestions, SUGGESTION_LIMITS } =
  require('../src/server/modules/assistant/language/names/name-suggestions.cjs');
const { patientSearchText } = require('../src/shared/patient-names.cjs');

test('literal source edges keep their reserved budget before optional ё or spoken hypotheses', () => {
  const plan = nameSuggestionPlan('Алёна Петровна');
  for (const literal of ['петр', 'ален', 'овна', 'лена'])
    assert.ok(plan.queries.includes(literal), literal);
  assert.ok(plan.queries.length <= SUGGESTION_LIMITS.queries);
  assert.equal(new Set(plan.queries).size, plan.queries.length);
});

test('a joined declined surname keeps an internal ё candidate gram without losing its four literals', () => {
  const plan = nameSuggestionPlan('анюсименову');
  for (const literal of ['симе', 'нову', 'мено', 'имен'])
    assert.ok(plan.queries.includes(literal), literal);
  assert.ok(plan.queries.includes('мёно'), 'The stored literal ё spelling must remain retrievable');
  assert.ok(plan.queries.length <= SUGGESTION_LIMITS.queries);
  const candidate = { id: 'synthetic-joined-anna', firstName: 'Анна', lastName: 'Семёнова',
    middleName: '', name: 'Анна Семёнова', phone: '' };
  assert.ok(plan.queries.some(query => patientSearchText(candidate).includes(query)));
  assert.deepEqual(rankNameSuggestions([candidate], plan).map(row => row.id), [candidate.id]);
  assert.equal(candidate.lastName, 'Семёнова', 'Candidate-only aliases never rewrite stored identity');
});
