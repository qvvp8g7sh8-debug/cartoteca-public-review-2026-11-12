const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../../../../shared/errors.cjs');
const { allowsClosedDay } = require('../../dialogue/dialogue-booking-time.cjs');
const {
  executionSnapshot,
  assertExecutionSnapshot,
} = require('./appointment-execution-snapshot.cjs');
const {
  cancellationExecutionSnapshot,
  assertCancellationExecutionSnapshot,
} = require('./appointment-cancellation-snapshot.cjs');
const {
  moveExecutionSnapshot,
  assertMoveExecutionSnapshot,
} = require('./appointment-move-snapshot.cjs');
function executionKind(entry) {
  if (!entry.complete || entry.cancelled || entry.response?.action?.executionId !== entry.id)
    throw fail(409, 'Действие ещё не готово к выполнению.');
  if (
    !entry.data.target &&
    entry.data.createRequested === true &&
    entry.response.action.type === 'createAppointment'
  )
    return 'create';
  const m = entry.data.management;
  if (
    entry.data.target === 'appointmentManagement' &&
    m?.operation === 'move' &&
    m.executionEnabled === true &&
    m.movePreparation &&
    entry.response.action.type === 'moveAppointment'
  )
    return 'move';
  if (
    entry.data.target === 'appointmentManagement' &&
    m?.operation === 'cancel' &&
    m.executionEnabled === true &&
    m.cancelConfirmation &&
    isDeepStrictEqual(m.cancelConfirmed, m.cancelConfirmation.binding) &&
    entry.response.action.type === 'cancelAppointment'
  )
    return 'cancel';
  throw fail(409, 'Действие ещё не готово к выполнению.');
}
function prepareExecution(c, entry, now) {
  const kind = executionKind(entry);
  const captured =
    kind === 'cancel'
      ? cancellationExecutionSnapshot(c, entry, now)
      : kind === 'move'
        ? moveExecutionSnapshot(c, entry, now)
        : executionSnapshot(c, entry, now);
  let acknowledgement = '';
  if (kind === 'create' || kind === 'move') {
    const check = c.platform.workSchedules.check(c.token, captured.appointment);
    if (
      check.warning &&
      (!(kind === 'move' ? captured.allowClosedDay : allowsClosedDay(c, captured.data)) ||
        !check.canOverride ||
        typeof check.acknowledgement !== 'string' ||
        !check.acknowledgement)
    )
      throw fail(412, 'Время вне рабочего графика. Подтвердите запись.');
    acknowledgement = check.warning ? check.acknowledgement : '';
  }
  return {
    kind,
    captured,
    acknowledgement,
    body: {
      revision: captured.revision,
      patientId: captured.data.patient.id,
      changes: [
        {
          id: captured.appointment.id,
          before: kind === 'create' ? null : captured.previous,
          after: captured.appointment,
        },
      ],
    },
  };
}
function assertPreparedExecution(c, entry, prepared, now) {
  if (executionKind(entry) !== prepared.kind) throw fail(409, 'Действие изменилось.');
  if (prepared.kind === 'cancel')
    assertCancellationExecutionSnapshot(c, entry, prepared.captured, now);
  else if (prepared.kind === 'move') assertMoveExecutionSnapshot(c, entry, prepared.captured, now);
  else assertExecutionSnapshot(c, entry, prepared.captured, now);
}
function replayExecution(id, version, kind) {
  return {
    saved: true,
    alreadySaved: true,
    ...(kind === 'move'
      ? { moved: true, operation: 'move', appointmentId: null }
      : kind === 'cancel'
        ? { cancelled: true, operation: 'cancel', appointmentId: null }
        : { appointmentId: 'a' + id }),
    text:
      kind === 'move'
        ? 'Запись уже перенесена.'
        : kind === 'cancel'
          ? 'Запись уже отменена.'
          : 'Запись уже сохранена.',
    action: null,
    policyVersion: version,
  };
}
module.exports = { executionKind, prepareExecution, assertPreparedExecution, replayExecution };
