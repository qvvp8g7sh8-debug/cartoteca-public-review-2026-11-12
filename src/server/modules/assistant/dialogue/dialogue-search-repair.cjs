const { parseDateText, parseTimeText, shiftDate } = require('../language/time/temporal.cjs');
const { parseDuration } = require('./dialogue-input.cjs');
const { validDate } = require('../interpretation/intent-schema.cjs');
const { windowBounds } = require('../language/time/booking-time-window.cjs');
const ask = (message) => ({ message });
const dayHelp = 'Назовите точную дату поиска. Для сдвига сначала задайте один выбранный день.';
const timeHelp =
  'Назовите точное время поиска или сначала выберите окно: пока нет однозначного времени для сдвига.';
function applySearchRepair(entry, input, clock) {
  const search = structuredClone(entry.availabilitySearch);
  if (!search || (!search.intent && !search.values))
    return ask('Начните поиск свободного времени заново.');
  if (input.kind === 'edit')
    return ask(
      'Назовите новое значение поля, например «поменяй дату на завтра» или «длительность на сорок пять минут».',
    );
  const intent = search.intent,
    values = search.values,
    current = intent || values;
  let edits = input.edits;
  if (input.kind === 'shiftDate') {
    const from = current.date || current.from,
      to = current.endDate || current.to || from;
    if (
      !validDate(from) ||
      to !== from ||
      !Number.isInteger(input.days) ||
      Math.abs(input.days) > 366
    )
      return ask(dayHelp);
    const date = shiftDate(from, input.days);
    if (!validDate(date) || date < clock.date) return ask(dayHelp);
    edits = [{ field: 'date', text: date }];
  } else if (input.kind === 'shiftTime') {
    const original = current.time;
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(original || '') ||
      !Number.isInteger(input.minutes) ||
      Math.abs(input.minutes) > 1440
    )
      return ask(timeHelp);
    const minutes = Number(original.slice(0, 2)) * 60 + Number(original.slice(3)) + input.minutes;
    if (minutes < 0 || minutes >= 1440 || minutes % 5)
      return ask('Сдвиг выходит за границы дня или шага пять минут. Назовите дату и точное время.');
    edits = [
      {
        field: 'time',
        text:
          String(Math.floor(minutes / 60)).padStart(2, '0') +
          ':' +
          String(minutes % 60).padStart(2, '0'),
      },
    ];
  }
  if (
    !Array.isArray(edits) ||
    !edits.length ||
    edits.length > 6 ||
    new Set(edits.map((row) => row.field)).size !== edits.length
  )
    return ask('Уточните одно новое значение для каждого изменяемого поля.');
  const order = ['staff', 'service', 'date', 'time', 'duration'];
  const bounds = Object.hasOwn(input, 'timeWindow') ? windowBounds(input.timeWindow) : null;
  if (
    Object.hasOwn(input, 'timeWindow') &&
    (!bounds || edits.some((edit) => edit.field === 'time'))
  )
    return ask('Уточните один период поиска без отдельного точного времени.');
  if (
    edits.some(
      (row) =>
        !order.includes(row.field) ||
        typeof row.text !== 'string' ||
        !row.text.trim() ||
        row.text.length > 160,
    )
  )
    return ask(
      'В поиске окон можно исправить специалиста, услугу, дату, время и длительность. Клиента уточним после выбора окна.',
    );
  for (const { field, text } of [...edits].sort(
    (a, b) => order.indexOf(a.field) - order.indexOf(b.field),
  )) {
    if (field === 'date') {
      const date = parseDateText(text, clock);
      if (!date || date < clock.date)
        return ask('Назовите одну сегодняшнюю или будущую дату поиска.');
      if (intent) {
        intent.date = date;
        intent.endDate = date;
      } else {
        values.from = date;
        values.to = date;
      }
    } else if (field === 'time') {
      const time = parseTimeText(text);
      if (!time)
        return ask(
          'Уточните одно точное время поиска с частью суток, например «в шестнадцать часов».',
        );
      current.time = time;
    } else if (field === 'duration') {
      const duration = parseDuration(text);
      if (!duration) return ask('Назовите длительность от пяти до 1440 минут с шагом пять минут.');
      current.duration = duration;
    } else if (!intent) {
      return ask('Для смены специалиста или услуги начните новый поиск с их названием.');
    } else if (field === 'staff') {
      intent.staffQuery = text.trim();
      delete intent.serviceQuery;
    } else intent.serviceQuery = text.trim();
  }
  if (bounds) Object.assign(current, bounds);
  else if (input.seekSlots === true) {
    delete current.time;
    delete current.endTime;
  }
  if (current.time && current.endTime && current.time >= current.endTime)
    return ask(
      'Новое начало не раньше прежней границы поиска. Назовите время внутри диапазона или начните новый поиск.',
    );
  entry.availabilitySearch = search;
  return ask('Условия поиска обновлены.');
}
module.exports = { applySearchRepair };
