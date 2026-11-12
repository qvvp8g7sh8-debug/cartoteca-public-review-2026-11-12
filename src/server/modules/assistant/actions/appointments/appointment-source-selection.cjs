const { dayEvidence } = require('../../dialogue/bare-day-proposal.cjs');
const { serviceMatches } = require('../../language/services/service-matching.cjs');
const {
  servicePartialIdentityMatches,
  serviceDescriptionMatches,
} = require('../../language/services/service-partial-search.cjs');
const { matchesName } = require('../../language/names/name-matching.cjs');
const { windowBounds } = require('../../language/time/booking-time-window.cjs');
const fold = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
const unsafe = /(?:^|[\s,;])(?:не|нет|или|либо|если|кроме|исключая|примерно|около)(?=$|[\s,;.!?])/u;
const months = [
  'январ(?:ь|я|е)',
  'феврал(?:ь|я|е)',
  'март(?:а|е)?',
  'апрел(?:ь|я|е)',
  'ма(?:й|я|е)',
  'июн(?:ь|я|е)',
  'июл(?:ь|я|е)',
  'август(?:а|е)?',
  'сентябр(?:ь|я|е)',
  'октябр(?:ь|я|е)',
  'ноябр(?:ь|я|е)',
  'декабр(?:ь|я|е)',
];
function sourceDayOperation(entry, raw) {
  const text = fold(raw),
    m = entry.data.management;
  if (m.sourceYearRequired && m.sourceDay && m.sourceMonth) {
    const year = /^(?:в )?(\d{4})(?: год(?:у|а)?)?$/u.exec(text);
    if (year && Number(year[1]) > 0)
      return { kind: 'sourceMonth', month: m.sourceMonth, year: year[1] };
  }
  if (m.sourceDay || m.sourceDate) {
    for (let index = 0; index < months.length; index++) {
      const match = new RegExp(
        '^(?:(?:в|во) )?(' + months[index] + ')(?: (\\d{4})(?: года?)?)?$',
        'u',
      ).exec(text);
      if (match) return { kind: 'sourceMonth', month: index + 1, year: match[2] || null };
    }
  }
  if (/^\d{1,2}$/u.test(text) && Number(text) >= 1 && Number(text) <= entry.options.size)
    return null;
  const evidence = dayEvidence(text, { dateStep: true });
  return evidence?.whole ? { kind: 'sourceDay', day: evidence.day } : null;
}
function sourceServiceQuery(raw) {
  const text = fold(raw);
  if (!text || text.length > 160 || unsafe.test(text)) return null;
  const query = text
    .replace(
      /^(?:(?:ту|той)(?: запись| записи)?[, ]+(?:что|которая) |запись )?(?:на |с услугой )/u,
      '',
    )
    .replace(/^(?:услуга|услугу|процедура|процедуру)\s*[:=-]?\s*/u, '')
    .trim();
  if (
    !query ||
    !/\p{L}/u.test(query) ||
    /[;!?]/u.test(query) ||
    /(?:^|\s)(?:запиши|создай|перенеси|отмени|измени|открой|сохрани|завтра|сегодня|послезавтра|дату|время|числа)(?=$|\s)/u.test(
      query,
    )
  )
    return null;
  return query;
}
function sourceStaffQuery(raw) {
  const text = fold(raw);
  if (text.length > 160 || unsafe.test(text)) return null;
  const match =
    /^(?:у(?: (?:специалиста|сотрудника|врача|мастера))?|специалист|сотрудник|врач|мастер)\s+([\p{L}]+(?:[-'’][\p{L}]+)*(?:\s+[\p{L}]+(?:[-'’][\p{L}]+)*){0,3})$/u.exec(
      text,
    );
  return match ? match[1] : null;
}
function sourceServices(row) {
  return [
    ...new Set(
      [row.service, ...(row.serviceItems || []).map((item) => item.name)].filter(
        (name) => typeof name === 'string' && name.trim(),
      ),
    ),
  ];
}
function fitsSourceWindow(row, window) {
  if (!window) return true;
  const bounds = windowBounds(window);
  if (!bounds) return false;
  const minutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const duration = Number(row.duration || 60);
  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    row.time >= bounds.time &&
    minutes(row.time) + duration <= minutes(bounds.endTime)
  );
}
function filterSourceAppointments(rows, management, context) {
  return rows.filter(
    (row) =>
      (!management.sourceDate || row.date === management.sourceDate) &&
      (!management.sourceTime || row.time === management.sourceTime) &&
      fitsSourceWindow(row, management.sourceWindow) &&
      (!management.sourceDay || Number(row.date.slice(8)) === management.sourceDay) &&
      (!management.sourceMonth || Number(row.date.slice(5, 7)) === management.sourceMonth) &&
      (!management.sourceYear || row.date.slice(0, 4) === management.sourceYear) &&
      (!management.sourceServiceQuery ||
        sourceServices(row).some(
          (name) =>
            serviceMatches(name, management.sourceServiceQuery) ||
            servicePartialIdentityMatches(name, management.sourceServiceQuery) ||
            serviceDescriptionMatches(name, management.sourceServiceQuery),
        )) &&
      (!management.staffQuery ||
        context?.members.some(
          (member) =>
            member.accountId === (row.staffId || context.ownerId) &&
            matchesName(member, management.staffQuery, true),
        )),
  );
}
function sourcePrompt(rows, management) {
  if (management.sourceDay && new Set(rows.map((row) => row.date.slice(0, 7))).size > 1)
    return new Set(rows.map((row) => row.date.slice(5, 7))).size > 1
      ? 'В каком месяце запись?'
      : 'В каком году запись?';
  if (rows.length > 1 && new Set(rows.map((row) => row.date)).size === 1)
    return 'Во сколько запись?';
  return rows.length > 12
    ? 'На какую дату запись?'
    : rows.length === 1
      ? 'Эту запись?'
      : 'Какую запись?';
}
module.exports = {
  sourceDayOperation,
  sourceServiceQuery,
  sourceStaffQuery,
  filterSourceAppointments,
  sourcePrompt,
};
