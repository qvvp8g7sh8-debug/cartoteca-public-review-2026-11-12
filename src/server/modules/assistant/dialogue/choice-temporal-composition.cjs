const { ordinalOperation } = require('./dialogue-repair-choice.cjs');
const { bookingTemporalConstraints } = require('../language/time/booking-temporal-constraints.cjs');
const { temporalWordsOnly } = require('../language/time/temporal-words.cjs');
const { normalizeClockPrefixes } = require('../language/time/clock-context.cjs');
const {
  normalizeDayOrdinals,
  dayOrdinalWord,
  monthWord,
} = require('../language/time/spoken-day.cjs');
const { inheritMonthContext, dayEvidence } = require('./bare-day-proposal.cjs');
const roles = {
  client: '(?:клиент[ау]?|клиентку|пациент[ау]?|пациентку)',
  staff: '(?:сотрудник[ау]?|специалист[ау]?|врач[ау]?|мастер[ау]?)',
  service: '(?:услуг[ау]|процедур[ау]|консультаци[яю])',
};
const clean = (value) =>
  value
    .replace(/^[\s,;.!?…]+|[\s,;.!?…]+$/gu, '')
    .trim()
    .replace(/^пожалуйста(?:,\s*|\s+)/u, '')
    .replace(/(?:,\s*|\s+)пожалуйста$/u, '')
    .trim();
function numericFieldsConsumed(text, proof) {
  let rest = normalizeDayOrdinals(text)
    .replace(/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}/gu, ' ')
    .replace(/[+−-]?\d{1,2}\s*[:.,–—-]\s*\d{1,2}/gu, ' ')
    .replace(
      new RegExp(
        '(?<![\\p{L}\\p{N}])\\d{1,2}\\s+' + monthWord + '(?:\\s+\\d{4}(?:\\s+года?)?)?',
        'gu',
      ),
      ' ',
    )
    .replace(/(?<![\p{L}\p{N}])\d{1,2}(?:\s*-(?:го|ое|е)|\s+числ[ао])(?=$|[\s,.!?;])/gu, ' ')
    .replace(/(?:^|\s)через\s+\d{1,3}\s+(?:день|дня|дней)(?=$|[\s,.!?;])/gu, ' ');
  if (Object.hasOwn(proof, 'time'))
    rest = rest.replace(/(?<![\p{L}\p{N}])(?:в|на|ко?)\s+\d{1,2}(?=$|[\s,.!?;])/gu, ' ');
  if (Object.hasOwn(proof, 'duration') || proof.requireDuration)
    rest = rest.replace(
      /[+−-]?\d+(?:[.,]\d+)?\s+(?:минут[а-я]*|час(?:а|ов)?)(?=$|[\s,.!?;])/gu,
      ' ',
    );
  if (Object.hasOwn(proof, 'timeWindow'))
    rest = rest.replace(/(?<![\p{L}\p{N}])(?:с|до|после)\s*\d{1,2}(?=$|[\s,.!?;])/gu, ' ');
  return !/\d/u.test(rest);
}
function scopedChoice(entry, value) {
  let text = clean(value);
  const role = roles[entry.step];
  text = text
    .replace(new RegExp('^' + role + '\\s+', 'u'), '')
    .replace(new RegExp('\\s+' + role + '$', 'u'), '');
  let result;
  try {
    result = ordinalOperation(entry, text);
  } catch (error) {
    if (error.status !== 400) throw error;
    return null;
  }
  return result?.kind === 'choice' && entry.options.get(result.choice)?.kind === entry.step
    ? result.choice
    : null;
}
function temporalProof(entry, text, clock) {
  // Only the temporal half is parsed. A person's name, another service, a
  // condition, alternative or action can never be silently discarded here.
  text = normalizeClockPrefixes(text);
  const words = text.replace(
    /(?:^|\s)(?:длительност[ьи]|длительностью|продолжительност[ьи]|продолжительностью)(?=$|\s)/gu,
    ' ',
  );
  if (!text || !temporalWordsOnly(words) || /\d\p{L}/u.test(text)) return null;
  const dateMeaning = dayEvidence(text),
    dateWord = new RegExp('^(?:' + dayOrdinalWord + ')$', 'u');
  const probe = {
    step: 'client',
    options: new Map(Array.from({ length: 12 }, (_, index) => [String(index), {}])),
  };
  for (const word of normalizeDayOrdinals(words).match(/\p{L}+/gu) || []) {
    if (!/(?:ый|ой|ий|ого|ую|ое|ье|его|юю|ее|ая)$/u.test(word)) continue;
    let selection;
    try {
      selection = ordinalOperation(probe, word);
    } catch (error) {
      if (error.status !== 400) throw error;
    }
    if (selection?.kind === 'choice' && (!dateMeaning || !dateWord.test(word))) return null;
  }
  let proof;
  try {
    proof = bookingTemporalConstraints({ intent: 'prepareAppointment' }, text, clock, {
      clarifyWeekday: true,
    });
  } catch (error) {
    if (error.status !== 400) throw error;
    return null;
  }
  if (!numericFieldsConsumed(text, proof)) return null;
  const context =
    entry.data?.date || (entry.data?.dateMonthContext ? entry.data.dateMonthContext + '-01' : null);
  proof = inheritMonthContext(proof, context);
  return [
    'date',
    'time',
    'duration',
    'requireDuration',
    'dateProposal',
    'timeWindow',
    'timeWindowRequired',
  ].some((field) => Object.hasOwn(proof, field))
    ? proof
    : null;
}
function choiceTemporalComposition(entry, raw, clock) {
  if (
    !roles[entry?.step] ||
    !(entry.options instanceof Map) ||
    typeof raw !== 'string' ||
    raw.length > 160 ||
    entry.availabilitySearch
  )
    return null;
  const text = clean(raw.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' '));
  const words = text.split(' '),
    matches = new Map();
  for (let split = 1; split < words.length; split++)
    for (const [selection, temporal] of [
      [words.slice(0, split).join(' '), words.slice(split).join(' ')],
      [words.slice(split).join(' '), words.slice(0, split).join(' ')],
    ]) {
      const choice = scopedChoice(entry, selection);
      if (!choice) continue;
      const constraints = temporalProof(entry, clean(temporal), clock);
      if (!constraints) continue;
      const edits = ['date', 'time', 'duration']
        .filter((field) => constraints[field] !== null && constraints[field] !== undefined)
        .map((field) => ({ field, text: String(constraints[field]) }));
      const result = { kind: 'choicePatch', choice, constraints, edits };
      matches.set(JSON.stringify(result), result);
    }
  return matches.size === 1 ? [...matches.values()][0] : null;
}
function choiceOrdinalComposition(entry, raw) {
  if (
    !roles[entry?.step] ||
    !(entry.options instanceof Map) ||
    !entry.options.size ||
    [...entry.options.values()].some((row) => row.kind !== entry.step) ||
    typeof raw !== 'string' ||
    raw.length > 160 ||
    entry.availabilitySearch
  )
    return null;
  // Keep every remaining entity, temporal token and safety qualifier for the
  // model guard. This extractor proves only a current ordinal, never a patch.
  const words = raw.trim().split(/\s+/u),
    matches = [];
  for (let split = 1; split < words.length; split++)
    for (const [selection, remainder] of [
      [words.slice(0, split), words.slice(split)],
      [words.slice(split), words.slice(0, split)],
    ]) {
      const choice = scopedChoice(
        entry,
        selection.join(' ').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е'),
      );
      if (!choice) continue;
      const rest = remainder
        .join(' ')
        .replace(/^[\s,;]+|[\s,;]+$/gu, '')
        .trim();
      const normalizedRest = rest.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
      const otherRole = Object.entries(roles)
        .filter(([kind]) => kind !== entry.step)
        .map(([, role]) => role)
        .join('|');
      if (
        new RegExp('^(?:' + otherRole + ')(?=$|\\s)|(?:^|\\s)(?:' + otherRole + ')$', 'u').test(
          normalizedRest,
        )
      )
        continue;
      if (rest) matches.push({ choice, remainder: rest, words: selection.length });
    }
  if (!matches.length || new Set(matches.map((row) => row.choice)).size !== 1) return null;
  const longest = Math.max(...matches.map((row) => row.words));
  const proven = new Map(
    matches
      .filter((row) => row.words === longest)
      .map(({ choice, remainder }) => [remainder, { choice, remainder }]),
  );
  return proven.size === 1 ? [...proven.values()][0] : null;
}
module.exports = { choiceTemporalComposition, choiceOrdinalComposition };
