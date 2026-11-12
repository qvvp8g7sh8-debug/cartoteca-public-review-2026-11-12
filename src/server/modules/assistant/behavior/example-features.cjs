const stopWords = new Set(
  'а и в во на с со у к ко из от для по при же бы ли это этот эта эти пожалуйста мне мой моя мои свое свои'.split(
    ' ',
  ),
);
function fold(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е');
}
function stem(word) {
  if (word.length < 5 || !/^[а-я]+$/u.test(word)) return word;
  return word.replace(
    /(?:иями|ями|ами|ого|его|ому|ему|ыми|ими|остью|ости|овать|евать|ывать|ивать|ать|ять|ить|ешь|ишь|ете|ите|али|яли|или|ают|яют|уют|ие|ые|ое|ее|ая|яя|ую|юю|ой|ей|ий|ый|ов|ев|ам|ям|ах|ях|ом|ем|ою|ею|ия|ию|ии|ья|ье|ью|а|я|ы|и|у|ю|е|о|ь)$/u,
    '',
  );
}
function tokens(text) {
  const normalized = fold(text)
    .replace(/\+?\d[\d ()-]{8,}\d/gu, ' телефон ')
    .replace(/\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,4})?/gu, ' дата ')
    .replace(/\d{1,2}:\d{2}/gu, ' время ')
    .replace(/\d+/gu, ' число ');
  return (normalized.match(/[\p{L}]+/gu) || [])
    .filter((word) => word.length > 1 && !stopWords.has(word))
    .map(stem);
}
function hints(text) {
  const value = fold(text),
    result = new Map();
  const add = (intent, weight) => result.set(intent, Math.max(result.get(intent) || 0, weight));
  const requested = detectRequestedOperation(text);
  if (requested.intent === 'help') {
    add('help', 1.4);
    return result;
  }
  const uncertainAction =
    requested.negated ||
    requested.ambiguous ||
    /(?:^|[\s,;])(?:если|при условии|в случае)(?=$|[\s,;])/u.test(value);
  if (
    !uncertainAction &&
    [
      'calendar',
      'clientCard',
      'clients',
      'prepareAppointment',
      'moveAppointment',
      'cancelAppointment',
      'editAppointment',
    ].includes(requested.intent)
  )
    add(requested.intent, 1.4);
  else if (uncertainAction && (requested.operation || requested.ambiguous)) add('help', 1.4);
  if (/расписан|календар|мое.*(?:недел|месяц)|мои.*(?:запис|прием)/u.test(value))
    add('calendar', 1);
  if (
    /карточ|(?:^|\s)карт[ауеы](?:\s|$)|анкет|истори[яюи].*(?:клиент|пациент|визит)/u.test(value)
  ) {
    add('clientCard', 1);
    add('clients', 0.2);
  }
  if (/клиент|пациент|телефон|фамили|однофамил|най[дт]|поищ|отыщ/u.test(value))
    add('clients', 0.55);
  if (
    /свобод|окн[аоыу]|когда.*(?:принять|запис)|ближайш.*(?:врем|прием)|подбер|подобрать|доступно.*врем/u.test(
      value,
    )
  )
    add('availability', 1);
  if (
    !uncertainAction &&
    /запиш|запис(?:ать|ыва|ывай)|заброниру|запланиру|(?:подготов|созда|оформи|постав|назнач).{0,60}(?:запис|прием)|^(?:новая\s+)?запись(?:\s|$)/u.test(
      value,
    )
  )
    add('prepareAppointment', 1);
  const safeAppointmentDeletion =
    !uncertainAction && requested.operation?.appointmentDeletion === true;
  if (
    (!safeAppointmentDeletion && /удал|сотри/u.test(value)) ||
    /обойд|игнориру|без.*(?:прав|провер)|всех.*(?:запис|клиент)|массов|(?:^|\s)api(?:\s|$)/u.test(
      value,
    )
  )
    add('help', 0.8);
  return result;
}
function features(text, expected = null, clock = null) {
  const value = fold(text),
    result = new Set();
  const rules = {
    relative: /сегодня|завтра|вчера|через|следующ|ближайш/u,
    date: /\d{1,4}[./-]\d|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр/u,
    time: /\d{1,2}:\d{2}|час|утр|вечер|полд|полноч|половин|четверт/u,
    duration: /минут|длительн|полчас/u,
    phone: /телефон|\+?\d[\d ()-]{8,}\d/u,
    week: /недел/u,
    month: /месяц/u,
    correction: /точнее|вместо|лучше|ой|нет[, ]/u,
    ambiguity: /примерно|около|или|какой|без.*(?:год|имени)/u,
    negation: /(?:^|\s)(?:не|нет|нельзя|без)(?:\s|[,.:!?]|$)/u,
  };
  for (const [key, pattern] of Object.entries(rules)) if (pattern.test(value)) result.add(key);
  if (expected)
    for (const key of Object.keys(expected)) if (key !== 'intent') result.add('field:' + key);
  if (clock?.date && result.has('relative')) {
    if (/-(?:12|01)-/u.test(clock.date)) result.add('year-boundary');
    if (/-(?:0[1-3]|2[8-9]|3[01])$/u.test(clock.date)) result.add('month-boundary');
  }
  return result;
}
function documentProfile(example) {
  const generic = new Set(['телефон', 'дата', 'время', 'число']);
  const names = new Set(
    tokens([example.expected.query, example.expected.staffQuery].filter(Boolean).join(' ')).filter(
      (word) => !generic.has(word),
    ),
  );
  return {
    tokens: tokens(example.text).filter((word) => !names.has(word)),
    features: features(example.text, example.expected, { date: example.referenceDate }),
    intent: example.expected.intent,
  };
}
module.exports = { fold, tokens, hints, features, documentProfile };
const { detectRequestedOperation } = require('../interpretation/requested-operation.cjs');
