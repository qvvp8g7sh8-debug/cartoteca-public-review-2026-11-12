const { normalizeName, inverseForms, firstNameKind, nameForms } = require('./name-forms.cjs');
const { nameSuggestionPlan } = require('./name-suggestions.cjs');
const { isBookingCommandWord } = require('../../dialogue/booking-command-words.cjs');
const { detectRequestedOperation } = require('../../interpretation/requested-operation.cjs');
const { spokenNumber } = require('../time/spoken-number.cjs');
const { monthWord } = require('../time/spoken-day.cjs');
const limits = Object.freeze({
  requestChars: 4096,
  queryChars: 160,
  tokens: 128,
  nameTokens: 4,
  tokenChars: 48,
});
const fold = (value) => normalizeName(String(value).normalize('NFKC'));
const stop = new Set(
  (
    'в во с со к ко у на по для от до после перед без при через между про за под о об ' +
    'и или либо а но не нет кроме исключая вместо если тогда ' +
    'открой откройте открыть подготовь подготовьте подготовить сделай сделайте ' +
    'покажи покажите найти найди найдите выбери выберите перенеси перенесите ' +
    'возьмем возьми возьмите выберем выбираем поставь поставьте поставим оставь оставьте ' +
    'поменяй поменяйте измени измените исправь исправьте замени замените ' +
    'пожалуйста здравствуйте добрый доброго спасибо давайте давай можно нужно надо хочу хочу ' +
    'мне меня мой моя мое мои мою моих ему ей его ее их нас нам вас вам тебя тебе ' +
    'этот эта это эти этого этой этих эту тот та то те того той тех ту ' +
    'карта карту карточка карточку клиент клиента клиентку клиентки человек человека зовут имени имя телефон ' +
    'запись приема прием услуга услуги услугу специалист специалиста сотрудник сотрудника ' +
    'сегодня завтра послезавтра вчера позавчера ближайший ближайшую следующий следующую ' +
    'утра утром дня днем вечера вечером ночи ночью полдень полночь время дату дата ' +
    'час часа часов минут минуты минута минуту числа число ' +
    'день дня дней дню днем дне дни дням днями днях неделя недели неделю неделе недель ' +
    'месяц месяца месяцу месяцем месяце месяцев год года году годом годе годы годов лет ' +
    'понедельник понедельника понедельнику вторник вторника вторнику среда среды среду ' +
    'четверг четверга четвергу пятница пятницы пятницу суббота субботы субботу воскресенье воскресенья ' +
    'процедуру процедура процедуры'
  ).split(' '),
);
const uncertain = new Set(['не', 'нет', 'или', 'либо', 'кроме', 'исключая', 'вместо', 'если']);
const month = new RegExp('^(?:' + monthWord + ')$', 'u');
const ordinal =
  /^(?:перв|втор|трет|четверт|пят|шест|седьм|восьм|девят|десят|одиннадцат|двенадцат|тринадцат|четырнадцат|пятнадцат|шестнадцат|семнадцат|восемнадцат|девятнадцат|двадцат|тридцат)(?:ый|ой|ий|ого|ому|ом|ое|ая|ую|ые|ых)$/u;
function tokenize(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:[\p{Pd}\u2212'’\u02bc][\p{L}\p{N}]+)*/gu)].map(
    (match) => ({
      raw: match[0],
      word: fold(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
}
function nameWord(token) {
  return (
    /^[\p{L}]+(?:[-'][\p{L}]+)*$/u.test(token.word) &&
    token.word.length <= limits.tokenChars &&
    token.word.replace(/[-']/gu, '').length >= 2 &&
    !stop.has(token.word) &&
    !isBookingCommandWord(token.word) &&
    !month.test(token.word) &&
    !ordinal.test(token.word) &&
    spokenNumber(token.word, 100000) === null
  );
}
// Model names only locate whole source tokens; only the full original span reaches lookup.
function expandClientSource(request, query, { serviceQuery = '', staffQuery = '' } = {}) {
  if (
    typeof request !== 'string' ||
    typeof query !== 'string' ||
    request.length > limits.requestChars ||
    !query.trim() ||
    query.length > limits.queryChars
  )
    return '';
  const operation = detectRequestedOperation(request);
  if (operation.sameAppointmentSave) request = operation.sourceWithoutCommand;
  if (/^[+\d\s().-]+$/u.test(query) && /^\d{10,15}$/u.test(query.replace(/\D/gu, ''))) {
    const digits = query.replace(/\D/gu, ''),
      phones = new Set();
    for (const match of request.matchAll(/(?<![\p{L}\d])\+?\d[\d\s().-]{8,35}\d(?![\p{L}\d])/gu))
      if (match[0].replace(/\D/gu, '') === digits) phones.add(match[0].trim());
    return phones.size === 1 ? [...phones][0] : '';
  }
  const tokens = tokenize(request),
    wanted = tokenize(query);
  if (
    !wanted.length ||
    wanted.length > limits.nameTokens ||
    tokens.length > limits.tokens ||
    !wanted.every(nameWord)
  )
    return '';
  const soft = (left, right) =>
    /^[\s,]*$/u.test(request.slice(tokens[left].end, tokens[right].start)) &&
    !/[\r\n]/u.test(request.slice(tokens[left].end, tokens[right].start));
  const matches = (at, words) =>
    at + words.length <= tokens.length &&
    words.every(
      (token, index) =>
        tokens[at + index].word === token.word && (index === 0 || soft(at + index - 1, at + index)),
    );
  const protectedSpans = [];
  for (const span of [serviceQuery, staffQuery]) {
    if (typeof span !== 'string' || span.length > limits.queryChars) continue;
    const words = tokenize(span);
    if (!words.length || words.length > limits.tokens) continue;
    const occurrences = [];
    for (let at = 0; at < tokens.length; at++)
      if (matches(at, words)) occurrences.push([at, at + words.length - 1]);
    if (occurrences.length) protectedSpans.push(occurrences);
  }
  // Ownership belongs to an occurrence, not every copy of the same text. A
  // catalog title may also be a surname inside the proved client anchor.
  const protectedFor = (first, last) => {
    const protectedTokens = new Set();
    for (const occurrences of protectedSpans) {
      const disjoint = occurrences.filter(([start, end]) => end < first || start > last);
      if (!disjoint.length) return null;
      for (const [start, end] of disjoint)
        for (let at = start; at <= end; at++) protectedTokens.add(at);
    }
    return protectedTokens;
  };
  const canExtend = (from, to, protectedTokens) =>
    to >= 0 &&
    to < tokens.length &&
    !protectedTokens.has(to) &&
    nameWord(tokens[to]) &&
    soft(Math.min(from, to), Math.max(from, to));
  const ambiguousEdge = (at, edge, protectedTokens) => {
    if (at < 0 || at >= tokens.length || !soft(Math.min(at, edge), Math.max(at, edge)))
      return false;
    if (uncertain.has(tokens[at].word)) return true;
    const next = at + (at > edge ? 1 : -1);
    return (
      (at > edge ? ['и', 'а', 'но'] : ['и']).includes(tokens[at].word) &&
      next >= 0 &&
      next < tokens.length &&
      soft(Math.min(at, next), Math.max(at, next)) &&
      (uncertain.has(tokens[next].word) || (!protectedTokens.has(next) && nameWord(tokens[next])))
    );
  };
  const anchors = [];
  for (let at = 0; at < tokens.length; at++)
    if (matches(at, wanted)) anchors.push([at, at + wanted.length - 1]);
  if (!anchors.length) {
    const forms = new Set();
    for (const word of new Set(nameSuggestionPlan(query).variants.flat())) {
      for (const form of nameForms(word, 'first')) forms.add(form);
      for (const base of inverseForms(word))
        if (firstNameKind(base) && nameForms(base, 'first').includes(word))
          for (const form of nameForms(base, 'first')) forms.add(form);
    }
    for (let at = 0; at < tokens.length; at++) {
      const token = tokens[at];
      if (!nameWord(token)) continue;
      const joined = [...forms].some(
        (form) =>
          (token.word.startsWith(form) && /^[\p{L}]{5,48}$/u.test(token.word.slice(form.length))) ||
          (token.word.endsWith(form) && /^[\p{L}]{5,48}$/u.test(token.word.slice(0, -form.length))),
      );
      // The proposal locates a whole raw token. Directory candidates must still prove
      // every name component; an unfamiliar given name need not be in a static list.
      if (forms.has(token.word) || joined) anchors.push([at, at]);
    }
  }
  const candidates = new Map();
  for (const [at, end] of anchors) {
    const protectedTokens = protectedFor(at, end);
    if (!protectedTokens) return '';
    let first = at,
      last = end;
    while (canExtend(first, first - 1, protectedTokens)) first--;
    while (canExtend(last, last + 1, protectedTokens)) last++;
    if (
      last - first + 1 > limits.nameTokens ||
      ambiguousEdge(first - 1, first, protectedTokens) ||
      ambiguousEdge(last + 1, last, protectedTokens)
    )
      return '';
    const raw = request.slice(tokens[first].start, tokens[last].end);
    if (raw.length > limits.queryChars) return '';
    candidates.set(fold(raw), raw);
  }
  return candidates.size === 1 ? [...candidates.values()][0] : '';
}
module.exports = { expandClientSource };
