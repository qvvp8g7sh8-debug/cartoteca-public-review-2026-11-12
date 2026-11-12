const { fail } = require('../../../../shared/errors.cjs');
const { isAffirmativeAnswer } = require('./affirmative-answer.cjs');
const { boundedText } = require('../interpretation/intent-schema.cjs');
const { fields, selectedFields } = require('./dialogue-options.cjs');
const { isSlotRequest } = require('../actions/slot-request.cjs');
const ordinalWords = [
  ['первый', 'первого', 'первую', 'один', 'одна'],
  ['второй', 'второго', 'вторую', 'два', 'две'],
  ['третий', 'третьего', 'третью', 'три'],
  ['четвертый', 'четвертого', 'четвертую', 'четыре'],
  ['пятый', 'пятого', 'пятую', 'пять'],
  ['шестой', 'шестого', 'шестую', 'шесть'],
  ['седьмой', 'седьмого', 'седьмую', 'семь'],
  ['восьмой', 'восьмого', 'восьмую', 'восемь'],
  ['девятый', 'девятого', 'девятую', 'девять'],
  ['десятый', 'десятого', 'десятую', 'десять'],
  ['одиннадцатый', 'одиннадцатого', 'одиннадцать'],
  ['двенадцатый', 'двенадцатого', 'двенадцать'],
];
const editFields = {
  клиента: 'client',
  клиент: 'client',
  специалиста: 'staff',
  специалист: 'staff',
  врача: 'staff',
  врач: 'staff',
  услугу: 'service',
  услуга: 'service',
  дату: 'date',
  дата: 'date',
  время: 'time',
  длительность: 'duration',
  продолжительность: 'duration',
};
function speechOperation(entry, value) {
  const text = boundedText(value, 160, 'ответ для записи')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.!?]+$/u, '')
    .replace(/^пожалуйста[,\s]+/u, '')
    .trim();
  if (
    /^(?:отмена|отмени(?:ть)?(?:\s+подготовку(?:\s+записи)?)?|отменить\s+подготовку|стоп|не надо)$/u.test(
      text,
    )
  )
    return { kind: 'cancel' };
  if (/^(?:назад|вернись|шаг назад)$/u.test(text)) {
    const selected = new Set(selectedFields(entry.data).map((row) => row.key));
    const position = fields.indexOf(entry.step);
    const field = fields
      .slice(0, position < 0 ? fields.length : position)
      .reverse()
      .find((key) => selected.has(key));
    if (!field)
      throw fail(400, 'Предыдущего заполненного поля нет. Назовите поле, которое нужно изменить.');
    return { kind: 'edit', field };
  }
  const edit = text.match(
    /^(?:поменяй|измени|исправь|изменить|поменять)\s+(клиента|клиент|специалиста|специалист|врача|врач|услугу|услуга|дату|дата|время|длительность|продолжительность)(?:\s+на\s+(.+))?$/u,
  );
  if (edit)
    return { kind: 'edit', field: editFields[edit[1]], ...(edit[2] ? { text: edit[2] } : {}) };
  if (
    isAffirmativeAnswer(value) ||
    /^(?:подтверждаю(?:\s+данные)?|все верно|верно|открой(?:\s+форму(?:\s+записи)?)?|открывай\s+форму|подготовь\s+форму(?:\s+записи)?)$/u.test(
      text,
    )
  ) {
    const choice = [...entry.options].find(([, row]) => row.kind === 'ready');
    if (entry.step !== 'review' || !choice)
      throw fail(
        400,
        'Сначала уточним данные записи. Назовите ответ или номер предложенного варианта.',
      );
    return { kind: 'choice', choice: choice[0] };
  }
  const ordinal = text.match(
    /^(?:(?:выбери|выбираю|беру|давай)\s+)?(?:(?:вариант|окно)\s+(?:номер\s+)?)?([а-я]+|\d{1,2})(?:\s+(?:вариант|окно|окошко))?$/u,
  );
  if (ordinal) {
    const index = /^\d+$/.test(ordinal[1])
      ? Number(ordinal[1]) - 1
      : ordinalWords.findIndex((words) => words.includes(ordinal[1]));
    if (index >= 0 && entry.options.size) {
      const choice = [...entry.options.keys()][index];
      if (!choice) {
        if (entry.step === 'time' && /^\d+$/.test(text)) return { kind: 'text', text: value };
        throw fail(400, 'Такого номера нет. Назовите номер из текущих вариантов.');
      }
      return { kind: 'choice', choice };
    }
  }
  if (isSlotRequest(text))
    return {
      kind: 'slots',
      ...(/^(?:в\s+)?любое\s+(?:время|окно)$/u.test(text) ? { anyTime: true } : {}),
    };
  return { kind: 'text', text: value };
}
module.exports = { speechOperation };
