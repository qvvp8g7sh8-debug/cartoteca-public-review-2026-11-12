const { parseDuration } = require('../../language/time/spoken-duration.cjs');
const { windowBounds } = require('../../language/time/booking-time-window.cjs');
const { replacementParts } = require('./appointment-management-replacement.cjs');
const fold = (raw) =>
  String(raw || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
function sourceCorrection(entry, raw) {
  const text = fold(raw);
  const replacement = replacementParts(raw);
  if (replacement) {
    const rejected = sourceOrdinal(replacement.before),
      wanted = sourceOrdinal(replacement.after),
      m = entry.data.management,
      previous = m.sourceChoices?.[rejected],
      value = m.sourceChoices?.[wanted];
    return previous &&
      value &&
      previous.patientId === m.source?.patientId &&
      previous.appointmentId === m.source.appointmentId &&
      previous.sourceStamp === m.source.sourceStamp
      ? { kind: 'source', value }
      : null;
  }
  if (
    /^(?:нет[, ]+)?(?:другую(?: запись)?|не (?:эту|ту)(?: запись)?|(?:выбрать|выбери|покажи) другую(?: запись)?)$/u.test(
      text,
    )
  )
    return { kind: 'other' };
  const answer = /^нет[, ]+(.+)$/u.exec(text);
  if (!answer) return null;
  const index = sourceOrdinal(answer[1]);
  const value = (entry.data.management.sourceChoices || [])[index];
  return value ? { kind: 'source', value } : null;
}
function sourceOrdinal(text) {
  const word = text.replace(/^(?:запись|вариант) /u, '').replace(/ (?:запись|вариант)$/u, '');
  const stems = [
    'перв',
    'втор',
    'трет',
    'четверт',
    'пят',
    'шест',
    'седьм',
    'восьм',
    'девят',
    'десят',
    'одиннадцат',
    'двенадцат',
  ];
  return /^\d{1,2}$/u.test(word)
    ? Number(word) - 1
    : stems.findIndex((stem) =>
        new RegExp('^' + stem + '(?:ую|ый|ой|ое|ий|ью|ье)$', 'u').test(word),
      );
}
function resetSource(m) {
  for (const key of [
    'sourceDate',
    'sourceTime',
    'sourceWindow',
    'sourceDay',
    'sourceMonth',
    'sourceYear',
    'sourceYearRequired',
    'sourceDateRequired',
    'sourceTimeRequired',
    'sourceServiceQuery',
    'cancelConfirmation',
    'cancelConfirmed',
    'movePreparation',
    'closedConfirmation',
    'pendingShift',
  ])
    delete m[key];
  m.source = null;
  m.dateRequired = false;
  m.timeRequired = false;
}
function setSourceDay(m, day) {
  if (m.sourceDate) {
    m.sourceMonth = Number(m.sourceDate.slice(5, 7));
    m.sourceYear = m.sourceDate.slice(0, 4);
    delete m.sourceDate;
  }
  m.sourceDay = day;
}
function clearSourceDate(m) {
  for (const key of ['sourceDate', 'sourceDay', 'sourceMonth', 'sourceYear']) delete m[key];
  m.sourceDateRequired = true;
}
function clearSourceTime(m) {
  delete m.sourceTime;
  delete m.sourceWindow;
  m.sourceTimeRequired = true;
}
function clearTargetWindow(m) {
  delete m.targetWindow;
  delete m.targetWindowDate;
}
function targetWindowBounds(m) {
  return m.targetWindowDate === m.targetDate ? windowBounds(m.targetWindow) || {} : {};
}
function targetFitsWindow(m, duration) {
  const bounds = targetWindowBounds(m);
  if (!bounds.time) return true;
  const minute = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  return m.targetTime >= bounds.time && minute(m.targetTime) + duration <= minute(bounds.endTime);
}
function shiftDirection(raw) {
  const match = /^(?:(?:чуть|немного) )?(попозже|пораньше|позже|раньше|позднее|ранее)$/u.exec(
    fold(raw),
  );
  return match ? (/ран/u.test(match[1]) ? -1 : 1) : null;
}
function shiftAmount(m, raw) {
  if (![1, -1].includes(m.pendingShift)) return null;
  const text = fold(raw).replace(/^на /u, '');
  // A duration is accepted only in the explicitly asked shift context, not a clock.
  if (!/(?:час|минут)/u.test(text) || /(?:^|\s)(?:не|нет|или|если)(?=$|\s)/u.test(text))
    return null;
  const minutes = parseDuration(text);
  return minutes ? { kind: 'shiftTime', minutes: m.pendingShift * minutes } : null;
}
module.exports = {
  sourceCorrection,
  resetSource,
  setSourceDay,
  clearSourceDate,
  clearSourceTime,
  clearTargetWindow,
  targetWindowBounds,
  targetFitsWindow,
  shiftDirection,
  shiftAmount,
};
