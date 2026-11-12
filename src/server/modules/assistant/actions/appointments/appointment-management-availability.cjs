const { readSteps } = require('../../read-steps.cjs');
const {
  findAppointmentMoveAvailability,
  verifyAppointmentMoveAvailability,
} = require('../availability.cjs');
const { confirmationMatches } = require('./schedule-override.cjs');
const { freeRangeView } = require('../free-range-view.cjs');
const { targetWindowBounds } = require('./appointment-management-repair.cjs');
function managementRangeView(c, entry, source, reason = '') {
  return readSteps(function* () {
    const m = entry.data.management;
    const info = (yield findAppointmentMoveAvailability(
      c,
      {
        duration: source.duration,
        staffIds: [source.staffId],
        from: m.targetDate,
        to: m.targetDate,
        strategy: 'day',
        ...targetWindowBounds(m),
      },
      m.source,
    )).availability.dayInfo;
    const requested = {
      date: m.targetDate,
      time: m.requestedTime,
      staffId: source.staffId,
      duration: source.duration,
    };
    if (
      !reason &&
      m.rangeReason &&
      m.requestedTime &&
      !(yield verifyAppointmentMoveAvailability(
        c,
        {
          ...requested,
          ...(confirmationMatches(c, m.closedConfirmation, requested)
            ? { allowClosedDay: true }
            : {}),
        },
        m.source,
      ))
    )
      reason = m.rangeReason;
    const view = freeRangeView(info, {
      duration: source.duration,
      question: 'На какое время перенести?',
      emptyDay: false,
      offset: m.rangeOffset || 0,
    });
    return {
      ...view,
      prompt: (reason ? reason + ' ' : '') + view.prompt,
      choices: view.choices.map((row) => ({ ...row, kind: 'managementRange' })),
      controls: view.controls.map((row) => ({
        ...row,
        kind: row.kind === 'moreRanges' ? 'managementMoreRanges' : 'managementOtherDate',
      })),
    };
  }).call(this);
}
function managementNearestView(c, entry, source, reason = '') {
  return readSteps(function* () {
    const m = entry.data.management;
    const slot = (yield findAppointmentMoveAvailability(
      c,
      {
        duration: source.duration,
        staffIds: [source.staffId],
        from: m.targetDate,
        to: m.targetDate,
        strategy: 'representative',
        ...targetWindowBounds(m),
        preferredTime:
          m.nearestRequested === 'earliest' ? '00:00' : m.requestedTime || source.appointment.time,
        limit: 1,
        shownSlots:
          m.rejectedTargetDate === m.targetDate
            ? (m.rejectedTargetTimes || []).map((time) => ({
                date: m.targetDate,
                time,
                staffId: source.staffId,
              }))
            : [],
      },
      m.source,
    )).slots[0];
    if (!slot) return yield managementRangeView(c, entry, source, reason);
    return {
      step: 'time',
      phase: 'slots',
      prompt: (reason ? reason + ' ' : '') + 'Свободно в ' + slot.time + '. Подойдёт?',
      choices: [
        {
          kind: 'managementTarget',
          value: { date: slot.date, time: slot.time },
          label: slot.time + '–' + slot.endTime,
        },
      ],
    };
  }).call(this);
}
module.exports = { managementRangeView, managementNearestView };
