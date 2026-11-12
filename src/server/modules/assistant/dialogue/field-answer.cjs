const { readSteps } = require('./../read-steps.cjs');
// Natural wrappers apply only to the expected field, after a direct lookup misses.
const conflicting = /(?:^|[\s,;])(?:не|нет|или|либо|кроме|исключая)(?=$|[\s,;.!?])/iu;
function isSelfReference(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[.!?…]+$/u, '')
      .trim() === 'ко мне'
  );
}
function fieldAnswer(field, value) {
  const text = String(value || '').trim();
  if (conflicting.test(text)) return text;
  if (field === 'client') return text.replace(/^это\s+/iu, '').trim();
  if (field === 'staff')
    return isSelfReference(text) ? text : text.replace(/^(?:к|ко|у)\s+/iu, '').trim();
  if (field === 'service')
    return text
      .replace(/^пожалуйста[,\s]+/iu, '')
      .replace(/[,\s]+пожалуйста[.!?…]*$/iu, '')
      .trim()
      .replace(/^(?:(?:давайте|выбираю|хочу)[,\s]+(?:на\s+)?|да\s*,\s*|на\s+)/iu, '')
      .replace(/\s+с\s+кодом\s+(?=[A-Za-zА-Яа-яЁё-]*\d)/u, ' ')
      .trim();
  return text;
}
const resolveFieldAnswer = readSteps(function* resolveFieldAnswer(field, query, lookup) {
  const direct = yield lookup(query);
  if (direct.overflow || direct.matches.length) return { ...direct, query };
  const clean = fieldAnswer(field, query);
  if (!clean || clean === query) return { ...direct, query };
  const result = yield lookup(clean);
  return result.overflow || result.matches.length
    ? { ...result, query: clean }
    : { ...direct, query };
});
module.exports = { fieldAnswer, isSelfReference, resolveFieldAnswer };
