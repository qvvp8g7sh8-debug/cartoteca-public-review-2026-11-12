const { suggestionsOnlyQuery } = require('../language/names/name-suggestions.cjs');
const { continuationQuestion } = require('./continuation/continuation-contract.cjs');
const targets = {
  клиента: 'client',
  специалиста: 'staff',
  сотрудника: 'staff',
  услугу: 'service',
  дату: 'date',
  время: 'time',
  длительность: 'duration',
};
function rawClarificationTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  if (suggestionsOnlyQuery(raw)) return 'client';
  const text = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
  const match =
    /^(?:я не уверен(?:а)?[, ]+)?(?:(?:давай|давайте) )?(?:уточни(?:те)?|переспроси(?:те)?|уточним|проверим|проверь(?:те)?) (клиента|специалиста|сотрудника|услугу|дату|время|длительность)$/u.exec(
      text,
    );
  return match ? targets[match[1]] : null;
}
function rawClarificationView(raw) {
  const field = rawClarificationTarget(raw);
  return field
    ? {
        step: field,
        prompt: continuationQuestion(field),
        choices: [],
        input: {
          type: ['client', 'staff', 'service'].includes(field)
            ? 'text'
            : field === 'duration'
              ? 'number'
              : field,
          field,
        },
      }
    : null;
}
module.exports = { rawClarificationTarget, rawClarificationView };
