const { randomUUID } = require('node:crypto');
const { nextDate, validDate } = require('../../../../../shared/work-schedule.cjs');
const { patientFullName } = require('../../../../../shared/patient-names.cjs');
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
function spokenDate(date, clock) {
  if (date === clock.date) return 'сегодня';
  if (date === nextDate(clock.date)) return 'завтра';
  const [year, month, day] = date.split('-');
  return (
    Number(day) +
    ' ' +
    months[Number(month) - 1] +
    (year === clock.date.slice(0, 4) ? '' : ' ' + year + ' года')
  );
}
function appointmentLabel(appointment, clock) {
  return (
    spokenDate(appointment.date, clock) +
    ' в ' +
    appointment.time +
    (appointment.service ? ' · ' + appointment.service.slice(0, 70) : '')
  );
}
function managementResponse(entry, { step, prompt, choices = [], controls = [], phase }, source) {
  entry.step = step;
  entry.options = new Map();
  entry.controls = new Map();
  const options = choices.map((choice) => {
    const id = randomUUID();
    entry.options.set(id, choice);
    return { id, label: choice.label };
  });
  const controlOptions = controls.map((control) => {
    const id = randomUUID();
    entry.controls.set(id, control);
    return { id, label: control.label };
  });
  const fields = [{ key: 'client', label: 'Клиент', value: entry.data.patient.label }];
  if (source)
    fields.push(
      {
        key: 'service',
        label: 'Услуга',
        value:
          source.appointment.service ||
          (source.appointment.serviceItems || []).map((item) => item.name).join(', ') ||
          'Без услуги',
      },
      { key: 'duration', label: 'Длительность', value: source.duration + ' мин' },
    );
  const m = entry.data.management || {};
  if (['move', 'edit', 'cancel'].includes(m.operation)) {
    const cancelling = m.operation !== 'move';
    const date = cancelling
      ? source?.appointment.date
      : !m.dateRequired && !m.dateProposal
        ? m.targetDate
        : null;
    const time = cancelling ? source?.appointment.time : !m.timeRequired ? m.targetTime : null;
    if (validDate(date))
      fields.push({ key: 'date', label: cancelling ? 'Дата записи' : 'Новая дата', value: date });
    if (typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(time))
      fields.push({ key: 'time', label: cancelling ? 'Время записи' : 'Новое время', value: time });
  }
  return {
    text: prompt,
    action: null,
    dialogue: {
      id: entry.id,
      version: entry.version,
      step,
      prompt,
      ...(phase ? { phase } : {}),
      options,
      ...(controlOptions.length ? { controls: controlOptions } : {}),
      fields,
      canEdit: [],
      input: { type: 'text', field: step },
      expiresAt: entry.expiresAt,
    },
  };
}
function managementResult(c, entry, source, clock, slot) {
  const m = entry.data.management;
  const name = patientFullName(source.patient) || source.patient.designation || 'Клиент';
  const date = slot?.date || source.appointment.date,
    time = slot?.time || source.appointment.time;
  const executeCancel =
    m.operation === 'cancel' && m.executionEnabled === true && Boolean(m.cancelConfirmed);
  const executeMove =
    m.operation === 'move' &&
    m.executionEnabled === true &&
    Boolean(m.movePreparation) &&
    Boolean(slot);
  const text =
    (m.operation === 'cancel'
      ? 'Подготовил отмену записи: '
      : m.operation === 'move'
        ? 'Подготовил перенос записи: '
        : 'Открываю запись: ') +
    name +
    ', ' +
    spokenDate(date, clock) +
    ' в ' +
    time +
    '.';
  c.assertCurrent();
  entry.complete = true;
  return {
    text: executeCancel ? 'Отменяю запись.' : executeMove ? 'Переношу запись.' : text,
    dialogue: null,
    action: executeCancel
      ? { type: 'cancelAppointment', executionId: entry.id }
      : executeMove
        ? { type: 'moveAppointment', executionId: entry.id }
        : {
            type: 'appointmentPreview',
            operation: m.operation,
            ...m.source,
            ...(slot
              ? {
                  date: slot.date,
                  time: slot.time,
                  ...(slot.roomId ? { roomId: slot.roomId } : {}),
                }
              : {}),
          },
  };
}
module.exports = { spokenDate, appointmentLabel, managementResponse, managementResult };
