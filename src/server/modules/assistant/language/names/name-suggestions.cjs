const { nameTokens } = require('./name-matching.cjs');
const { normalizeName } = require('./name-forms.cjs');
const { isBookingCommandWord } = require('../../dialogue/booking-command-words.cjs');
const { knownGivenForm, spokenNameQueries } = require('./name-phonetics.cjs');
const { rankNameSuggestions } = require('./name-suggestion-ranking.cjs');
const SUGGESTION_LIMITS = Object.freeze({
  queries: 8,
  perQuery: 50,
  candidates: 200,
  results: 5,
  queryChars: 160,
  tokenChars: 48,
});
const commands = new Set(
  (
    'сохрани сохраните сохранить сохраняй сохраняйте сохранять ' +
    'открой откройте открыть открывай открывайте открывать ' +
    'удали удалите удалить удаляй удаляйте удалять ' +
    'отправь отправьте отправить отправляй отправляйте отправлять ' +
    'отмени отмените отменить отменяй отменяйте отменять ' +
    'покажи покажите показать найди найдите найти перенеси перенесите перенести ' +
    'стоп отмена прекрати прекратите форма форму календарь клиент клиента ' +
    'выбери выберите выбирать вариант варианты окно окна подтверждаю подтверди ' +
    'поменяй поменяйте поменять измени измените изменить исправь исправьте исправить ' +
    'замени замените заменить сдвинь сдвиньте сдвинуть посмотри посмотрите посмотреть ' +
    'включи включите включить включай включайте включать ' +
    'выключи выключите выключить выключай выключайте выключать ' +
    'создай создайте создать создавай создавайте создавать ' +
    'добавь добавьте добавить добавляй добавляйте добавлять ' +
    'выйди выйдите выйти выходи выходите выходить ' +
    'запусти запустите запустить запускай запускайте запускать ' +
    'выполни выполните выполнить выполняй выполняйте выполнять ' +
    'оплати оплатите оплатить оплачивай оплачивайте оплачивать ' +
    'обнови обновите обновить обновляй обновляйте обновлять ' +
    'закрой закройте закрыть закрывай закрывайте закрывать ' +
    'закончи закончите закончить заканчивай заканчивайте заканчивать ' +
    'верни верните вернуть возвращай возвращайте возвращать ' +
    'расскажи расскажите рассказать рассказывай рассказывайте рассказывать ' +
    'переключи переключите переключить переключай переключайте переключать ' +
    'повтори повторите повторить повторяй повторяйте повторять ' +
    'подтвердите подтвердить назад вернись вернитесь вернуться шаг через после до в на ' +
    'да нет пожалуйста сегодня завтра послезавтра позже раньше'
  ).split(' '),
);
function inputTokens(value) {
  if (typeof value !== 'string' || value.length > SUGGESTION_LIMITS.queryChars) return [];
  const words = nameTokens(value);
  return !words.length ||
    words.length > 5 ||
    words.some(
      (word) =>
        word.length > SUGGESTION_LIMITS.tokenChars ||
        commands.has(word) ||
        isBookingCommandWord(word),
    )
    ? []
    : words;
}
// A missing space is a suggestion hypothesis, never a strict identity match.
function joinedNameVariants(words) {
  if (!words.length || words.length > 3) return [];
  const variants = [],
    known = new Map();
  const given = (word) => {
    if (!known.has(word)) known.set(word, knownGivenForm(word));
    return known.get(word);
  };
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!/^[\p{L}]{7,48}$/u.test(word)) continue;
    for (let split = 2; split <= word.length - 2; split++) {
      const left = word.slice(0, split),
        right = word.slice(split);
      if (!((right.length >= 5 && given(left)) || (left.length >= 5 && given(right)))) continue;
      const tokens = [...words.slice(0, index), left, right, ...words.slice(index + 1)];
      if (tokens.some((token) => commands.has(token) || isBookingCommandWord(token))) continue;
      if (!variants.some((prior) => prior.join(' ') === tokens.join(' '))) variants.push(tokens);
      // More possible boundaries require a clearer name instead of truncating hypotheses.
      if (variants.length > 8) return [];
    }
  }
  return variants;
}
function rawJoinedName(request, proposal) {
  const words = inputTokens(proposal);
  if (words.length !== 2) return '';
  const literal = words.join(' ');
  const boundary = "[^\\p{L}\\p{N}'-]";
  if (
    new RegExp('(?:^|' + boundary + ')' + literal + '(?=$|' + boundary + ')', 'u').test(
      normalizeName(request),
    )
  )
    return '';
  const wanted = words.join('');
  if (!joinedNameVariants([wanted]).some((parts) => parts.join(' ') === words.join(' '))) return '';
  const tokens = String(request || '').match(/[\p{L}\p{N}'’\u02bc\u2010-\u2015\u2212-]+/gu) || [];
  return tokens.find((token) => nameTokens(token)[0] === wanted) || '';
}
function suggestionsOnlyQuery(value) {
  const words = inputTokens(value);
  return (
    words.length === 2 &&
    words[0] === 'не' &&
    !joinedNameVariants([words[1]]).length &&
    /^[\p{L}'-]{5,48}$/u.test(words[1]) &&
    words[1].replace(/[-']/gu, '').length >= 5
  );
}
function nameSuggestionPlan(query) {
  const words = inputTokens(query),
    variants = [],
    excluded = [],
    joined = words.includes('не') ? [] : joinedNameVariants(words);
  const add = (tokens) => {
    if (
      tokens.length <= 4 &&
      tokens.every(
        (word) => word.replace(/[-']/gu, '').length >= 2 && !isBookingCommandWord(word),
      ) &&
      !variants.some((prior) => prior.join(' ') === tokens.join(' '))
    )
      variants.push(tokens);
  };
  if (words.length && !words.includes('не')) {
    add(words);
    for (const parts of joined) add(parts);
  }
  for (let index = 0; index + 1 < words.length; index++) {
    if (words[index].length > 2 && words[index + 1].length > 2) continue;
    const joined = words[index] + words[index + 1];
    if (joined.length < 5 || joined.length > SUGGESTION_LIMITS.tokenChars) continue;
    add([...words.slice(0, index), joined, ...words.slice(index + 2)]);
    if (words[index] === 'не') excluded.push([...words.slice(0, index), ...words.slice(index + 1)]);
  }
  for (let index = 0; index < words.length; index++)
    if (words[index].startsWith('не') && words[index].slice(2).replace(/[-']/gu, '').length >= 5)
      excluded.push([...words.slice(0, index), words[index].slice(2), ...words.slice(index + 1)]);
  const anchors = [
    ...new Set((joined.length ? joined : variants).flat().filter((word) => word.length >= 5)),
  ].sort((a, b) => b.length - a.length);
  const literal = [],
    aliases = [];
  const append = (rows, value) => {
    if (!rows.includes(value)) rows.push(value);
  };
  const yoAliases = (word) => {
    const values = [];
    for (let index = 0; index < word.length; index++)
      if (word[index] === 'е') values.push(word.slice(0, index) + 'ё' + word.slice(index + 1));
    return values;
  };
  for (const width of [4, 3]) {
    const sequences = anchors.map((word) => {
      const count = word.length - width + 1;
      const positions = [
        ...new Set([
          0,
          count - 1,
          Math.floor((count - 1) / 2),
          Math.floor((count - 1) / 4),
          Math.floor((3 * (count - 1)) / 4),
          Math.floor((count - 1) / 8),
          Math.floor((7 * (count - 1)) / 8),
          Math.floor((3 * (count - 1)) / 8),
          Math.floor((5 * (count - 1)) / 8),
          ...Array.from({ length: count }, (_, index) => index),
        ]),
      ];
      return positions.map((index) => word.slice(index, index + width));
    });
    const grams = [];
    for (let index = 0; index < Math.max(0, ...sequences.map((items) => items.length)); index++)
      for (const sequence of sequences)
        if (sequence[index] && !grams.includes(sequence[index])) grams.push(sequence[index]);
    for (const gram of grams) {
      append(literal, gram);
      for (const alias of yoAliases(gram)) append(aliases, alias);
    }
  }
  const primaryAliases = anchors.flatMap((word) => yoAliases(word.slice(0, 4)));
  const spoken = spokenNameQueries(variants);
  const tail = literal.flatMap((gram) => [gram, ...yoAliases(gram)]);
  // Reserve literal prefix/suffix coverage before optional pronunciation hypotheses.
  // Otherwise ё variants plus prepended phonetic queries can consume all eight slots
  // before a different source component gets its distinguishing surname ending.
  // Interleave the remaining literal/ё hypotheses so a joined oblique source
  // such as сименову still retrieves the stored Семёнова through its middle gram.
  const queries = [
    ...new Set([
      ...literal.slice(0, Math.ceil(SUGGESTION_LIMITS.queries / 2)),
      ...primaryAliases,
      ...spoken,
      ...tail,
      ...aliases,
    ]),
  ].slice(0, SUGGESTION_LIMITS.queries);
  return { variants, excluded, queries };
}
module.exports = {
  SUGGESTION_LIMITS,
  rawJoinedName,
  suggestionsOnlyQuery,
  nameSuggestionPlan,
  rankNameSuggestions,
};
