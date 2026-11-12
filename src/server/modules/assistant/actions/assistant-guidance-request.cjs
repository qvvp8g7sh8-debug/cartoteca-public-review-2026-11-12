const {
  cardOpenForms,
  unsupportedCardTarget,
} = require('../interpretation/client-card-grammar.cjs');

const capabilities =
  /^(?:помощь|справка|что (?:ты|вы) (?:умеешь|умеете|можешь(?: сделать)?|можете(?: сделать)?)|что (?:умеет|может(?: сделать)?) помощник|какие (?:команды|действия|возможности)(?: (?:доступны|поддерживаются))?(?: у помощника)?)$/iu;
const card = new RegExp('^(' + cardOpenForms + ')\\s+(?:мне\\s+)?(.+)$', 'iu');

// Whole assistant-directed speech acts only. A known word inside an unknown
// command, person name, condition or second task cannot select a terminal reply.
function assistantGuidanceRequest(raw) {
  if (typeof raw !== 'string' || raw.length > 512 || /[\r\n\u0000-\u001f\u007f]/u.test(raw))
    return null;
  const text = raw
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .replace(/^пожалуйста[,\s]+/iu, '')
    .replace(/[,\s]+пожалуйста$/iu, '')
    .trim();
  if (capabilities.test(text)) return 'capabilities';
  const match = card.exec(text);
  if (match && !/^открою$/iu.test(match[1]) && unsupportedCardTarget(match[2]))
    return 'unsupportedCard';
  return null;
}
module.exports = { assistantGuidanceRequest };
