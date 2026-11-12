const { fail } = require('../../../../shared/errors.cjs');
const { commandCategory } = require('./intent-schema.cjs');
const { intentNames } = require('./intent-contract.cjs');
const CODEX_INPUT_BYTES = 32768;
function promptBytes(messages) {
  return Buffer.byteLength(JSON.stringify({ messages }) + '\n', 'utf8');
}
function promptBudget(state, messages) {
  const bytes = promptBytes(messages);
  const limit = state.providers?.llm?.provider === 'codex' ? CODEX_INPUT_BYTES : null;
  if (limit !== null && bytes > limit)
    throw fail(
      413,
      'Инструкции, словарь и текущая реплика занимают ' +
        bytes +
        ' байт при лимите Codex ' +
        limit +
        '. Сократите инструкции или словарь в настройках помощника. Реплика не обрезана.',
    );
  return { bytes, limit, remaining: limit === null ? null : limit - bytes };
}
function capabilities(policy) {
  // The stored switches are categories; the model must see an explicit flag
  // for every intent using the same category mapping as server authorization.
  const commands = Object.fromEntries(
    intentNames.map((intent) => [
      intent,
      intent === 'help' || policy.commands?.[commandCategory(intent)] === true,
    ]),
  );
  return (
    'Доступные действия (commands, данные): ' +
    JSON.stringify({ commands, intents: intentNames.filter((intent) => commands[intent]) }) +
    '. commands содержит явное разрешение каждого intent; false означает help. Сервер повторно проверяет разрешения.'
  );
}
module.exports = { CODEX_INPUT_BYTES, promptBytes, promptBudget, capabilities };
