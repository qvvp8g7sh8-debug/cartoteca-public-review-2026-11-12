const { fail } = require('../../../../shared/errors.cjs');
const {
  keys,
  boundedText,
  validDate,
  normalizeIntent,
} = require('../interpretation/intent-schema.cjs');
const { fold } = require('./example-features.cjs');
const behaviorLimits = Object.freeze({
  maxExamples: 50,
  maxCandidateExamples: 50,
  maxEnabledExamples: 12,
  maxExampleTextChars: 500,
  maxEnabledExamplesBytes: 4096,
  maxInstructionsChars: 4000,
  maxDictionaryChars: 4000,
  maxRulesBytes: 65536,
  maxCodexInputBytes: 32768,
});
function compiledExamples(examples = []) {
  return JSON.stringify(
    examples
      .filter((example) => example.enabled)
      .map((example) => ({
        text: example.text,
        referenceDate: example.referenceDate,
        referenceTime: example.referenceTime,
        expected: example.expected,
      })),
  );
}
function normalizeExampleSelection(value = 'manual') {
  if (!['manual', 'automatic'].includes(value))
    throw fail(400, 'Выберите ручной или автоматический подбор примеров.');
  return value;
}
function stableExpected(value) {
  if (Array.isArray(value)) return value.map(stableExpected);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableExpected(value[key])]),
  );
}
function requireConsistentExamples(examples) {
  const expectedByContext = new Map();
  for (const example of examples.filter((item) => item.enabled)) {
    const context = JSON.stringify([
      fold(example.text).replace(/\s+/gu, ' ').trim(),
      example.referenceDate,
      example.referenceTime,
    ]);
    const expected = JSON.stringify(stableExpected(example.expected));
    if (expectedByContext.has(context) && expectedByContext.get(context) !== expected)
      throw fail(400, 'Для одинаковой фразы в одном контексте оставьте один ожидаемый результат.');
    expectedByContext.set(context, expected);
  }
}
function normalizeExamples(values, { exampleSelection = 'manual' } = {}) {
  const selection = normalizeExampleSelection(exampleSelection);
  if (!Array.isArray(values) || values.length > behaviorLimits.maxExamples)
    throw fail(400, 'Сохраните не более 50 примеров поведения.');
  const ids = new Set();
  const result = values.map((value) => {
    keys(value, ['id', 'text', 'referenceDate', 'referenceTime', 'enabled', 'expected']);
    if (
      typeof value.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id)
    )
      throw fail(400, 'Каждому примеру нужен уникальный UUID.');
    const id = value.id.toLowerCase();
    if (ids.has(id)) throw fail(400, 'Идентификаторы примеров не должны повторяться.');
    ids.add(id);
    const text = boundedText(
      value.text,
      behaviorLimits.maxExampleTextChars,
      'текст примера',
    ).trim();
    if (
      !text ||
      !validDate(value.referenceDate) ||
      typeof value.referenceTime !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.referenceTime) ||
      typeof value.enabled !== 'boolean'
    )
      throw fail(400, 'Укажите текст, дату, время и состояние каждого примера.');
    let expected;
    try {
      expected = normalizeIntent(value.expected);
    } catch (error) {
      throw fail(400, 'Некорректный ожидаемый результат: ' + error.message);
    }
    return {
      id,
      text,
      referenceDate: value.referenceDate,
      referenceTime: value.referenceTime,
      enabled: value.enabled,
      expected,
    };
  });
  if (selection === 'automatic') requireConsistentExamples(result);
  if (
    selection === 'manual' &&
    result.filter((example) => example.enabled).length > behaviorLimits.maxEnabledExamples
  )
    throw fail(400, 'Включите не более 12 примеров одновременно.');
  if (
    selection === 'manual' &&
    Buffer.byteLength(compiledExamples(result), 'utf8') > behaviorLimits.maxEnabledExamplesBytes
  )
    throw fail(400, 'Включённые примеры занимают больше 4 КБ. Сократите их или выключите часть.');
  return result;
}
function normalizeRules(value, { allowMissingExamples = false } = {}) {
  keys(value, ['instructions', 'dictionary', 'examples', 'exampleSelection']);
  const exampleSelection = normalizeExampleSelection(value.exampleSelection);
  const rules = {
    instructions: boundedText(
      value.instructions,
      behaviorLimits.maxInstructionsChars,
      'инструкции',
    ),
    dictionary: boundedText(value.dictionary, behaviorLimits.maxDictionaryChars, 'словарь'),
    exampleSelection,
    examples: normalizeExamples(
      value.examples === undefined && allowMissingExamples ? [] : value.examples,
      { exampleSelection },
    ),
  };
  if (Buffer.byteLength(JSON.stringify(rules), 'utf8') > behaviorLimits.maxRulesBytes)
    throw fail(400, 'Правила и примеры занимают больше 64 КБ. Сократите набор.');
  return rules;
}
function rulesFromPolicy(policy) {
  return normalizeRules(
    {
      instructions: policy.instructions,
      dictionary: policy.dictionary,
      examples: policy.examples,
      exampleSelection: policy.exampleSelection,
    },
    { allowMissingExamples: true },
  );
}
function applyRules(state, rules) {
  Object.assign(state.policy, normalizeRules(rules));
}
module.exports = {
  behaviorLimits,
  compiledExamples,
  normalizeExamples,
  normalizeExampleSelection,
  normalizeRules,
  rulesFromPolicy,
  applyRules,
};
