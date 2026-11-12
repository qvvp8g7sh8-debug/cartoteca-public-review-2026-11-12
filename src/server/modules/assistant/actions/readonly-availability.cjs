const { validDate } = require('../interpretation/intent-schema.cjs');
const dates = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
function spokenDate(value) {
  if (!validDate(value)) return '';
  const parts = Object.fromEntries(
    dates.formatToParts(new Date(value + 'T12:00:00Z')).map((part) => [part.type, part.value]),
  );
  return parts.day + ' ' + parts.month + ' ' + parts.year + ' года';
}
function readOnlyAvailabilityText(result) {
  const first = result.slots[0];
  const duration = result.availability?.duration || first.duration;
  const from = spokenDate(result.availability?.from || first.date);
  const to = spokenDate(result.availability?.to || result.availability?.from || first.date);
  const period =
    from && to && from !== to
      ? 'Период: с ' + from + ' по ' + to + '.'
      : from
        ? 'Дата: ' + from + '.'
        : '';
  const length =
    Number.isSafeInteger(duration) && duration >= 5 && duration <= 1440 && duration % 5 === 0
      ? ' на ' + duration + ' мин'
      : '';
  return [
    'Найдены свободные окна' + length + '.',
    period,
    'Доступен только просмотр. Чтобы записать клиента, откройте календарь. Окна не резервируются.',
  ]
    .filter(Boolean)
    .join(' ');
}
module.exports = { readOnlyAvailabilityText };
