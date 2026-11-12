const { validAppointmentTime } = require('../../../../../shared/appointment-time.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const { minutes } = require('../../../../../shared/work-schedule.cjs');
const { readSteps } = require('../../read-steps.cjs');
function unavailableExecutionTime(message) {
  return Object.assign(fail(409, message), { code: 'ASSISTANT_TIME_UNAVAILABLE' });
}
function invalidBookingTime(data) {
  return Boolean(data.time && !validAppointmentTime(data.time));
}
const nearestGridSlot = readSteps(function* nearestGridSlot(requested, verify) {
  const point = minutes(requested);
  if (!Number.isFinite(point) || point % 5 === 0) return null;
  const earlier = Math.floor(point / 5) * 5;
  const later = earlier + 5;
  const neighbors = point - earlier <= later - point ? [earlier, later] : [later, earlier];
  for (const minute of neighbors) {
    if (minute >= 1440) continue;
    const time =
      String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
    const slot = yield verify(time);
    if (slot) return slot;
  }
  return null;
});
function timeStepPrompt(requested, slot, move = false) {
  const understood = Number.isFinite(minutes(requested)) ? 'Вы назвали ' + requested + '. ' : '';
  const question = slot
    ? 'Ближайшее свободное время — ' + slot.time + '. Подойдёт?'
    : understood
      ? 'Назовите другое время или дату.'
      : 'Во сколько ' + (move ? 'перенести?' : 'записать?');
  return understood + 'Начало приёма — с шагом 5 минут. ' + question;
}
function timeStepView(requested, slot) {
  return {
    step: 'time',
    phase: 'slots',
    prompt: timeStepPrompt(requested, slot),
    input: { type: 'text', field: 'time' },
    choices: slot ? [{ kind: 'slot', value: slot, label: slot.time + '–' + slot.endTime }] : [],
    controls: [{ kind: 'otherDate', label: 'Другая дата' }],
  };
}
module.exports = {
  invalidBookingTime,
  nearestGridSlot,
  timeStepPrompt,
  timeStepView,
  unavailableExecutionTime,
};
