// A finite command grammar shared by operation grounding and management source extraction.
const {
  cardNounPattern,
  cardOpenForms,
  cardNegativeForms,
  unsupportedCardObject,
} = require('./client-card-grammar.cjs');
const { dayOrdinalWord } = require('../language/time/spoken-day.cjs');
const { calendarPluralTarget, calendarViewTarget } = require('./calendar-read-grammar.cjs');
const boundary = '(?=$|[\\s,.!?;:])';
const leftBoundary = '(^|[\\s,;:])';
const appointment = '(?:запись|записи|при[её]м|при[её]ма)';
const optionalAppointment = '(?:\\s+' + appointment + boundary + ')?';
const readDateTail =
  '(?=$|[.!?…]+$|\\s+(?:на\\s*\\d|(?:на|за|в|во|с|по|сегодня|завтра|послезавтра|вчера|позавчера|через)' +
  boundary +
  '|\\d|' +
  dayOrdinalWord +
  '))';
const editField =
  /(?:^|[\s,;:])(?:услуг[а-я]*|длительность|продолжительность|стоимость|цен[ауы]|заметк[а-я]*|примечани[а-я]*|комментари[а-я]*)(?=$|[\s,.!?;:])/iu;
const specifications = [
  {
    intent: 'editAppointment',
    forms: '(?!)',
    negativeForms: '(?:открывай(?:те)?)',
    suffix: '',
  },
  {
    intent: null,
    forms:
      '(?:удали(?:те)?|удалить|создай(?:те)?|сохрани(?:те)?|сохранить|отправь(?:те)?|отправить)',
    suffix: '',
    secondaryOnly: true,
  },
  {
    intent: 'moveAppointment',
    forms:
      '(?:перенеси(?:те)?|перенести|передвинь(?:те)?|передвинуть|сдвинь(?:те)?|сдвинуть|перезапиши(?:те)?|перезаписать)',
    negativeForms:
      '(?:переноси(?:те)?|передвигай(?:те)?|сдвигай(?:те)?|перезаписывай(?:те)?|переносить|передвигать|сдвигать|перезаписывать)',
    suffix: optionalAppointment,
    nominal: 'перенос\\s+' + appointment,
  },
  {
    intent: 'cancelAppointment',
    forms: '(?:отмени(?:те)?|отменить)',
    negativeForms: '(?:отменяй(?:те)?|отменять)',
    suffix: optionalAppointment,
    nominal: 'отмена\\s+' + appointment,
  },
  {
    intent: 'cancelAppointment',
    forms: '(?:удали(?:те)?|удалить)',
    negativeForms: '(?:удаляй(?:те)?)',
    suffix: '\\s+' + appointment,
    appointmentDeletion: true,
  },
  {
    intent: 'moveAppointment',
    forms: '(?:измени(?:те)?|изменить|поменяй(?:те)?|поменять)',
    negativeForms: '(?:изменяй(?:те)?|меняй(?:те)?)',
    suffix: '\\s+(?:(?:дату|время)\\s+)?' + appointment,
    nominal: '(?:изменение|смена)\\s+' + appointment,
    genericChange: true,
  },
  {
    intent: 'editAppointment',
    forms: '(?:измени(?:те)?|изменить|поменяй(?:те)?|поменять|редактируй(?:те)?|поправь(?:те)?)',
    negativeForms: '(?:изменяй(?:те)?|редактировать|поправляй(?:те)?|поправлять)',
    suffix: optionalAppointment,
    nominal: 'изменение\\s+' + appointment,
  },
  {
    intent: 'calendar',
    forms: '(?:открой(?:те)?|открою|открыть|покажи(?:те)?)',
    negativeForms: '(?:открывай(?:те)?|показывай(?:те)?)',
    suffix:
      '\\s+(?:мне\\s+)?(?:' +
      calendarPluralTarget +
      readDateTail +
      '|' +
      calendarViewTarget +
      boundary +
      ')',
  },
  {
    intent: 'editAppointment',
    forms: '(?:открой(?:те)?|открою|открыть)',
    negativeForms: '(?:открывай(?:те)?)',
    suffix: '\\s+(?:мне\\s+)?' + appointment,
  },
  {
    intent: 'clientCard',
    forms: cardOpenForms,
    negativeForms: cardNegativeForms,
    suffix: '\\s+(?:мне\\s+)?' + cardNounPattern,
  },
  {
    intent: 'clients',
    forms: '(?:открой(?:те)?|покажи(?:те)?)',
    negativeForms: '(?:открывай(?:те)?|показывай(?:те)?)',
    suffix: '\\s+(?:мне\\s+)?список\\s+клиентов',
  },
  {
    intent: 'prepareAppointment',
    forms: '(?:создай(?:те)?|создать|оформи(?:те)?|оформить|заведи(?:те)?|завести)',
    negativeForms: '(?:создавай(?:те)?|оформляй(?:те)?|заводи(?:те)?)',
    suffix: '\\s+(?:мне\\s+)?(?:(?:новую|новый|новое)\\s+)?' + appointment,
    nominal: '(?:новая\\s+запись|новый\\s+при[её]м)',
  },
  {
    intent: 'prepareAppointment',
    forms: '(?:запиши(?:те)?|записать|запишись)',
    negativeForms: '(?:записывай(?:те)?)',
    suffix: '',
  },
];
const rules = specifications.flatMap((spec) => {
  const result = [
    {
      intent: spec.intent,
      expression: new RegExp(
        leftBoundary + '(' + spec.forms + boundary + spec.suffix + ')' + boundary,
        'giu',
      ),
      negativeOnly: false,
      secondaryOnly: Boolean(spec.secondaryOnly),
      genericChange: Boolean(spec.genericChange),
      appointmentDeletion: Boolean(spec.appointmentDeletion),
    },
  ];
  if (spec.nominal)
    result.push({
      intent: spec.intent,
      expression: new RegExp(leftBoundary + '(' + spec.nominal + ')' + boundary, 'giu'),
      negativeOnly: false,
      genericChange: Boolean(spec.genericChange),
    });
  if (spec.negativeForms)
    result.push({
      intent: spec.intent,
      expression: new RegExp(
        leftBoundary + '(' + spec.negativeForms + boundary + spec.suffix + ')' + boundary,
        'giu',
      ),
      negativeOnly: true,
      genericChange: Boolean(spec.genericChange),
      appointmentDeletion: Boolean(spec.appointmentDeletion),
    });
  return result;
});
// Only a trailing save of the newly requested appointment belongs to the same task.
function sameAppointmentSave(text, rows) {
  if (rows.length !== 2) return null;
  const [create, save] = rows;
  if (
    create.intent !== 'prepareAppointment' ||
    create.negated ||
    !save.secondaryOnly ||
    save.negated ||
    !/^сохрани(?:те)?$|^сохранить$/iu.test(text.slice(save.start, save.end))
  )
    return null;
  const connector = /(?:^|[\s,;])и\s+(?:сразу\s+)?$/iu.exec(text.slice(create.end, save.start));
  if (
    !connector ||
    !/^\s*(?:(?:(?:эту|ту)\s+же|эту|новую|созданную|подготовленную)\s+)?(?:запись|при[её]м)?\s*[.!?…]*$/iu.test(
      text.slice(save.end),
    )
  )
    return null;
  return create.end + connector.index;
}
function operationNegated(text, start, end) {
  const prefix = text.slice(0, start);
  if (/(?:^|[\s,;:])не\s+$/iu.test(prefix)) return true;
  // A modal denial scopes only the immediately following recognized infinitive.
  // Other negations (date bounds, services, previous clauses) stay outside it.
  return (
    /(?:^|[\s,;:])не\s+(?:хочу|нужно|надо|следует)\s+$/iu.test(prefix) &&
    /^(?:[^\s,.!?;:]+(?:ть|ти|чь|ться|тись|чься))(?=$|[\s,.!?;:])/iu.test(text.slice(start, end))
  );
}
function detectRequestedOperation(raw) {
  const text = String(raw || '');
  if (unsupportedCardObject(text))
    return {
      intent: 'help',
      negated: false,
      ambiguous: false,
      operation: null,
      sourceWithoutCommand: text,
    };
  const matches = [];
  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    for (const match of text.matchAll(rule.expression)) {
      const start = match.index + match[1].length;
      const end = start + match[2].length;
      const negated = operationNegated(text, start, end);
      if (rule.negativeOnly && !negated) continue;
      matches.push({
        intent: rule.genericChange && editField.test(text) ? 'editAppointment' : rule.intent,
        start,
        end,
        negated,
        secondaryOnly: Boolean(rule.secondaryOnly),
        ...(rule.appointmentDeletion ? { appointmentDeletion: true } : {}),
      });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const distinct = matches.filter(
    (row, index) =>
      !matches.slice(0, index).some((prior) => prior.start === row.start && prior.end >= row.end),
  );
  const saveStart = sameAppointmentSave(text, distinct);
  const requested =
    saveStart !== null
      ? [distinct[0]]
      : distinct.some((row) => !row.secondaryOnly)
        ? distinct
        : distinct.filter((row) => !row.secondaryOnly);
  // Only a single unconditional appointment deletion can mean soft cancellation.
  // Keep this guard local to that alias; choosing or deleting other objects is unsupported.
  const blockedDeletion =
    requested.some((row) => row.appointmentDeletion) &&
    /(?:^|[\s,;:])(?:если|или|либо|и|кроме|вместо|все|вс[её]х|обе|оба|кажд[а-я]*|при\s+условии|в\s+случае)(?=$|[\s,.!?;:])/iu.test(
      text,
    );
  const ambiguous =
    requested.length > 1 || (distinct.length > 0 && requested.length === 0) || blockedDeletion;
  const operation = requested.length === 1 ? requested[0] : null;
  return {
    intent: operation?.intent || null,
    negated: requested.some((row) => row.negated),
    ambiguous,
    operation,
    ...(saveStart !== null ? { sameAppointmentSave: true } : {}),
    sourceWithoutCommand: operation
      ? text.slice(0, operation.start) +
        ' ' +
        text.slice(operation.end, saveStart === null ? undefined : saveStart)
      : text,
  };
}
module.exports = { detectRequestedOperation };
