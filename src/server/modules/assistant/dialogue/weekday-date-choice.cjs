const { validDate } = require('../interpretation/intent-schema.cjs');
const { shiftDate } = require('../language/time/temporal.cjs');

const nextDay = [
  'следующее воскресенье',
  'следующий понедельник',
  'следующий вторник',
  'следующую среду',
  'следующий четверг',
  'следующую пятницу',
  'следующую субботу',
];

function weekdayDateView(date, clock) {
  if (!validDate(date) || date !== clock.date) return null;
  const next = shiftDate(date, 7);
  if (!validDate(next)) return null;
  const weekday = nextDay[new Date(date + 'T00:00:00Z').getUTCDay()];
  return {
    step: 'date',
    prompt: 'На сегодня или на ' + weekday + '?',
    input: { type: 'date', field: 'date' },
    choices: [
      { kind: 'date', value: date, label: 'На сегодня' },
      { kind: 'date', value: next, label: 'На ' + weekday },
    ],
  };
}

function shortWeekdayChoice(entry, text, clock) {
  if (!clock || !(entry.options instanceof Map)) return null;
  const next = weekdayDateView(entry.data?.dateWeekday, clock)?.choices[1];
  if (!next) return null;
  // The abbreviated answer uses the form of the adjective in the offered day.
  const [, word] = next.label.toLowerCase().split(' ');
  if (text !== word && text !== 'на ' + word) return null;
  const matching = [...entry.options].filter(
    ([, choice]) =>
      choice.kind === next.kind && choice.value === next.value && choice.label === next.label,
  );
  return matching.length === 1 ? { kind: 'choice', choice: matching[0][0] } : null;
}

module.exports = { weekdayDateView, shortWeekdayChoice };
