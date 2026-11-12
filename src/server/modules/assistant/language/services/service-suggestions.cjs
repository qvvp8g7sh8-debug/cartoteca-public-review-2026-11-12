const { serviceMatches, serviceWords, serviceWordForms } = require('./service-matching.cjs');
const { boundedNameDistance } = require('../names/name-distance.cjs');
const { normalizeName } = require('../names/name-forms.cjs');
const { fieldAnswer } = require('../../dialogue/field-answer.cjs');
const { isAffirmativeAnswer } = require('../../dialogue/affirmative-answer.cjs');
const {
  partialServiceScore,
  servicePartialIdentityMatches,
} = require('./service-partial-search.cjs');
const MAX_SERVICES = 200,
  MAX_RESULTS = 3,
  MAX_PLANS = 8,
  MAX_STATES = 4096;
const unsafe =
  /(?:^|\s)(?:не|нет|или|либо|если|кроме|исключая|вместо|и|отправь|отправить|сохрани|сохранить|удали|удалить|создай|запиши|отмени)(?=$|\s)/u;
const cleanQuery = (query) =>
  normalizeName(fieldAnswer('service', query))
    .replace(/[.!?…]+$/u, '')
    .trim();
function analyze(name, raw, { complete = false, exact = false } = {}) {
  const query = cleanQuery(raw);
  if (!query || unsafe.test(query)) return { score: Infinity, overflow: false };
  const wanted = serviceWords(query),
    catalog = serviceWords(name);
  if ((!complete || wanted.length === catalog.length) && serviceMatches(name, query))
    return { score: 0, overflow: false };
  if (
    /[\p{N}]/u.test(String(name) + query) ||
    !/^[\p{L}]+(?:[-'][\p{L}]+)*(?: [\p{L}]+(?:[-'][\p{L}]+)*)*$/u.test(query)
  )
    return { score: Infinity, overflow: false };
  if (
    query.length > 160 ||
    wanted.length > 8 ||
    catalog.length > 16 ||
    wanted.some((word) => word.length > 96) ||
    catalog.some((word) => word.length > 48)
  )
    return { score: Infinity, overflow: true };
  if (!wanted.length || !catalog.length) return { score: Infinity, overflow: false };
  const forms = catalog.map(serviceWordForms),
    cache = new Map();
  function cost(word, index) {
    const key = word + '\u0000' + index;
    if (cache.has(key)) return cache.get(key);
    let best = Infinity;
    for (const form of forms[index]) {
      const length = Math.min(word.length, form.length, catalog[index].length),
        limit = exact ? 0 : length >= 8 ? 2 : length >= 5 ? 1 : 0;
      if (Math.abs(word.length - form.length) <= limit)
        best = Math.min(best, boundedNameDistance(word, form, limit));
    }
    cache.set(key, best);
    return best;
  }
  let plans = [{ words: [], joins: 0 }],
    overflow = false;
  for (const word of wanted) {
    const variants = new Map([[JSON.stringify([word]), [{ word, index: null }]]]);
    for (let index = 0; index < forms.length; index++)
      for (const form of forms[index]) {
        if (word === form || form.length < 2) continue;
        const pieces = [];
        if (word.startsWith(form)) pieces.push([form, word.slice(form.length), true]);
        if (word.endsWith(form)) pieces.push([word.slice(0, -form.length), form, false]);
        for (const [left, right, first] of pieces) {
          const rest = first ? right : left;
          if (rest.length < 2 || rest.length > 48) continue;
          for (let other = 0; other < forms.length; other++)
            if (other !== index && Number.isFinite(cost(rest, other))) {
              const parts = [
                { word: left, index: first ? index : other },
                { word: right, index: first ? other : index },
              ];
              variants.set(JSON.stringify(parts), parts);
              if (variants.size > MAX_PLANS) return { score: Infinity, overflow: true };
            }
        }
      }
    const next = [];
    for (const plan of plans)
      for (const parts of variants.values()) {
        next.push({
          words: [...plan.words, ...parts],
          joins: plan.joins + (parts.length === 2 ? 1 : 0),
        });
        if (next.length > MAX_PLANS) return { score: Infinity, overflow: true };
      }
    plans = next;
  }
  let best = Infinity,
    states = 0;
  for (const plan of plans) {
    if (plan.words.length > catalog.length || (complete && plan.words.length !== catalog.length))
      continue;
    const options = plan.words
      .map((part) =>
        catalog.flatMap((_, index) => {
          if (part.index !== null && part.index !== index) return [];
          const value = cost(part.word, index);
          return Number.isFinite(value) ? [{ index, value }] : [];
        }),
      )
      .sort((a, b) => a.length - b.length);
    if (options.some((rows) => !rows.length)) continue;
    const memo = new Map();
    function place(at, mask, score) {
      if (++states > MAX_STATES) {
        overflow = true;
        return;
      }
      if (score >= best) return;
      if (at === options.length) {
        best = score;
        return;
      }
      const key = at + ':' + mask;
      if ((memo.get(key) ?? Infinity) <= score) return;
      memo.set(key, score);
      for (const row of options[at])
        if (!(mask & (1 << row.index))) place(at + 1, mask | (1 << row.index), score + row.value);
    }
    place(0, 0, plan.joins / 4);
    if (overflow) return { score: Infinity, overflow: true };
  }
  return { score: best, overflow: false };
}
function serviceSuggestionScore(name, query, options = {}) {
  return analyze(name, query, options).score;
}
function suggestServices(catalog, query) {
  if (!Array.isArray(catalog) || catalog.length > MAX_SERVICES || serviceWords(query).length > 8)
    return { matches: [], overflow: true };
  const ranked = [];
  for (const service of catalog) {
    const result = analyze(service.name, query);
    if (result.overflow) return { matches: [], overflow: true };
    const score = Number.isFinite(result.score)
      ? result.score
      : partialServiceScore(service.name, cleanQuery(query));
    if (Number.isFinite(score)) ranked.push({ service, score });
  }
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      a.service.name.localeCompare(b.service.name, 'ru') ||
      String(a.service.id).localeCompare(String(b.service.id)),
  );
  return {
    matches: ranked.slice(0, MAX_RESULTS).map((row) => row.service),
    overflow: ranked.length > MAX_RESULTS,
    best:
      ranked.length && (ranked.length === 1 || ranked[0].score < ranked[1].score)
        ? ranked[0].service
        : null,
  };
}
function serviceStamp(service) {
  return JSON.stringify([service.id, service.name, service.duration, service.staffId]);
}
function serviceChoiceOperation(entry, raw) {
  if (
    entry?.step !== 'service' ||
    entry.response?.dialogue?.phase !== 'serviceChoice' ||
    typeof raw !== 'string' ||
    raw.length > 160
  )
    return null;
  const choices = [...(entry.options || [])].filter(
    ([, row]) => row.kind === 'service' && row.approximateService === true,
  );
  if (!choices.length || choices.length > 3) return null;
  const text = cleanQuery(raw);
  if (text === 'нет') return { kind: 'edit', field: 'service' };
  if (unsafe.test(text)) return null;
  if (isAffirmativeAnswer(raw))
    return choices.length === 1
      ? { kind: 'choice', choice: choices[0][0] }
      : { kind: 'localHelp', text: 'Назовите точное название нужной услуги.' };
  const matches = choices.filter(([, row]) =>
    Number.isFinite(serviceSuggestionScore(row.serviceName, text, { complete: true, exact: true })),
  );
  if (matches.length === 1) return { kind: 'choice', choice: matches[0][0] };
  const partial = choices.filter(
    ([, row]) =>
      serviceMatches(row.serviceName, text) ||
      Number.isFinite(partialServiceScore(row.serviceName, text)),
  );
  if (
    partial.length === 1 &&
    (choices.length > 1 || servicePartialIdentityMatches(partial[0][1].serviceName, text))
  )
    return { kind: 'choice', choice: partial[0][0] };
  if (matches.length > 1 || partial.length)
    return {
      kind: 'localHelp',
      text: 'Назовите полное название услуги или подтвердите предложение.',
    };
  return null;
}
module.exports = { serviceSuggestionScore, suggestServices, serviceStamp, serviceChoiceOperation };
