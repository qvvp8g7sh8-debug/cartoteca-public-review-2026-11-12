const { maskBareClockPhrases } = require('../language/time/clock-context.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const { readDurationMinutes } = require('../language/time/spoken-duration.cjs');
const { spokenNumber } = require('../language/time/spoken-number.cjs');
const { normalizeDayOrdinals, monthWord } = require('../language/time/spoken-day.cjs');
const startsDate = new RegExp(
  '^(?:\\d{4,6}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./]\\d{1,2}[./]\\d{4,6}|\\d{1,2}\\s+' +
    monthWord +
    ')(?=$|[\\s,.!?])',
  'u',
);
const valid = (minutes) =>
  Number.isSafeInteger(minutes) && minutes >= 5 && minutes <= 1440 && minutes % 5 === 0;
const startsDuration =
  /^(?:[+−-]?\d|ноль|нул|один|одна|одно|дв|тр|четыр|пят|шест|сем|восем|девят|десят|одиннад|двенад|сорок|сто|ст[ао]|тысяч|час|пол|четверть|примерно|около|минус|от\s|до\s)/u;
function durationValue(expression) {
  const number = /^([+−-]?\d+(?:[.,]\d+)?)\s*(мин(?:ут(?:а|у|ы)?)?|ч(?:ас(?:а|ов)?)?)\.?$/u.exec(
    expression,
  );
  return number
    ? Number(number[1].replace('−', '-').replace(',', '.')) * (/^ч/.test(number[2]) ? 60 : 1)
    : readDurationMinutes(expression);
}
function ambiguousContinuation(rest) {
  const next = /^\s+(с|и|или|либо|до)(?=\s|$)\s*(.*)$/u.exec(rest);
  if (!next) return false;
  if (next[1] === 'или' || next[1] === 'либо') return true;
  const tail = next[2].trim();
  if (!tail || /^\d{1,2}[:.]\d{2}/u.test(tail)) return false;
  return (
    readDurationMinutes(tail) !== null ||
    /^(?:четвертью|половиной)(?=$|[\s,.!?])/u.test(tail) ||
    (startsDuration.test(tail) &&
      /(?:^|[^\p{L}])(?:мин(?:ут(?:а|ы|у)?)?|час(?:а|ов)?)(?!\p{L})/u.test(tail))
  );
}
function unconsumedDuration(rest) {
  const tail = rest.replace(/^[\s,]+/u, '').replace(/^(?:и|с)\s+/u, '');
  if (startsDate.test(tail) || /^\d{1,2}[:.]\d{2}/u.test(tail) || !startsDuration.test(tail))
    return false;
  const unit =
    /(?<!\p{L})(?:полчаса|мин(?:ут(?:а|у|ы)?)?\.?|ч(?:ас(?:а|ов)?)?\.?|(?:милли)?секунд[а-я]*)(?!\p{L})/u.exec(
      tail,
    );
  if (!unit) return false;
  const count = tail.slice(0, unit.index).trim();
  return (
    !count ||
    /^[+−-]?\d+(?:[.,]\d+)?$/u.test(count) ||
    readDurationMinutes(count) !== null ||
    durationValue(tail.slice(0, unit.index + unit[0].length)) !== null
  );
}
function bareHourMinutes(tail, end) {
  if (!/(?<!\p{L})(?:час(?:а|ов)?|ч\.?)$/u.test(tail.slice(0, end).trim())) return null;
  let cursor = end + /^\s*(?:,\s*)?(?:и\s+)?/u.exec(tail.slice(end))[0].length;
  let last = cursor,
    hasNumber = false;
  while (cursor < tail.length) {
    const rest = tail.slice(cursor);
    if (startsDate.test(rest) || /^\d{1,2}:\d{2}/u.test(rest)) break;
    const token = /^(?:[+−-]?\d+(?:[.,]\d+)?|[а-я]+)(?=$|[\s,.!?;])/u.exec(rest);
    if (!token || (!/^[+−-]?\d/u.test(token[0]) && spokenNumber(token[0], 100000) === null)) break;
    hasNumber = true;
    last = cursor + token[0].length;
    const space = /^\s+/u.exec(tail.slice(last));
    if (!space) break;
    cursor = last + space[0].length;
  }
  return hasNumber ? { end: last, minutes: readDurationMinutes(tail.slice(0, last)) } : null;
}
function scanDurations(normalized) {
  const values = [];
  let ambiguous = false;
  const prefixes = [
    ...normalized.matchAll(
      /(?:^|[\s,;])(?:на|по|длительност(?:ь|ью)|продолжительност(?:ь|ью)|длится|длиться)(?:\s+(?:приема|процедуры|услуги|записи))?(?:\s*[:=]\s*|\s+(?:на\s+)?)/gu,
    ),
  ];
  for (const [index, prefix] of prefixes.entries()) {
    const start = prefix.index + prefix[0].length;
    const tail = normalized.slice(
      start,
      Math.min(start + 160, prefixes[index + 1]?.index ?? normalized.length),
    );
    if (startsDate.test(tail) || !startsDuration.test(tail)) continue;
    const units = tail.matchAll(
      /(?:^|[^\p{L}])(?:полчаса|мин(?:ут(?:а|у|ы)?)?\.?|ч(?:ас(?:а|ов)?)?\.?)(?!\p{L})/gu,
    );
    let found = null,
      end = 0,
      hasUnit = false;
    for (const unit of units) {
      hasUnit = true;
      const limit = unit.index + unit[0].length;
      const minutes = durationValue(tail.slice(0, limit).trim());
      if (minutes !== null) {
        found = minutes;
        end = limit;
      }
    }
    if (!hasUnit) continue;
    const bare = bareHourMinutes(tail, end);
    if (bare) {
      end = bare.end;
      if (bare.minutes === null) ambiguous = true;
      else found = bare.minutes;
    }
    if (
      /^\s+(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)(?=$|[\s,.!?])/u.test(tail.slice(end))
    )
      continue;
    // An offset changes the start time, never the appointment length.
    if (/^\s+(?:позже|позднее|раньше|ранее|вперед|назад)(?=$|[\s,.!?])/u.test(tail.slice(end)))
      continue;
    // A relative length needs its own exact answer; it is not a clock offset.
    if (
      found === null ||
      unconsumedDuration(tail.slice(end)) ||
      /^[\s,]+(?:не\s+)?(?:дольше|меньше|больше|короче|длиннее)(?=$|[\s,.!?])/u.test(
        tail.slice(end),
      ) ||
      ambiguousContinuation(tail.slice(end))
    )
      ambiguous = true;
    if (found !== null) values.push(found);
  }
  return { values: [...new Set(values)], ambiguous };
}
function requestedDurations(text, context) {
  const normalized = maskBareClockPhrases(
    normalizeDayOrdinals(text.normalize('NFKC')),
    context,
  ).replace(/(?<![\p{L}\p{N}])(длительностью|продолжительностью|длится|длиться)\s+на\s+/gu, '$1 ');
  const segments = normalized.split(/(?:^|[\s,])(?:нет|точнее|лучше)(?=$|[\s,])/u);
  let result = { values: [], ambiguous: false };
  for (const [index, raw] of segments.entries()) {
    const segment = raw.trim();
    const current = scanDurations(
      index && startsDuration.test(segment) ? 'на ' + segment : segment,
    );
    // A correction of another field cannot retract the previously stated duration.
    if (current.values.length || current.ambiguous) result = current;
  }
  return result;
}
function intentRequestConstraints(intent, requestText, context = {}) {
  if (
    !['prepareAppointment', 'availability'].includes(intent.intent) ||
    typeof requestText !== 'string' ||
    requestText.length > 4000
  )
    return {};
  const { values, ambiguous } = requestedDurations(requestText, {
    ...context,
    durationContext: intent.intent === 'availability' || context.durationContext === true,
  });
  if (!values.length && !ambiguous) return {};
  if (ambiguous || values.length !== 1 || !valid(values[0])) {
    if (intent.intent === 'prepareAppointment') return { requireDuration: true };
    throw fail(400, 'Уточните одну длительность от 5 до 1440 минут с шагом 5 минут.');
  }
  return { duration: values[0] };
}
module.exports = { intentRequestConstraints };
