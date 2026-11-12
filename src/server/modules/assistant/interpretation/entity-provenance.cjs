// Proposals locate spoken values. Only their proven source text reaches local resolvers.
const { matchesName, nameTokens } = require('../language/names/name-matching.cjs');
const { rawJoinedName, nameSuggestionPlan } = require('../language/names/name-suggestions.cjs');
const { serviceSuggestionScore } = require('../language/services/service-suggestions.cjs');
const { serviceWords } = require('../language/services/service-matching.cjs');
const { fieldAnswer } = require('../dialogue/field-answer.cjs');
const { expandServiceSource } = require('../language/services/service-source.cjs');
const { parseTimeText } = require('../language/time/temporal.cjs');
const { readDurationMinutes } = require('../language/time/spoken-duration.cjs');
const { dayOrdinalWord, monthWord } = require('../language/time/spoken-day.cjs');
const {
  serviceAliasSourceMatches,
  servicePartialIdentityMatches,
  serviceDescriptionMatches,
  serviceHasIdentifier,
} = require('../language/services/service-partial-search.cjs');
const { expandClientSource } = require('../language/names/client-source-span.cjs');
const { suggestionsOnlyQuery } = require('../language/names/name-suggestions.cjs');
const MAX_SERVICE_WORDS = 12;
const fold = (text) =>
  String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/gu, ' ')
    .trim();
function literalSpan(request, value) {
  const source = String(request || ''),
    wanted = fold(value);
  if (!wanted) return '';
  let normalized = '';
  const starts = [],
    ends = [];
  for (const match of source.matchAll(/.\p{M}*/gsu)) {
    for (const ch of match[0].normalize('NFKC').toLowerCase().replace(/ё/g, 'е')) {
      if (/\s/u.test(ch)) {
        if (normalized.endsWith(' ')) {
          ends[ends.length - 1] = match.index + match[0].length;
          continue;
        }
        normalized += ' ';
        starts.push(match.index);
        ends.push(match.index + match[0].length);
      } else {
        normalized += ch;
        for (let i = 0; i < ch.length; i++) {
          starts.push(match.index);
          ends.push(match.index + match[0].length);
        }
      }
    }
  }
  const inside = /[\p{L}\p{N}'’ʼ\p{Pd}]/u;
  for (let i = normalized.indexOf(wanted); i >= 0; i = normalized.indexOf(wanted, i + 1))
    if (!inside.test(normalized[i - 1] || '') && !inside.test(normalized[i + wanted.length] || ''))
      return source.slice(starts[i], ends[i + wanted.length - 1]);
  return '';
}
function excerpt(request, value) {
  return Boolean(literalSpan(request, value));
}
const serviceBoundary =
  /^(?:на|в|к|ко|у|для|а|запиши|записать|услугу|процедуру|нужен|нужна|нужно|нужны|надо|давайте|хочу|выбираю|выбираем|выбери|возьмем|беру|остановимся|именно|тот|та|то|этот|эту|сегодня|завтра|послезавтра|утром|днем|вечером|дата|время)$/u;
function provenServiceEdge(request, neighbor, before, sources) {
  return sources.some((value) => {
    if (typeof value !== 'string' || !value || value.length > 160) return false;
    const end = before ? neighbor.index + neighbor[0].length : neighbor.index + value.length;
    const start = before ? end - value.length : neighbor.index;
    return start >= 0 && String(request).slice(start, end) === value;
  });
}
function literalServiceWords(request, source, provenSources) {
  const text = String(request),
    values = new Map();
  const calendar = new RegExp(
    '^(?:' +
      dayOrdinalWord +
      '|' +
      monthWord +
      '|понедельник[а-я]*|вторник[а-я]*|сред[ауы]|четверг[а-я]*|пятниц[ауы]|суббот[ауы]|воскресень[ея])$',
    'u',
  );
  let at = text.indexOf(source),
    occurrences = 0;
  while (at >= 0) {
    if (++occurrences > 8) return '';
    let start = at,
      end = at + source.length;
    for (const before of [true, false])
      for (let count = 0; count < 6; count++) {
        const surrounding = before ? text.slice(0, start) : text.slice(end);
        const match = before
          ? /([\p{L}]+(?:[-'’][\p{L}]+)*)[\s+]+$/u.exec(surrounding)
          : /^[\s+]+([\p{L}]+(?:[-'’][\p{L}]+)*)/u.exec(surrounding);
        if (!match) break;
        const index = before ? start - match[0].length : end + match[0].length - match[1].length;
        const neighbor = { 0: match[1], index },
          word = fold(match[1]);
        const clockPhrase = text.slice(index).match(/^[\p{L}\s-]{1,96}/u)?.[0] || '';
        const clock =
          /(?:час|минут|утра|дня|вечера|ночи)/u.test(clockPhrase) &&
          (parseTimeText(clockPhrase.trim()) !== null ||
            readDurationMinutes(clockPhrase.trim()) !== null);
        if (
          serviceBoundary.test(word) ||
          calendar.test(word) ||
          clock ||
          provenServiceEdge(text, neighbor, before, provenSources)
        )
          break;
        if (before) start = index;
        else end = index + match[1].length;
      }
    const value = text.slice(start, end);
    if (
      !/\+\s*$/u.test(text.slice(0, start)) &&
      !/^\s*\+/u.test(text.slice(end)) &&
      value.length <= 160 &&
      !/(?:^|[\s,;])(?:не|нет|или|либо|если|кроме|исключая|вместо|и)(?=$|[\s,;.!?])/iu.test(value)
    ) {
      const expanded = expandServiceSource(text, value);
      if (expanded) values.set(fold(expanded), expanded);
    }
    at = text.indexOf(source, at + source.length);
  }
  return values.size === 1 ? [...values.values()][0] : '';
}
// A canonical title may locate a raw identifier or a complete description.
// It cannot supply unheard product codes, technology names, or other title words.
function rawServiceIdentity(request, proposal, tokens, provenSources = []) {
  if (!/[A-Za-z]/u.test(proposal) && !serviceHasIdentifier(proposal)) return '';
  const withoutCode = (value) =>
    value
      .replace(/[A-Za-z]{1,8}[+-]?\d[\p{L}\p{N}.,:/+%‰°-]*/gu, ' ')
      .replace(/-(?=$|\s)/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  const locator = withoutCode(proposal);
  if (!locator) return '';
  const spans = [];
  for (let index = 0; index < tokens.length; index++)
    for (let size = 1; size <= MAX_SERVICE_WORDS && index + size <= tokens.length; size++) {
      const first = tokens[index],
        last = tokens[index + size - 1];
      const start = first.index,
        end = last.index + last[0].length;
      const value = String(request).slice(start, end);
      if (
        value.length > 160 ||
        /[,;!?]/u.test(value) ||
        fold(fieldAnswer('service', value)) !== fold(value) ||
        (!servicePartialIdentityMatches(locator, withoutCode(value)) &&
          !serviceDescriptionMatches(locator, withoutCode(value)))
      )
        continue;
      spans.push({ value, start, end, index, lastIndex: index + size - 1 });
    }
  // Do not fall back from a negated full phrase to its positive-looking acronym.
  const maximal = spans.filter(
    (span) =>
      !spans.some(
        (other) =>
          other !== span &&
          other.start <= span.start &&
          other.end >= span.end &&
          (other.start < span.start || other.end > span.end),
      ),
  );
  const sources = new Map();
  for (const span of maximal) {
    let bounded = true;
    for (const before of [true, false]) {
      const neighbor = tokens[before ? span.index - 1 : span.lastIndex + 1];
      if (!neighbor) continue;
      const gap = before
        ? String(request).slice(neighbor.index + neighbor[0].length, span.start)
        : String(request).slice(span.end, neighbor.index);
      if (/[,;!?]/u.test(gap)) continue;
      // Unknown adjoining words may be service qualifiers. Never silently omit
      // them just because the model proposed a shorter or more familiar title.
      if (
        !serviceBoundary.test(fold(neighbor[0])) &&
        !/\p{N}/u.test(neighbor[0]) &&
        !provenServiceEdge(request, neighbor, before, provenSources)
      )
        bounded = false;
    }
    if (!bounded) continue;
    const expanded = expandServiceSource(request, span.value);
    const source = expanded ? literalServiceWords(request, expanded, provenSources) : '';
    if (source) sources.set(fold(source), source);
  }
  return sources.size === 1 ? [...sources.values()][0] : '';
}
function entityText(request, proposal, field, provenSources = []) {
  if (typeof proposal !== 'string' || !proposal.trim() || proposal.length > 160) return '';
  const literal = literalSpan(request, proposal);
  if (literal) {
    // A literal locator must not drop its adjacent explicit code through the fallback path.
    if (field === 'service') {
      const source = expandServiceSource(request, literal);
      return source && (/[A-Za-z]/u.test(literal) || serviceHasIdentifier(literal))
        ? literalServiceWords(request, source, provenSources)
        : source;
    }
    return literal;
  }
  if (field === 'client') {
    const joined = rawJoinedName(request, proposal);
    if (joined) return joined;
  }
  if (field === 'client' && /^[+\d\s().-]+$/u.test(proposal)) {
    const digits = proposal.replace(/\D/gu, '');
    if (digits.length >= 10 && digits.length <= 15)
      for (const match of String(request).matchAll(/(?<!\d)[+\d][\d\s().-]{8,35}\d(?!\d)/gu))
        if (match[0].replace(/\D/gu, '') === digits) return match[0].trim();
    return '';
  }
  const words = field === 'service' ? serviceWords(proposal) : nameTokens(proposal),
    tokens = [...String(request).matchAll(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu)];
  if (
    (field !== 'service' && !words.length) ||
    words.length > (field === 'service' ? MAX_SERVICE_WORDS : 4) ||
    tokens.length > 128
  )
    return '';
  const candidates = new Map(),
    person = { displayName: proposal };
  const accepts =
    field === 'service'
      ? (value) =>
          fold(fieldAnswer('service', value)) === fold(value) &&
          (Number.isFinite(serviceSuggestionScore(proposal, value, { complete: true })) ||
            serviceAliasSourceMatches(proposal, value))
      : (value) => matchesName(person, value, true);
  const add = (value) => {
    if (!accepts(value)) return;
    let source = field === 'service' ? expandServiceSource(request, value) : value;
    if (
      source &&
      field === 'service' &&
      (/[A-Za-z]/u.test(proposal) || serviceHasIdentifier(proposal))
    )
      source = literalServiceWords(request, source, provenSources);
    if (source) candidates.set(fold(source), source);
  };
  // Full alias proof may locate spelled acronyms or an unchanged numeric code; partial search cannot.
  if (field === 'service' && (/[A-Za-z]/u.test(proposal) || serviceHasIdentifier(proposal)))
    for (let index = 0; index < tokens.length; index++)
      for (let size = 1; size <= MAX_SERVICE_WORDS && index + size <= tokens.length; size++) {
        const first = tokens[index],
          last = tokens[index + size - 1];
        const span = String(request).slice(first.index, last.index + last[0].length);
        if (
          span.length > 160 ||
          /[,;!?]/u.test(span) ||
          fold(fieldAnswer('service', span)) !== fold(span) ||
          !serviceAliasSourceMatches(proposal, span)
        )
          continue;
        const expanded = expandServiceSource(request, span);
        const source = expanded ? literalServiceWords(request, expanded, provenSources) : '';
        if (source) candidates.set(fold(source), source);
      }
  if (!words.length)
    return candidates.size
      ? candidates.size === 1
        ? [...candidates.values()][0]
        : ''
      : field === 'service'
        ? rawServiceIdentity(request, proposal, tokens, provenSources)
        : '';
  for (let index = 0; index + words.length <= tokens.length; index++) {
    const first = tokens[index],
      last = tokens[index + words.length - 1];
    const span = String(request).slice(first.index, last.index + last[0].length);
    if (span.length <= 160 && !/[,;!?]/u.test(span) && excerpt(request, span)) add(span);
  }
  if (field === 'service' && words.length > 1)
    for (const token of tokens) {
      if (/^[\p{L}]{7,96}$/u.test(token[0]) && excerpt(request, token[0])) add(token[0]);
    }
  if (field === 'client' && words.length === 2)
    for (const token of tokens) {
      if (!/^[\p{L}]{7,48}$/u.test(token[0])) continue;
      if (
        nameSuggestionPlan(token[0]).variants.some(
          (parts) => parts.length === 2 && accepts(parts.join(' ')),
        )
      )
        candidates.set(fold(token[0]), token[0]);
    }
  if (candidates.size) return candidates.size === 1 ? [...candidates.values()][0] : '';
  return field === 'service' ? rawServiceIdentity(request, proposal, tokens, provenSources) : '';
}
function initialEntities(intent, request, constraints = {}) {
  const result = { ...intent };
  for (const [key, field] of [
    ['query', 'client'],
    ['staffQuery', 'staff'],
    ['serviceQuery', 'service'],
  ]) {
    if (!Object.hasOwn(result, key)) continue;
    // Earlier entries are already proven raw spans, never the model's unverified
    // client/staff names. Their exact edges may delimit service-first commands.
    const proven = field === 'service' ? [result.query, result.staffQuery].filter(Boolean) : [];
    const text = entityText(request, result[key], field, proven);
    if (text) result[key] = text;
    else delete result[key];
  }
  if (Object.hasOwn(intent, 'query')) {
    const query = suggestionsOnlyQuery(result.query || '')
      ? result.query
      : expandClientSource(request, result.query || intent.query, {
          serviceQuery: result.serviceQuery,
          staffQuery: result.staffQuery,
        });
    if (query) result.query = query;
    else delete result.query;
  }
  for (const field of ['date', 'time', 'duration'])
    if (Object.hasOwn(result, field) && constraints[field] === undefined) delete result[field];
  return result;
}
module.exports = { fold, excerpt, literalSpan, entityText, initialEntities };
