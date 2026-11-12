// Plural appointments retain their date-tail disambiguation from individual edits.
const calendarPluralTarget = '(?:записи|при[её]мы)';
const calendarViewTarget = '(?:(?:мо[её]\\s+)?расписание|(?:мой\\s+)?календарь)';
const calendarReadTarget = '(?:' + calendarPluralTarget + '|' + calendarViewTarget + ')';
module.exports = { calendarPluralTarget, calendarViewTarget, calendarReadTarget };
