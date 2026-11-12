// One finite grammar for client-card aliases, source extraction and dialogue guards.
const cardNounPattern = '(?:карточку|карту)';
const cardOpenForms = '(?:открой(?:те)?|открою|открыть|покажи(?:те)?|найди(?:те)?|найти)';
const cardNegativeForms = '(?:открывай(?:те)?|показывай(?:те)?|ищи(?:те)?)';
const boundary = '(?=$|[\\s,.!?;:…])';
const clientRole = '(?:клиента|клиентки)';
const cardObject =
  '(?:' +
  cardNounPattern +
  boundary +
  '(?:\\s+' +
  clientRole +
  boundary +
  ')?|' +
  clientRole +
  boundary +
  ')';
const head = new RegExp(
  '^(?:пожалуйста[,\\s]+)?(' + cardOpenForms + ')' + boundary + '\\s*(?:мне\\s+)?',
  'iu',
);
const object = new RegExp('^' + cardObject + '[\\s,:]*', 'iu');
const readCommand = new RegExp(
  '(?:^|[\\s,;:])(?:' +
    cardOpenForms +
    '|' +
    cardNegativeForms +
    '|посмотри)\\s+(?:мне\\s+)?' +
    cardNounPattern +
    boundary,
  'iu',
);
const foreignBeforeObject =
  '(?:банковск[а-я]*|плат[её]жн[а-я]*|кредитн[а-я]*|дебетов[а-я]*|географическ[а-я]*)\\s+' +
  cardNounPattern;
const foreignAfterObject =
  cardNounPattern +
  '\\s+(?:мира|сайта|местности|города|оплат[а-я]*|банка|банковск[а-я]*|для\\s+оплат[а-я]*)';
const foreignBefore = new RegExp('(?:^|[\\s,;:])' + foreignBeforeObject + boundary, 'iu');
const foreignAfter = new RegExp('(?:^|[\\s,;:])' + foreignAfterObject + boundary, 'iu');
const wholeForeignObject = new RegExp(
  '^(?:' + foreignBeforeObject + '|' + foreignAfterObject + ')$',
  'iu',
);
function unsupportedCardTarget(value) {
  return typeof value === 'string' && wholeForeignObject.test(value);
}
function unsupportedCardObject(value) {
  const text = String(value || '');
  // Explicit client roles keep unusual names such as «карту клиента Миры» legal.
  return foreignBefore.test(text) || foreignAfter.test(text);
}
function clientCardCommand(value, { requireObject = true, allowSearchClient = true } = {}) {
  const text = String(value || '').trim();
  const opener = head.exec(text);
  if (!opener) return null;
  const tail = text.slice(opener[0].length),
    namedObject = object.exec(tail);
  const unsupported = unsupportedCardObject(text);
  if (requireObject && !namedObject && !unsupported) return null;
  // «Найди клиента» remains ordinary search in demo, while source stripping
  // also supports it inside a model-grounded card command.
  if (
    !allowSearchClient &&
    /^най/iu.test(opener[1]) &&
    !new RegExp('^' + cardNounPattern + boundary, 'iu').test(tail)
  )
    return null;
  return {
    query: tail.slice(namedObject?.[0].length || 0).trim(),
    unsupported,
  };
}
function containsCardCommand(value) {
  return readCommand.test(String(value || '')) || unsupportedCardObject(value);
}
module.exports = {
  cardNounPattern,
  cardOpenForms,
  cardNegativeForms,
  clientCardCommand,
  containsCardCommand,
  unsupportedCardObject,
  unsupportedCardTarget,
};
