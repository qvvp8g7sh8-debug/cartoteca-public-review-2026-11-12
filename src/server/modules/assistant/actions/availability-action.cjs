const { readSteps } = require('../read-steps.cjs');
const { matchesName } = require('../language/names/name-matching.cjs');
const { appointmentContext, resolveService } = require('./availability-context.cjs');
const { findAvailability } = require('./availability.cjs');
function availabilityAction(c, intent, clock) {
  return readSteps(function* () {
    const context = yield appointmentContext(c);
    let staff = context.members;
    if (intent.staffQuery) {
      staff = staff.filter((member) => matchesName(member, intent.staffQuery, true));
      if (staff.length !== 1)
        return {
          text: 'Повторите запрос о свободном времени целиком: укажите полное имя доступного специалиста, нужный период и длительность окна.',
          action: null,
        };
    }
    let selected = [];
    if (intent.serviceQuery) {
      selected = resolveService(
        context.services.filter((service) =>
          staff.some((member) => member.accountId === service.staffId),
        ),
        intent.serviceQuery,
      );
      if (selected.length !== 1)
        return {
          text: 'Повторите запрос о свободном времени целиком: укажите точное название услуги, полное имя специалиста и нужный период. По неоднозначной услуге я не буду угадывать длительность.',
          action: null,
        };
      staff = staff.filter((member) => member.accountId === selected[0].staffId);
    }
    if (!staff.length)
      return { text: 'Нет доступного специалиста для поиска свободного времени.', action: null };
    const duration = intent.duration || selected[0]?.duration || 30;
    if (selected.length && intent.duration && intent.duration !== selected[0].duration)
      return {
        text: 'Указанная длительность отличается от каталога услуги. Повторите полный запрос с нужной длительностью без услуги либо с длительностью выбранной услуги.',
        action: null,
      };
    const result = yield findAvailability(c, {
      from: intent.date || clock.date,
      to: intent.endDate || intent.date || clock.date,
      ...(intent.time ? { time: intent.time } : {}),
      ...(intent.endTime ? { endTime: intent.endTime } : {}),
      duration,
      staffIds: staff.map((member) => member.accountId),
      ...(selected.length ? { serviceIds: selected.map((service) => service.id) } : {}),
    });
    return {
      text: result.slots.length
        ? 'Найдены свободные окна на ' +
          duration +
          ' мин. Выберите время: это предложение, время ещё не зарезервировано. Запись сохраните вручную в форме.'
        : 'Подходящие окна на ' +
          duration +
          ' мин. не найдены в указанном периоде.' +
          (result.availability.scheduleIncomplete
            ? ' Для части дней ещё не задан рабочий график.'
            : ''),
      action: null,
      ...result,
    };
  }).call(this);
}
module.exports = { availabilityAction };
