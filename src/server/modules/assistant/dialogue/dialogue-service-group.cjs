const { readSteps } = require('../read-steps.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const { appointmentContext } = require('../actions/availability-context.cjs');
const { pickerModel } = require('./dialogue-service-picker.cjs');
const { temporalWordsOnly } = require('../language/time/temporal-words.cjs');
const { isAffirmativeAnswer } = require('./affirmative-answer.cjs');
const { exactServiceAnswer } = require('../language/services/service-exact-followup.cjs');
const { serviceWordForms } = require('../language/services/service-matching.cjs');
const normalize = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .replace(/[.!?…]+$/u, '')
    .trim();
const ordinal =
  /^(?:(?:выбери|выбираю|беру|давай|давайте|возьми|хочу|можно)\s+)?(?:(?:вариант|номер)\s+)?(?:\d{1,2}|(?:перв|втор|трет|четверт|пят|шест|седьм|восьм|девят|десят|одиннадцат|двенадцат|последн|предпоследн)(?:ый|ий|ой|ая|ую|ое|его|юю|ее))(?:\s+вариант)?$/u;
const outerQuotes = /^(?:«(.+)»|„(.+)“|“(.+)”|"(.+)")$/u;
const pluralAdjective = /^(?<stem>[а-я]{2,})(?<ending>ые|ых|ым|ыми|ие|их|им|ими)$/u;
function groupTitleKey(value) {
  const text = normalize(value);
  const quotes = outerQuotes.exec(text);
  return quotes ? quotes.slice(1).find(Boolean).trim() : text;
}
function sameGroupWord(title, spoken) {
  if (title === spoken) return true;
  if (!/^[а-я]+$/u.test(title) || !/^[а-я]+$/u.test(spoken)) return false;
  if (serviceWordForms(title).has(spoken) || serviceWordForms(spoken).has(title)) return true;
  const left = pluralAdjective.exec(title)?.groups;
  const right = pluralAdjective.exec(spoken)?.groups;
  return Boolean(left && right && left.stem === right.stem && left.ending[0] === right.ending[0]);
}
function matchingGroups(groups, { query, literalQuery }) {
  const key = groupTitleKey(query);
  for (const name of new Set([literalQuery, query, key])) {
    if (!name) continue;
    const exact = groups.filter((group) => normalize(group.title) === name);
    if (exact.length) return exact;
  }
  const equivalent = groups.filter((group) => groupTitleKey(group.title) === key);
  if (equivalent.length) return equivalent;
  const words = key.split(' ');
  // Compare the entire ordered title. Codes, punctuation and other qualifiers
  // keep their literal meaning when Russian words differ by case.
  return groups.filter((group) => {
    const title = groupTitleKey(group.title).split(' ');
    return title.length === words.length && title.every((word, i) => sameGroupWord(word, words[i]));
  });
}
function groupRequest(value) {
  if (typeof value !== 'string' || value.length > 160 || /[\r\n\u0000-\u001f\u007f]/u.test(value))
    return null;
  let text = normalize(value)
    .replace(/[.!?…]+$/u, '')
    .replace(/^пожалуйста[,\s]+/u, '')
    .replace(/[,\s]+пожалуйста$/u, '')
    .trim();
  const memory =
    /^(?:я\s+)?не\s+(?:помню|знаю)\s+(?:точное\s+)?название(?:\s+услуги)?[,;\s]+/u.exec(text);
  if (memory) text = text.slice(memory[0].length);
  if (
    /^(?:категории|другие категории|другая категория|назад к категориям|все услуги|покажи все услуги|сначала|к началу(?: списка)?|покажи сначала|(?:(?:покажи(?:те)?|показать)\s+)?(?:еще|другие)(?:\s+(?:услуги|категории|варианты))?|без услуги(?: каталога)?|без каталога|(?:услугу )?уточню в форме)$/u.test(
      text,
    )
  )
    return null;
  const show =
    /^(?:покажи(?:те)?|показать|открой(?:те)?)\s+(?:мне\s+)?(?:услуги\s+(?:из\s+)?)?(?:(группу|группы|категорию|категории)\s+)?(.+)$/u.exec(
      text,
    );
  if (show)
    return {
      query: show[2],
      explicit: Boolean(show[1]),
      groupOnly: Boolean(show[1]),
      requireMatch: Boolean(memory),
      strong: true,
    };
  const role =
    /^(?:группа|группу|категория|категорию|из\s+группы|из\s+категории|выбираю\s+категорию|выбери\s+категорию)\s+(.+)$/u.exec(
      text,
    );
  if (role)
    return {
      query: role[1],
      literalQuery: text,
      explicit: true,
      groupOnly: true,
      requireMatch: Boolean(memory),
      strong: false,
    };
  if (
    !text ||
    ordinal.test(text) ||
    temporalWordsOnly(text) ||
    isAffirmativeAnswer(text) ||
    /^(?:нет|отмена|стоп|назад|вернись|шаг назад)$/u.test(text)
  )
    return null;
  return {
    query: text,
    explicit: false,
    requireMatch: Boolean(memory),
    strong: false,
  };
}
const freshModel = readSteps(function* (c, data, context) {
  c.assertCurrent?.();
  const fresh = context || (yield appointmentContext(c));
  if (!data.staff || !fresh.members.some((member) => member.accountId === data.staff.id))
    throw fail(409, 'Специалист изменился. Выберите его ещё раз.');
  const model = yield pickerModel(c, { ...data, serviceQuery: '', servicePicker: null }, fresh);
  c.assertCurrent?.();
  return model;
});
// Unqualified browse requests keep exact-service precedence. A nominal group
// prefix can also be part of the complete catalog title.
const serviceGroupOperation = readSteps(function* (c, entry, value, strong) {
  if (
    !c ||
    entry?.step !== 'service' ||
    !entry.data?.staff ||
    entry.data.serviceChosen ||
    entry.availabilitySearch
  )
    return null;
  const request = groupRequest(value);
  if (!request?.query || request.strong !== strong) return null;
  const model = yield freshModel(c, entry.data);
  const matches = matchingGroups(model.groups, request);
  const key = groupTitleKey(request.query);
  // Catalog titles may themselves contain imperative words. Preserve the
  // existing service proof against the whole answer before removing a wrapper.
  if (!request.groupOnly && (yield exactServiceAnswer(model.services, value)).matches.length)
    return null;
  if (!request.groupOnly && model.services.some((service) => groupTitleKey(service.name) === key))
    return null;
  if (
    !matches.length &&
    (request.requireMatch ||
      !request.explicit ||
      /(?:^|[\s,;])(?:и|или|либо|если|кроме|вместо|не|нет)(?=$|[\s,;])/u.test(key))
  )
    return null;
  return {
    kind: 'serviceGroup',
    query: request.query,
    ...(request.literalQuery ? { literalQuery: request.literalQuery } : {}),
    catalogStamp: model.stamp,
    requiresClarification: true,
  };
});
const applyServiceGroup = readSteps(function* (c, data, operation, context) {
  const model = yield freshModel(c, data, context);
  if (model.stamp !== operation.catalogStamp)
    throw fail(409, 'Список услуг изменился. Назовите группу ещё раз.');
  const matches = matchingGroups(model.groups, operation);
  // Only the unsuccessful service search and its browse page are replaced.
  // Client/staff/date/time/duration and all domain decisions stay authoritative.
  data.serviceQuery = '';
  data.servicePicker = {
    staffId: data.staff.id,
    query: '',
    stamp: model.stamp,
    categoryId: matches.length === 1 ? matches[0].id : '',
    offset: 0,
    ...(matches.length !== 1 ? { reason: matches.length ? 'ambiguousGroup' : 'unknownGroup' } : {}),
  };
  delete data._clarificationRecovery;
});
module.exports = { serviceGroupOperation, applyServiceGroup };
