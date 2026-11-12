const { readSteps } = require('./../read-steps.cjs');
const { fastBookingOperation } = require('./dialogue-fast-booking.cjs');
const { servicePickerOperation } = require('./dialogue-service-picker.cjs');
const { serviceGroupOperation } = require('./dialogue-service-group.cjs');
const { exactServiceFollowup } = require('../language/services/service-exact-followup.cjs');
const { appointmentContext } = require('../actions/availability-context.cjs');
const { matchesName } = require('../language/names/name-matching.cjs');
const { resolveFieldAnswer, isSelfReference } = require('./field-answer.cjs');
const { isSlotRequest } = require('../actions/slot-request.cjs');
const { isAffirmativeAnswer } = require('./affirmative-answer.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const { boundedText } = require('../interpretation/intent-schema.cjs');
const { bookingDateReading, parseTimeText } = require('../language/time/temporal.cjs');
const { clearField, fields } = require('./dialogue-options.cjs');
const { parseDuration } = require('../language/time/spoken-duration.cjs');
const { suggestionsOnlyQuery } = require('../language/names/name-suggestions.cjs');
const { dialogueControl } = require('./dialogue-control.cjs');
function acceptText(data, step, value, clock) {
  const text = boundedText(value, 160, 'ответ для записи').trim();
  if (!text) throw fail(400, 'Введите ответ или выберите вариант.');
  if (step === 'client') {
    data.clientQuery = text;
    data.patient = null;
    data.clientSuggestionsOnly = suggestionsOnlyQuery(text);
  } else if (step === 'staff') {
    clearField(data, 'staff');
    data.staffQuery = text;
  } else if (step === 'service') {
    if (data.servicePicker?.categoryId) {
      data.servicePicker.answer = text;
      delete data.servicePicker.suggestedName;
      return;
    }
    clearField(data, 'service');
    data.serviceQuery = text;
  } else if (step === 'date') {
    const { date, dateWeekday, dateProposal } = bookingDateReading(text, clock, {
      futureMonth: true,
    });
    if (dateProposal) {
      clearField(data, 'date');
      data.dateProposal = dateProposal;
      return;
    }
    if (dateWeekday) {
      clearField(data, 'date');
      data.dateWeekday = dateWeekday;
      return;
    }
    if (!date || date < clock.date) throw fail(400, 'Укажите сегодняшнюю или будущую дату.');
    data.date = date;
    data.dateMonthContext = date.slice(0, 7);
    delete data.dateProposal;
    delete data.dateMonth;
    delete data.dateWeekday;
    delete data.dateRejection;
    data.roomId = '';
  } else if (step === 'time') {
    const time = parseTimeText(text, { timeContext: true });
    if (!time)
      throw fail(
        400,
        'Уточните точное время и часть суток, например «два часа тридцать минут дня», или попросите подобрать окно.',
      );
    data.time = time;
    data.roomId = '';
    data.seekSlots = false;
    data.slotAfterTime = '';
  } else if (step === 'duration') {
    const duration = parseDuration(text);
    if (!duration) throw fail(400, 'Длительность — от 5 до 1440 минут с шагом 5.');
    data.duration = duration;
    data.durationSource = 'manual';
    data.roomId = '';
  } else throw fail(400, 'Выберите предложенный вариант или начните новую команду.');
}
function clientSuggestionOperation(entry, value) {
  if (entry.step !== 'client' || !entry.options.size) return null;
  const choices = [...entry.options];
  if (choices.some(([, choice]) => choice.kind !== 'client' || choice.approximate !== true))
    return null;
  const text = boundedText(value, 160, 'ответ для записи')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.!?…]+$/u, '')
    .trim();
  if (text === 'нет') return { kind: 'edit', field: 'client' };
  const identified = /^(?:(.+?)[,\s]+)?это\s+(?:он|она)$/u.exec(text);
  const confirmedIdentity = identified && (!identified[1] || isAffirmativeAnswer(identified[1]));
  if (!isAffirmativeAnswer(value) && !confirmedIdentity) return null;
  return choices.length === 1
    ? { kind: 'choice', choice: choices[0][0] }
    : {
        kind: 'localHelp',
        text: 'Назовите номер нужного клиента или скажите «нет», чтобы уточнить имя или телефон.',
      };
}
// A whole answer to the staff question belongs to the fresh eligible staff
// catalog, even when a client happens to have the same name. No fuzzy lookup.
const exactStaffFollowup = readSteps(function* exactStaffFollowup(c, entry, value) {
  if (!c || entry?.step !== 'staff' || typeof value !== 'string' || value.length > 160) return null;
  const { members } = yield appointmentContext(c);
  const result = yield resolveFieldAnswer('staff', value, (query) => ({
    matches: members.filter((member) =>
      isSelfReference(query)
        ? member.accountId === c.current.accountId
        : matchesName(member, query, true),
    ),
  }));
  // An ambiguous exact name stays a staff clarification; never choose the first.
  return result.matches.length ? { kind: 'text', text: result.query } : null;
});
const fastContinuationOperation = readSteps(
  function* fastContinuationOperation(entry, value, clock, c) {
    const staff = yield exactStaffFollowup(c, entry, value);
    if (staff) return staff;
    const explicitGroup = yield serviceGroupOperation(c, entry, value, true);
    if (explicitGroup) return explicitGroup;
    const exactService = yield exactServiceFollowup(c, entry, value);
    if (exactService) return exactService;
    const group = yield serviceGroupOperation(c, entry, value, false);
    if (group) return group;
    const service = servicePickerOperation(entry, value);
    if (service) return service;
    const booking = fastBookingOperation(entry, value, clock);
    if (booking) return booking;
    const text = boundedText(value, 160, 'ответ для записи')
      .trim()
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[.!?…]+$/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (/^(?:повтори(?:\s+(?:вопрос|еще\s+раз))?|еще\s+раз|что\s+ты\s+сказал[а]?)$/u.test(text))
      return { kind: 'localHelp', text: entry.response.dialogue.prompt };
    return null;
  },
);
const isFastContinuation = readSteps(function* isFastContinuation(value, entry, clock, c, local) {
  if (typeof value === 'string' && value.length > 160) return false;
  if (dialogueControl(value, 'create')) return true;
  // These whole answers already have strict local handlers; do not ask the model twice.
  if (
    (yield exactStaffFollowup(c, entry, value)) ||
    (yield serviceGroupOperation(c, entry, value, true)) ||
    (yield exactServiceFollowup(c, entry, value)) ||
    (yield serviceGroupOperation(c, entry, value, false)) ||
    servicePickerOperation(entry, value) ||
    clientSuggestionOperation(entry, value) ||
    isSlotRequest(value) ||
    (entry?.step === 'duration' && parseDuration(value) !== null) ||
    isAffirmativeAnswer(value)
  )
    return true;
  const booking = fastBookingOperation(entry, value, clock);
  if (booking) {
    if (local) local.bookingInput = booking;
    return true;
  }
  const text = boundedText(value, 160, 'ответ для записи')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.!?…]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (
    /^(?:(?:выбери|выбираю|беру|давай|давайте|возьми|хочу|можно)\s+)?(?:вариант\s+(?:номер\s+)?|окно\s+|окошко\s+|номер\s+)(?:\d{1,2}|один|одна|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)$/u.test(
      text,
    )
  )
    return true;
  if (
    /^(?:выбери|выбираю|беру|давай|давайте|возьми|хочу|можно)\s+(?:(?:вариант|окно|окошко|номер)\s+(?:номер\s+)?)?(?:первый|первую|первое|второй|вторую|второе|третий|третью|третье|четвертый|четвертую|пятый|пятую|шестой|шестую|последний|предпоследний|\d{1,2})(?:\s+(?:вариант|окно|окошко))?$/u.test(
      text,
    )
  )
    return true;
  return /^(?:да|нет|верно|это\s+(?:он|она)|все\s+верно|подтверждаю(?:\s+данные)?|отмена|стоп|не\s+надо|отмени(?:ть)?(?:\s+(?:подготовку|черновик|запись))?|заверши\s+диалог|назад|вернись|шаг\s+назад|повтори(?:\s+(?:вопрос|еще\s+раз))?|еще\s+раз|что\s+ты\s+сказал[а]?|открой(?:\s+форму(?:\s+записи)?)?|открывай\s+форму|подготовь\s+форму(?:\s+записи)?|запиши|записать|\d{1,2}|(?:(?:вариант|окно|номер)\s+)?(?:первый|первую|первое|второй|вторую|второе|третий|третью|третье|четвертый|четвертую|пятый|пятую|шестой|шестую|последний|предпоследний)(?:\s+(?:вариант|окно|окошко))?)$/u.test(
    text,
  );
});
function validateContinuation(body) {
  const operations = ['text', 'choice', 'edit', 'cancel'].filter((key) => body[key] !== undefined);
  if (operations.length !== 1 || (body.cancel !== undefined && body.cancel !== true))
    throw fail(400, 'Укажите один ответ, выбор, исправление или отмену.');
  if (
    body.cancel !== true &&
    (!Number.isSafeInteger(body.dialogueVersion) || body.dialogueVersion < 0)
  )
    throw fail(400, 'Укажите текущую версию диалога.');
  if (body.edit !== undefined && !fields.includes(body.edit))
    throw fail(400, 'Это поле нельзя исправить через помощника.');
  if (body.choice !== undefined && (typeof body.choice !== 'string' || body.choice.length > 64))
    throw fail(400, 'Выберите вариант из текущего диалога.');
  return operations[0];
}
module.exports = {
  parseDuration,
  acceptText,
  validateContinuation,
  clientSuggestionOperation,
  fastContinuationOperation,
  isFastContinuation,
};
