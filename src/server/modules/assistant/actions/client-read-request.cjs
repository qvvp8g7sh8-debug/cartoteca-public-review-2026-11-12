const {
  clientCardCommand,
  unsupportedCardObject,
} = require('../interpretation/client-card-grammar.cjs');
const { detectRequestedOperation } = require('../interpretation/requested-operation.cjs');
const { isClientCorrectionQuery } = require('../dialogue/client-correction.cjs');
const { normalizeName } = require('../language/names/name-forms.cjs');
const { nameTokens } = require('../language/names/name-matching.cjs');
const { expandClientSource } = require('../language/names/client-source-span.cjs');
const { parseClientPhoneAnswer } = require('../language/names/client-phone-answer.cjs');

const courtesy = '(?:пожалуйста[,\\s]+)?';
const search = new RegExp(
  '^' +
    courtesy +
    '(?:найди(?:те)?|найти)\\s+(?:мне\\s+)?(?:клиента|клиентку|клиентки)(?=$|[\\s,:])' +
    '[\\s,:]*(.*)$',
  'iu',
);
const list = new RegExp(
  '^' +
    courtesy +
    '(?:открой(?:те)?|покажи(?:те)?)\\s+(?:мне\\s+)?список\\s+клиентов(?=$|[\\s,:])' +
    '[\\s,:]*(.*)$',
  'iu',
);
// These are conditions/filters, never an identity shortcut. Unknown syntax falls
// back to the provider; directory matches and ambiguity remain the normal flow.
const filterWord =
  /^(?:(?:активн|неактивн|архивн|удаленн|последн|перв|нов|стар|люб)(?:ый|ий|ой|ая|ую|ого|ые|ых|ыми)|(?:не)?оплачен(?:ный|ная|ную|ные|ных)|котор(?:ый|ая|ую|ого|ые|ых))$/u;
const otherWords = new Set(
  (
    'все всех долг долги долгом должник должники тег тега тегом теги метка метку метки ' +
    'меткой фильтр фильтра фильтром фильтры возраст возраста скидка скидки скидкой ' +
    'телефона телефону номер номера адресу адрес почта почты почте карточки карты ' +
    'список клиентов записи приемы расписание настройки настройка настроек настройку ' +
    'интеграция интеграции интеграцию справка справку условия условии цвет цветом ' +
    'когда потом затем также тоже чтобы что где'
  ).split(' '),
);

function wholeIdentity(raw) {
  const query = raw.trim();
  if (!query) return '';
  if (query.length > 160) return null;
  const phoneSource = query.replace(/^по\s+(?:телефону|номеру)\s*:?\s*/iu, '');
  if (/^\+?[\d\s().-]+$/u.test(phoneSource))
    return parseClientPhoneAnswer(phoneSource)?.kind === 'full' ? phoneSource : null;
  const words = nameTokens(query);
  if (
    !words.length ||
    words.length > 4 ||
    words.some((word) => filterWord.test(word) || otherWords.has(word)) ||
    !isClientCorrectionQuery(normalizeName(query)) ||
    expandClientSource(query, query) !== query
  )
    return null;
  return query;
}

function clientReadIntent(raw) {
  if (typeof raw !== 'string' || raw.length > 512 || /[\r\n\u0000-\u001f\u007f]/u.test(raw))
    return null;
  const text = raw
    .normalize('NFKC')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim()
    .replace(/[,\s]+пожалуйста$/iu, '')
    .trim();
  if (unsupportedCardObject(text)) return null;
  const requested = detectRequestedOperation(text);
  if (requested.negated || requested.ambiguous) return null;
  const card = clientCardCommand(text, { allowSearchClient: false });
  // A whole infinitive card request is equivalent to the imperative. Statements
  // and an infinitive without an explicit card object retain model grounding.
  if (
    card &&
    (/^(?:пожалуйста[,\s]+)?открою(?=$|\s)/iu.test(text) ||
      (/^(?:пожалуйста[,\s]+)?открыть(?=$|\s)/iu.test(text) &&
        !/^(?:пожалуйста[,\s]+)?открыть\s+(?:мне\s+)?(?:карточку|карту)(?=$|[\s,:])/iu.test(text)))
  )
    return null;
  const found = card ? null : search.exec(text) || list.exec(text);
  if ((!card && !found) || card?.unsupported) return null;
  const intent = card ? 'clientCard' : 'clients';
  if (requested.intent && requested.intent !== intent) return null;
  const query = wholeIdentity(card ? card.query : found[1]);
  return query === null ? null : { intent, ...(query ? { query } : {}) };
}

module.exports = { clientReadIntent, wholeIdentity };
