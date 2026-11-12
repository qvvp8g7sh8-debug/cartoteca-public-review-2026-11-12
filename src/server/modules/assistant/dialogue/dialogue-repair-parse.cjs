const { containsCardCommand } = require('../interpretation/client-card-grammar.cjs');
const { normalizeClockPrefixes, bareClockSpans } = require('../language/time/clock-context.cjs');
const { boundedText } = require('../interpretation/intent-schema.cjs');
const { parseDuration } = require('./dialogue-input.cjs');
const { spokenNumber } = require('../language/time/spoken-number.cjs');
const { ordinalOperation } = require('./dialogue-repair-choice.cjs');
const { clientCorrectionQuery, isClientCorrectionQuery } = require('./client-correction.cjs');
const { bookingTemporalConstraints } = require('../language/time/booking-temporal-constraints.cjs');
const { continuationSourceScope } = require('./continuation/continuation-source-scope.cjs');
const {
  ambiguous,
  help,
  patch,
  temporalEdits,
  namedOperation,
  splitCorrections,
} = require('./dialogue-repair-values.cjs');
const repairPrefix =
  /^(?:(?:нет|не так|лучше|точнее|точней|вернее|на самом деле|давай|вместо этого)[,\s:]+)+/u;
const actionPrefix =
  /^(?:сдвинь|сдвинуть|перенеси|перенести|передвинь|передвинуть)(?:\s+(?:запись|время|дату))?\s+/u;
function relativeOperation(text) {
  const source = text
    .replace(actionPrefix, '')
    .replace(
      /^(?:(?:поменяй|измени|исправь)\s+)?(?:время|дату|дату\s+записи)\s+(?:на\s+)?/u,
      'на ',
    );
  const time = source.match(/^(?:на\s+)?(.+?)\s+(позже|позднее|раньше|ранее)$/u);
  if (/^(?:днем|сутками)\s+позже$/u.test(source)) return { kind: 'shiftDate', days: 1 };
  if (/^(?:днем|сутками)\s+раньше$/u.test(source)) return { kind: 'shiftDate', days: -1 };
  if (time) {
    const day = time[1].match(/^(?:(.+?)\s+)?(?:день|дня|дней)$/u);
    if (day) {
      const count = day[1] ? spokenNumber(day[1], 31) : 1;
      return count > 0
        ? { kind: 'shiftDate', days: count * (/ран/u.test(time[2]) ? -1 : 1) }
        : help('Назовите сдвиг даты от одного до 31 дня.');
    }
    const minutes = parseDuration(time[1]);
    return minutes
      ? { kind: 'shiftTime', minutes: minutes * (/ран/u.test(time[2]) ? -1 : 1) }
      : help('Уточните сдвиг времени, например «на полчаса позже» или «на 15 минут раньше».');
  }
  if (
    /^(?:на\s+)?(?:следующий|следующую)\s+(?:день|дату)$/u.test(source) ||
    /^(?:днем|сутками)\s+позже$/u.test(source)
  )
    return { kind: 'shiftDate', days: 1 };
  if (
    /^(?:на\s+)?(?:предыдущий|предыдущую)\s+(?:день|дату)$/u.test(source) ||
    /^(?:днем|сутками)\s+раньше$/u.test(source)
  )
    return { kind: 'shiftDate', days: -1 };
  if (/(?:^|\s)(?:позже|раньше|позднее|ранее|попозже|пораньше)(?=$|\s)/u.test(source))
    return help('На сколько перенести? Например «на полчаса позже» или «на следующий день».');
  return null;
}
function structuralOperation(text, entry) {
  if (entry.step === 'review' && /^(?:запиши|записать)(?:\s+запись)?$/u.test(text)) {
    const ready = [...entry.options].find(([, row]) => row.kind === 'ready');
    if (ready) return { kind: 'choice', choice: ready[0] };
  }
  if (
    /^(?:отмена|отмени(?:ть)?(?:\s+(?:подготовку|черновик)(?:\s+записи)?)?|отмени\s+запись|стоп|не надо|закончим|заверши\s+диалог)$/u.test(
      text,
    )
  )
    return { kind: 'cancel' };
  if (
    /^(?:помощь|помоги|что\s+(?:можно|ты\s+умеешь)|как\s+(?:исправить|поменять|ответить)|не\s+понял[аи]?)$/u.test(
      text,
    )
  )
    return help(
      'Можно изменить клиента, услугу, дату или время. Или скажите «передумал», чтобы остановить подготовку.',
    );
  if (
    /^(?:сохрани|сохранить|запиши|записать|удали|удалить|отправь|отправить|оплати|оплатить|выполни|запусти)(?=$|\s)/u.test(
      text,
    )
  )
    return help(
      'Эта команда недоступна на текущем шаге. Можно изменить данные или сказать «передумал».',
    );
  if (
    containsCardCommand(text) ||
    /^(?:(?:покажи|открой|найди|посмотри)\s+(?:мне\s+)?(?:расписание|календарь|клиента|клиентов)|новая\s+(?:команда|задача|запись)|начни\s+заново)(?=$|\s)/u.test(
      text,
    )
  )
    return help(
      'Это другая задача. Сначала завершите или отмените текущую подготовку и нажмите «Новая команда». Данные записи пока не изменены.',
    );
  return null;
}
function rejectedTimeOperation(text, entry) {
  if (
    /^(?:(?:это|выбранное|предложенное)\s+)?время\s+(?:мне\s+)?не\s+подходит(?:\s+мне)?$/u.test(
      text,
    ) ||
    /^(?:(?:покажи|предложи|подбери|найди|давай|хочу|выбери)\s+)?(?:другое|другие|иное|иные)\s+(?:время|окно|окна)$/u.test(
      text,
    ) ||
    (entry.step === 'time' && /^(?:мне\s+)?не\s+подходит$/u.test(text))
  )
    return { kind: 'rejectTime' };
  return null;
}
function repairOperation(entry, value, clock, { futureMonth = false } = {}) {
  futureMonth = futureMonth && !entry.availabilitySearch;
  const source = boundedText(value, 160, 'ответ для записи')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/gu, ' ')
    .replace(/[.!?]+$/u, '');
  const raw = source.replace(/^пожалуйста[,\s]+/u, '').trim();
  if (!raw) return null;
  const preserved = continuationSourceScope(raw);
  if (preserved.protectedFields.size) {
    const remainder = preserved.text.replace(/^[\s,;.!?]+|[\s,;.!?]+$/gu, '');
    if (!remainder) return help('Данные сохранены. Что изменить?');
    const parsed = repairOperation(entry, remainder, clock, { futureMonth });
    if (parsed?.kind === 'patch') {
      if (parsed.timeWindow && preserved.protectedFields.has('time'))
        return help('Время просили сохранить. Уточните изменение.');
      const conflicting = parsed.edits.some(
        (edit) =>
          preserved.protectedFields.has(edit.field) &&
          String(entry.data[edit.field] ?? '') !== edit.text,
      );
      if (conflicting) return help('Это поле просили сохранить. Уточните изменение.');
      parsed.edits = parsed.edits.filter((edit) => !preserved.protectedFields.has(edit.field));
      if (!parsed.edits.length) return help('Данные сохранены. Что изменить?');
    }
    const changed =
      parsed?.kind === 'patch'
        ? parsed.edits.map((edit) => edit.field)
        : parsed?.kind === 'edit'
          ? [parsed.field]
          : parsed?.kind === 'shiftTime'
            ? ['time']
            : parsed?.kind === 'shiftDate'
              ? ['date']
              : [];
    return changed.some((field) => preserved.protectedFields.has(field))
      ? help('Это поле просили сохранить. Уточните изменение.')
      : parsed;
  }
  const structural = structuralOperation(raw, entry);
  if (structural) return structural;
  const text = raw
    .replace(repairPrefix, '')
    .replace(/[,\s]+пожалуйста$/u, '')
    .trim();
  if (!text) return help();
  const correctedStructural = structuralOperation(text, entry);
  if (correctedStructural) return correctedStructural;
  const clientCorrection =
    entry.step === 'client' || /(?:^|\s)клиента?(?=$|[\s,])/u.test(raw)
      ? clientCorrectionQuery(raw, { allowBareCorrection: entry.step === 'client' })
      : null;
  if (clientCorrection)
    return clientCorrection.query
      ? patch([{ field: 'client', text: clientCorrection.query }])
      : { kind: 'edit', field: 'client' };
  const rejected = rejectedTimeOperation(text, entry);
  if (rejected) return rejected;
  if (ambiguous.test(text))
    return help(
      'Слышу отрицание или несколько возможных значений. Назовите окончательный вариант; данные записи пока не изменены.',
    );
  // A whole booking command with a leading date is not a single-field repair.
  if (/(?:^|\s)(?:запиши|записать)(?=$|\s)/u.test(text)) return null;
  const parts = splitCorrections(text);
  if (parts.length > 1) {
    const edits = [];
    let seekSlots = false;
    let timeWindow = null;
    for (const part of parts) {
      const parsed = namedOperation(part, clock, { futureMonth });
      if (parsed?.kind !== 'patch')
        return help(
          'Назовите точные значения каждого исправления. Пока данные записи не изменены.',
        );
      edits.push(...parsed.edits);
      seekSlots ||= parsed.seekSlots === true;
      if (parsed.timeWindow) {
        if (timeWindow) return help('Назовите один период поиска. Пока данные не изменены.');
        timeWindow = parsed.timeWindow;
      }
    }
    if (new Set(edits.map((edit) => edit.field)).size !== edits.length)
      return help('Для одного поля указано несколько значений. Назовите окончательный вариант.');
    if ((seekSlots || timeWindow) && edits.some((edit) => edit.field === 'time'))
      return help(
        'Выберите точное время или подбор свободного окна. Пока данные записи не изменены.',
      );
    return {
      ...patch(edits),
      ...(seekSlots ? { seekSlots: true } : {}),
      ...(timeWindow ? { timeWindow } : {}),
    };
  }
  const relative = relativeOperation(text);
  if (relative) return relative;
  const named = namedOperation(text, clock, { futureMonth });
  if (named) {
    // Preserve complete named multi-field/replacement grammar, but leave a
    // temporal tail inside one client value to model-owned atomic extraction.
    if (named.kind === 'patch')
      for (const edit of named.edits) {
        if (edit.field === 'client' && !isClientCorrectionQuery(edit.text)) return null;
        if (['service', 'staff'].includes(edit.field)) {
          let proof;
          try {
            proof = bookingTemporalConstraints({ intent: 'prepareAppointment' }, edit.text, clock);
          } catch (error) {
            if (error.status !== 400) throw error;
            return null;
          }
          if (Object.keys(proof).length) return null;
        }
      }
    return named;
  }
  if (entry.step === 'duration' && (/\d[.,]\d/u.test(text) || source !== text)) {
    const minutes = parseDuration(text);
    if (minutes) return patch([{ field: 'duration', text: String(minutes) }]);
  }
  const choice = ordinalOperation(entry, text);
  if (choice) return choice;
  const labelled =
    /^(?:прием|процедура|услуга|запись)\s+(?:длится|длиться|продолжается)\s+(?:на\s+)?(.+)$/u.exec(
      text,
    );
  const duration = labelled || text.match(/^на\s*(.+)$/u);
  const clockValue = normalizeClockPrefixes(text);
  const wholeClock = bareClockSpans(clockValue, { timeContext: true }).some(
    (span) => span.start === 0 && span.end === clockValue.length,
  );
  if (
    duration &&
    /(?:мин|час)/u.test(duration[1]) &&
    (labelled || entry.step === 'duration' || !wholeClock)
  ) {
    const minutes = parseDuration(duration[1]);
    return minutes
      ? patch([{ field: 'duration', text: String(minutes) }])
      : help('Назовите точную длительность, например «на час» или «на 15 минут».');
  }
  const allowTime =
    entry.step === 'time' ||
    raw !== text ||
    /^(?:в|на)\s+/u.test(text) ||
    /\d{1,2}[:.]\d{2}/u.test(text);
  const temporal = temporalEdits(
    clockValue.replace(actionPrefix, ''),
    clock,
    allowTime || wholeClock,
    { timeContext: entry.step === 'time', futureMonth },
  );
  if (temporal) return temporal;
  if (repairPrefix.test(raw) && ['client', 'staff', 'service'].includes(entry.step)) {
    const command =
      /^(?:поменяй|измени|исправь|замени|перенеси|сдвинь|покажи|открой|найди|посмотри|включи|выключи|создай|добавь|выйди|удали|сохрани|запусти|выполни|отмени|отправь|оплати|обнови|закрой|закончи|верни|расскажи|переключи|назад|вернись|шаг|да|подтверждаю|верно|через|после|до|в|на)(?=$|\s)/u;
    if (!command.test(text) && /^[а-яa-z\d +()'’.-]+$/u.test(text))
      return patch([{ field: entry.step, text }]);
    return help();
  }
  if (
    repairPrefix.test(raw) ||
    /^(?:поменяй|измени|исправь|замени|перенеси|сдвинь)(?=$|\s)/u.test(text)
  )
    return help();
  return null;
}
module.exports = { repairOperation, relativeOperation };
