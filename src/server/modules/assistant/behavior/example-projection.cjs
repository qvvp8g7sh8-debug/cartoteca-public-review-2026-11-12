const { validDate } = require('../interpretation/intent-schema.cjs');
const { shiftDate } = require('../language/time/temporal.cjs');
const excludedCaseIds = new Set([
  'period-part-of-day',
  'period-time-window',
  'period-upcoming-only',
  'period-today-time',
  'avail-cancellations',
  // The current initial wire represents a target, not both source and target dates.
  'constraint-reschedule',
  // A video-permission marker is not a legal-consent registry, and the current
  // search/card command cannot represent comparison of two client records.
  'card-consents',
  'card-merge-read',
  // Neither archived-only lookup nor negated multi-command replacement is
  // represented by the current initial contract. Keep historical research only.
  'identity-archived',
  'correction-new-vs-old',
]);
const legacyCardExamples = {
  'name-instrumental-female': ['Найди карточку с Анной Ивановой', 'Анной Ивановой'],
  'name-genitive-male': ['Найди карточку Сергея Иванова', 'Сергея Иванова'],
  'name-prepositional-male': ['Найди карточку о Сергее Иванове', 'Сергее Иванове'],
};
// Exact historical corrections are shared by retrieval and its administrative
// explanation. The author corpus/history is never rewritten by this projection.
function currentIntentForCase(item) {
  const current = item.current?.intent;
  if (!validDate(item.referenceDate) || !current) return current;
  const card = legacyCardExamples[item.id];
  if (
    card &&
    item.text === card[0] &&
    current.intent === 'clients' &&
    current.query === card[1] &&
    Object.keys(current).length === 2
  )
    return { intent: 'clientCard', query: current.query };
  if (current.intent !== 'help') return current;
  if (
    item.id === 'constraint-cancel-existing' &&
    item.text === 'Отмени завтрашнюю запись Анны Ивановой'
  )
    return {
      intent: 'cancelAppointment',
      query: 'Анны Ивановой',
      date: shiftDate(item.referenceDate, 1),
    };
  if (
    item.id === 'constraint-no-auto-save' &&
    item.text === 'Запиши Анну Иванову завтра в 14:00 и сразу сохрани'
  )
    return {
      intent: 'prepareAppointment',
      query: 'Анну Иванову',
      date: shiftDate(item.referenceDate, 1),
      time: '14:00',
    };
  return current;
}
module.exports = { currentIntentForCase, excludedCaseIds };
