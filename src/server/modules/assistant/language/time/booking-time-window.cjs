const { parseTimeText, normalizeClockSeparators } = require('./temporal.cjs');
const { parseSpokenTime } = require('./spoken-time.cjs');
const {
  endpoint,
  edge,
  cue,
  readClock,
  clockWord,
  clockTail,
  normalizeNumericRanges,
} = require('./booking-window-grammar.cjs');
const { monthWord } = require('./spoken-day.cjs');
const dateTail = new RegExp(
  '^\\s*(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\d{1,2}\\s+(?:' +
    monthWord +
    '|числа))(?=$|[\\s,.!?;])',
  'u',
);
const namedBounds = {
  morning: ['06:00', '12:00'],
  day: ['12:00', '17:00'],
  evening: ['17:00', '24:00'],
  night: ['00:00', '06:00'],
  any: ['00:00', '24:00'],
};
const corrections =
  /(?:^|[\s,;])(?:нет|точнее|точней|вернее|исправляю|поправка|лучше)(?=$|[\s,;:])/gu;
const clockNumber = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
function minutes(value) {
  return value === '24:00' ? 1440 : Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function format(value) {
  return (
    String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0')
  );
}
function validWindow(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 5 &&
    ['kind', 'from', 'to', 'fromInclusive', 'toInclusive'].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    [...Object.keys(namedBounds), 'range'].includes(value.kind) &&
    clockNumber(value.from) &&
    (clockNumber(value.to) || value.to === '24:00') &&
    typeof value.fromInclusive === 'boolean' &&
    typeof value.toInclusive === 'boolean' &&
    minutes(value.from) + (value.fromInclusive ? 0 : 1) < minutes(value.to) &&
    (value.kind === 'range' ||
      (value.from === namedBounds[value.kind][0] &&
        value.to === namedBounds[value.kind][1] &&
        value.fromInclusive &&
        !value.toInclusive))
  );
}
function windowBounds(window) {
  if (!validWindow(window)) return null;
  return {
    time: format(minutes(window.from) + (window.fromInclusive ? 0 : 1)),
    endTime: window.to,
  };
}
function windowLabel(window) {
  if (!validWindow(window)) return '';
  const labels = {
    morning: 'утром',
    day: 'днём',
    evening: 'вечером',
    night: 'ночью',
    any: 'в любое время',
  };
  if (labels[window.kind]) return labels[window.kind];
  if (window.to === '24:00') return (window.fromInclusive ? 'с ' : 'после ') + window.from;
  if (window.from === '00:00' && window.fromInclusive)
    return (window.toInclusive ? 'не позже ' : 'до ') + window.to;
  return (
    (window.fromInclusive ? 'с ' : 'после ') +
    window.from +
    (window.toInclusive ? ' по ' : ' до ') +
    window.to
  );
}
function parseBookingTimeWindow(raw) {
  const original = typeof raw === 'string' ? raw : '';
  if (!original || original.length > 4000)
    return { status: 'none', window: null, maskedText: original, reason: null };
  const text = normalizeClockSeparators(
    normalizeNumericRanges(original.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е')),
  );
  const matches = [],
    excluded = [];
  const add = (match, window, reason = null) => {
    if (
      [...matches, ...excluded].some(
        (row) => match.index < row.end && match.index + match[0].length > row.start,
      )
    )
      return;
    const tail = text.slice(match.index + match[0].length);
    const prefix = text.slice(0, match.index);
    if (/(?:длительностью|продолжительностью|длится|длиться)\s*$/u.test(prefix)) {
      excluded.push({ start: match.index, end: match.index + match[0].length });
      return;
    }
    // Calendar ranges and duration ranges stay in their original strict parsers.
    if (
      new RegExp(
        '^\\s*(?:' +
          monthWord +
          '|числа|минут[а-я]*|секунд[а-я]*|дней|дня|день|недел[а-я]*|месяц[а-я]*)(?=$|[\\s,.!?])',
        'u',
      ).test(tail)
    ) {
      excluded.push({ start: match.index, end: match.index + match[0].length });
      return;
    }
    matches.push({ start: match.index, end: match.index + match[0].length, window, reason });
  };
  const range = new RegExp(
    cue +
      '(?:с|от)\\s+(' +
      endpoint +
      ')\\s+(до|по)\\s+(' +
      endpoint +
      ')(?:\\s+(включительно))?' +
      edge,
    'gu',
  );
  const between = new RegExp(
    cue + 'между\\s+(' + endpoint + ')\\s+и\\s+(' + endpoint + ')' + edge,
    'gu',
  );
  for (const pattern of [range, between])
    for (const match of text.matchAll(pattern)) {
      const from = readClock(match[1]),
        to = readClock(match[pattern === range ? 3 : 2], true);
      const window = {
        kind: 'range',
        from,
        to,
        fromInclusive: pattern === range,
        toInclusive: pattern === range && (match[2] === 'по' || !!match[4]),
      };
      add(match, validWindow(window) ? window : null, 'invalid-range');
    }
  const bounded = new RegExp(
    cue +
      '(не\\s+раньше|не\\s+ранее|не\\s+позже|не\\s+позднее|начиная\\s+с|после|позже|позднее|до|раньше|ранее)\\s+(?:чем\\s+)?(' +
      endpoint +
      ')' +
      edge,
    'gu',
  );
  // One explicit lower/upper pair is one window, not two competing windows.
  const pairedAfter = new RegExp(
    cue + 'после\\s+(' + endpoint + ')\\s+(?:и\\s+)?до\\s+(' + endpoint + ')' + edge,
    'gu',
  );
  for (const match of text.matchAll(pairedAfter)) {
    const window = {
      kind: 'range',
      from: readClock(match[1]),
      to: readClock(match[2], true),
      fromInclusive: false,
      toInclusive: false,
    };
    add(match, validWindow(window) ? window : null, 'invalid-range');
  }
  for (const match of text.matchAll(bounded)) {
    const lower = /^(?:не\s+ран|не\s+ранее|начиная|после|позже|позднее)/u.test(match[1]);
    const clock = readClock(match[2], !lower);
    const window = {
      kind: 'range',
      from: lower ? clock : '00:00',
      to: lower ? '24:00' : clock,
      fromInclusive: !lower || /^(?:не|начиная)/u.test(match[1]),
      toInclusive: !lower && /^не/u.test(match[1]),
    };
    add(match, validWindow(window) ? window : null, 'invalid-bound');
  }
  const named = new RegExp(
    cue +
      '(?:(?:на|в)\\s+)?(утром|утро|наутро|днем|вечером|вечер|ночью|ночь|после\\s+обеда|до\\s+обеда|(?:в\\s+)?любое\\s+время|без\\s+ограничени[яй]\\s+(?:по\\s+)?времени)' +
      edge,
    'gu',
  );
  for (const match of text.matchAll(named)) {
    const prefix = text.slice(Math.max(0, match.index - 100), match.index);
    const clockPrefix = /(?:^|[\s,;])(?:в|на|ко?)\s+[^,;!?]{1,80}$/u.exec(prefix);
    if (clockPrefix && parseSpokenTime((clockPrefix[0] + match[0]).trim())) continue;
    const word = match[1],
      kind = /утр|до\s+обеда/u.test(word)
        ? 'morning'
        : /днем|после\s+обеда/u.test(word)
          ? 'day'
          : /вечер/u.test(word)
            ? 'evening'
            : /ноч/u.test(word)
              ? 'night'
              : 'any';
    const [from, to] = namedBounds[kind];
    add(match, { kind, from, to, fromInclusive: true, toInclusive: false });
  }
  // A partly understood spoken range must not degrade to its other recognized bound.
  const loose = new RegExp(cue + '(?:между|с|от|после|позже|позднее|до|раньше|ранее)\\s+', 'gu');
  for (const match of text.matchAll(loose)) {
    if ([...matches, ...excluded].some((row) => match.index >= row.start && match.index < row.end))
      continue;
    let cursor = match.index + match[0].length,
      end = cursor,
      count = 0;
    while (count < 12) {
      const token = /^(?:\d{1,3}(?::\d{1,3})?|[а-я]+)(?=$|[\s,.!?;])/u.exec(text.slice(cursor));
      if (
        !token ||
        (!clockWord(token[0]) &&
          !(
            count &&
            /^(?:и|до|по|час(?:а|ов|ами)?|минут(?:а|ы|у|ами)?|утра|дня|вечера|ночи)$/u.test(
              token[0],
            )
          ))
      )
        break;
      count++;
      end = cursor + token[0].length;
      cursor = end + /^\s*/u.exec(text.slice(end))[0].length;
    }
    if (count) add({ ...match, 0: text.slice(match.index, end) }, null, 'unsupported-clock-range');
    if (count && matches.some((row) => row.start > match.index && row.start < end)) {
      matches.push({ start: match.index, end, window: null, reason: 'unsupported-clock-range' });
    }
  }
  for (const row of [...matches]) {
    const after = new RegExp(
      '^\\s+(?:или|либо)\\s+(?:(?:в|на|ко?)\\s+)?' + endpoint + edge,
      'u',
    ).exec(text.slice(row.end));
    if (after)
      matches.push({
        start: row.end,
        end: row.end + after[0].length,
        window: null,
        reason: 'alternative-window',
      });
    const before = new RegExp(
      '(?:(?:в|на|ко?)\\s+)?' + endpoint + '\\s+(?:или|либо)\\s*$',
      'u',
    ).exec(text.slice(0, row.start));
    if (before)
      matches.push({
        start: before.index,
        end: row.start,
        window: null,
        reason: 'alternative-window',
      });
  }
  if (!matches.length) return { status: 'none', window: null, maskedText: original, reason: null };
  matches.sort((a, b) => a.start - b.start);
  // Mask only proven preference spans and their immediate uncertainty modifiers.
  for (const row of matches) {
    const prefix = text.slice(0, row.start),
      suffix = text.slice(row.end);
    const modifier = /(?:^|[\s,;])(?:не|примерно|около|приблизительно|если)\s*$/u.exec(prefix);
    if (modifier) {
      row.start = modifier.index;
      row.reason = 'uncertain-window';
      row.window = null;
    }
    if (
      !dateTail.test(suffix) &&
      (/^\s*(?:[:.-]\s*\d|\d|минут[а-я]*|секунд[а-я]*)/u.test(suffix) || clockTail(suffix))
    ) {
      row.reason = 'invalid-window-tail';
      row.window = null;
    }
  }
  let masked = text;
  for (const row of [...matches].reverse())
    masked = masked.slice(0, row.start) + ' '.repeat(row.end - row.start) + masked.slice(row.end);
  const markers = [...text.matchAll(corrections)];
  const last = matches.at(-1),
    finalMarker = markers.filter((m) => m.index >= last.end).at(-1);
  if (finalMarker) {
    const tail = text.slice(finalMarker.index + finalMarker[0].length).replace(/^[\s,:;]+/u, '');
    if (
      (/^(?:(?:время|начало)\s+)?(?:в|на|к|ко)\s+/u.test(tail) ||
        /^\d{1,2}:\d{2}[.!?]*$/u.test(tail)) &&
      parseTimeText(tail)
    )
      return { status: 'none', window: null, maskedText: masked, reason: 'exact-correction' };
  }
  const relevant = matches.filter(
    (row) => !markers.some((m) => m.index > row.end && m.index < last.start),
  );
  const gap = relevant.length > 1 ? text.slice(relevant[0].end, last.start) : '';
  const unresolved = masked.split(corrections).at(-1);
  const ambiguity =
    relevant.length !== 1 ||
    relevant.some((row) => !row.window) ||
    /(?:^|[\s,;])(?:не|нет)(?=$|[\s,;])/u.test(unresolved) ||
    /(?:^|[\s,;])(?:или|либо|если|кроме|исключая)(?=$|[\s,;])/u.test(text);
  if (relevant.length > 1 && /^(?:\s|,|или|либо|и)+$/u.test(gap)) {
    const first = relevant[0];
    masked =
      masked.slice(0, first.end) + ' '.repeat(last.start - first.end) + masked.slice(last.start);
  }
  return {
    status: ambiguity ? 'invalid' : 'valid',
    window: ambiguity ? null : last.window,
    maskedText: masked,
    reason: ambiguity ? last.reason || 'multiple-windows' : null,
  };
}
module.exports = { parseBookingTimeWindow, windowBounds, windowLabel };
