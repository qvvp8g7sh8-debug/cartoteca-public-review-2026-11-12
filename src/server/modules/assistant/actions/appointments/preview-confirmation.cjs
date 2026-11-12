const { nextDate } = require('../../../../../shared/work-schedule.cjs');
const months = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
function previewConfirmation(data, slot, clock, actor) {
  // The label has already been refreshed from the ACL-scoped directory, not the model.
  const name = data.patient.label.replace(/\s·\s…\d{1,4}$/u, '');
  const [year, month, day] = slot.date.split('-');
  const date =
    slot.date === clock.date
      ? 'сегодня'
      : slot.date === nextDate(clock.date)
        ? 'завтра'
        : Number(day) +
          ' ' +
          months[Number(month) - 1] +
          (year === clock.date.slice(0, 4) ? '' : ' ' + year + ' года');
  const performer =
    actor.role === 'salon_admin' || slot.staffId !== actor.accountId
      ? '; специалист ' + data.staff.label
      : '';
  return 'Подготовил запись: ' + name + ', ' + date + ' в ' + slot.time + performer + '.';
}
module.exports = { previewConfirmation };
