const { parseDuration } = require('./spoken-duration.cjs');
const { intentRequestConstraints } = require('../../interpretation/intent-request-duration.cjs');
const { initialTemporalConstraints } = require('./initial-temporal-constraints.cjs');
const { parseBookingTimeWindow, windowBounds } = require('./booking-time-window.cjs');
const { literalSpan } = require('../../interpretation/entity-provenance.cjs');
const { dayOrdinalWord, monthWord } = require('./spoken-day.cjs');
const { parseTimeText, parseDateText } = require('./temporal.cjs');
const { fieldUncertainty } = require('./temporal-field-uncertainty.cjs');
const { maskWindowDurationPhrases } = require('./clock-context.cjs');
const {
  temporalCorrectionScope,
  mergeTemporalCorrection,
} = require('./temporal-correction-scope.cjs');
// A literal alternative between non-temporal entities must not retract an
// independently stated date/clock. Entity resolution still receives the raw text.
function temporalProofText(intent, raw, clock) {
  if (typeof raw !== 'string' || raw.length > 4000 || !/(?:^|\s)(?:или|либо)(?=$|\s)/iu.test(raw))
    return raw;
  let text = raw;
  const calendar = new RegExp(
    '(?:^|[\\s,.!?;])(?:' +
      dayOrdinalWord +
      '|' +
      monthWord +
      '|сегодня|завтра|послезавтра|вчера|позавчера|понедельник[а-я]*|вторник[а-я]*|сред[ауы]|четверг[а-я]*|пятниц[ауы]|суббот[ауы]|воскресень[ея]|час[а-я]*|минут[а-я]*|утр[а-я]*|дня|днем|вечер[а-я]*|ноч[а-я]*)(?=$|[\\s,.!?;])',
    'iu',
  );
  const candidates = ['query', 'staffQuery', 'serviceQuery'].map((key) => intent[key]);
  // An uncertain entity may correctly be null (or be wrongly narrowed) in the
  // proposal. Its literal labelled clause scopes only temporal proof; identity
  // matching and the model's negative/alternative guard still use the raw words.
  for (const prefix of raw.matchAll(
    /(?:^|[\s,;])(?:на|услуг[ау]|процедур[ау]|клиент(?:а)?|пациент(?:а)?|сотрудник(?:а)?|специалист(?:а)?)\s+/giu,
  )) {
    const tail = raw.slice(prefix.index + prefix[0].length, prefix.index + prefix[0].length + 161);
    const source = tail
      .split(/[,.!?;]/u)[0]
      .split(
        /\s+(?:(?:на|в)\s+)?(?:завтра|послезавтра|сегодня|дат[ау]|время|длительность|продолжительность)(?=$|\s)|\s+(?:в|на)\s+\d/iu,
      )[0]
      .trim();
    if (source && source.length <= 160) candidates.push(source);
  }
  for (const proposed of candidates) {
    if (typeof proposed !== 'string' || proposed.length > 160) continue;
    const source = literalSpan(text, proposed);
    if (!source || !/(?:^|\s)(?:или|либо)(?=$|\s)/iu.test(source)) continue;
    const variants = source.split(/\s+(?:или|либо)\s+/iu);
    if (
      variants.length < 2 ||
      variants.length > 4 ||
      variants.some(
        (value) =>
          !/[\p{L}]/u.test(value) ||
          calendar.test(value) ||
          /(?:^|[^\p{L}\p{N}])\d+(?=$|[^\p{L}\p{N}])/u.test(value) ||
          parseTimeText(value) ||
          parseTimeText('в ' + value) ||
          Object.keys(initialTemporalConstraints({ intent: 'prepareAppointment' }, value, clock))
            .length,
      )
    )
      continue;
    text = text.replace(
      source,
      source.replace(/(?:^|\s)(?:или|либо)(?=$|\s)/giu, (value) => ' '.repeat(value.length)),
    );
  }
  return text;
}
function bookingTemporalConstraints(intent, raw, clock, context = {}) {
  if (intent?.intent !== 'prepareAppointment')
    return {
      ...intentRequestConstraints(intent, raw, context),
      ...initialTemporalConstraints(intent, raw, clock),
    };
  const scoped = temporalCorrectionScope(raw);
  if (scoped)
    return mergeTemporalCorrection(
      bookingTemporalConstraints(intent, scoped.before, clock, context),
      bookingTemporalConstraints(intent, scoped.rejected, clock, context),
      bookingTemporalConstraints(intent, scoped.after, clock, context),
    );
  const proof = parseBookingTimeWindow(raw);
  const temporalText = temporalProofText(intent, proof.maskedText, clock);
  const provenWindow = proof.status === 'valid' && proof.window.kind === 'range';
  const result = {
    ...intentRequestConstraints(intent, proof.maskedText, {
      ...context,
      ...(provenWindow ? { provenTimeWindow: true } : {}),
    }),
    ...(context.durationContext === true && parseDuration(raw) !== null
      ? {}
      : initialTemporalConstraints(
          intent,
          provenWindow ? maskWindowDurationPhrases(temporalText) : temporalText,
          clock,
          { clarifyWeekday: context.clarifyWeekday },
        )),
  };
  if (result.date === null && !result.dateProposal && !result.dateWeekday) {
    const normalized = temporalText.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
    const uncertainty = fieldUncertainty(normalized);
    const source = uncertainty.dateText;
    const monthPresent = new RegExp(
      '(?:^|[\\s,.!?;])(?:' + monthWord + ')(?=$|[\\s,.!?;])',
      'u',
    ).test(source);
    const heardDate =
      !uncertainty.date &&
      (parseDateText(source, clock) ||
        (monthPresent &&
          parseDateText(source, { ...clock, date: clock.date.slice(0, 4) + '-01-01' })));
    if (heardDate && heardDate < clock.date) result.dateRejection = 'past';
  }
  if (proof.status === 'none') {
    if (proof.reason === 'exact-correction') result.timeWindow = null;
    return result;
  }
  if (proof.status === 'invalid')
    return { ...result, time: null, timeWindow: null, timeWindowRequired: true };
  const bounds = windowBounds(proof.window);
  if (
    result.time &&
    (result.time < bounds.time ||
      (proof.window.toInclusive ? result.time > bounds.endTime : result.time >= bounds.endTime))
  )
    return { ...result, time: null, timeWindow: null, timeWindowRequired: true };
  return { ...result, time: result.time ?? null, timeWindow: proof.window };
}
module.exports = { bookingTemporalConstraints };
