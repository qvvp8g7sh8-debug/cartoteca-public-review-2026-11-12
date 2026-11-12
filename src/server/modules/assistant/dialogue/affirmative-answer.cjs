const positive =
  '(?:вс[её] (?:верно|правильно)|ага|угу|верно|правильно|точно|подтверждаю|конечно|согласен|согласна|да)';
const separator = '(?:\\s+|\\s*[,‐‑‒–—-]\\s*)';
const affirmativeCombination = new RegExp(
  '^' + positive + '(?:' + separator + positive + '){0,3}$',
  'u',
);
function isAffirmativeAnswer(value) {
  if (typeof value !== 'string' || value.length > 160) return false;
  const text = value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/(?<!\.)[.!?]+$/u, (suffix) => (suffix.includes('..') ? suffix : ''))
    .replace(/\s+/gu, ' ')
    .trim();
  return /^да(?:(?:\s+|\s*[,‐‑‒–—-]\s*)да){0,7}$/u.test(text) || affirmativeCombination.test(text);
}
const confirmationActions = {
  create: '(?:запиши(?:те)?|записывай(?:те)?|записать|продолжай(?:те)?|продолжить)',
  cancel: '(?:отмени(?:те)?|отменить|отменяй(?:те)?|удали(?:те)?|удалить|удаляй(?:те)?)',
  move: '(?:перенеси(?:те)?|перенести|переноси(?:те)?|продолжай(?:те)?|продолжить)',
};
// Action suffixes are valid only at a caller's already bound confirmation gate.
function isConfirmationAnswer(value, action) {
  if (
    !Object.hasOwn(confirmationActions, action) ||
    typeof value !== 'string' ||
    value.length > 160
  )
    return false;
  if (isAffirmativeAnswer(value)) return true;
  const text = value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
  // A bare booking answer belongs only to an already bound create question.
  if (action === 'create' && text === 'записать') return true;
  if (
    ['cancel', 'move'].includes(action) &&
    new RegExp(
      '^' + confirmationActions[action] + '(?:\\s+(?:эту\\s+)?(?:запись|при[её]м))?$',
      'u',
    ).test(text)
  )
    return true;
  const suffix = new RegExp(
    '^(.*?)' +
      separator +
      confirmationActions[action] +
      '(?:\\s+(?:эту\\s+)?(?:запись|при[её]м))?$',
    'u',
  ).exec(text);
  return Boolean(suffix && isAffirmativeAnswer(suffix[1]));
}
module.exports = { isAffirmativeAnswer, isConfirmationAnswer };
