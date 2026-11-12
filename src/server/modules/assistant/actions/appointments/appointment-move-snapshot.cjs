const { readSteps } = require('../../read-steps.cjs');
const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../../../../shared/errors.cjs');
const { unavailableExecutionTime } = require('./appointment-time-input.cjs');
const { patientFullName } = require('../../../../../shared/patient-names.cjs');
const { clientChoiceMetadata } = require('../../dialogue/client-choice-names.cjs');
const { managementSource } = require('./appointment-management-references.cjs');
const { verifyAppointmentMoveAvailability } = require('../availability.cjs');
const { spokenDate } = require('./appointment-management-view.cjs');
const { validDate, minutes } = require('../../../../../shared/work-schedule.cjs');
const { confirmationMatches } = require('./schedule-override.cjs');
function moveClosedDayAllowed(c, management, source) {
  return confirmationMatches(c, management.closedConfirmation, {
    date: management.targetDate,
    time: management.targetTime,
    duration: source.duration,
    staffId: source.staffId,
  });
}
function targetTuple(slot) {
  return {
    date: slot.date,
    time: slot.time,
    duration: slot.duration,
    staffId: slot.staffId,
    roomId: slot.roomId || '',
  };
}
function assertMoveBinding(c, entry, prepared, now) {
  return readSteps(function* () {
    const m = entry.data.management;
    if (
      !prepared ||
      m?.operation !== 'move' ||
      m.executionEnabled !== true ||
      !isDeepStrictEqual(m.source, prepared.source) ||
      m.targetDate !== prepared.target.date ||
      m.targetTime !== prepared.target.time ||
      (m.closedConfirmation || '') !== prepared.closedConfirmation
    )
      throw fail(409, 'Подготовленный перенос изменился. Уточните запись ещё раз.');
    const source = yield managementSource(c, prepared.source, now);
    if (
      !isDeepStrictEqual(source.appointment, prepared.appointment) ||
      clientChoiceMetadata(source.patient).clientNameStamp !== prepared.patientStamp ||
      (c.assistantReads
        ? yield c.assistantReads.timeZone()
        : c.platform.organizationTimeZone(c.current.organizationId)) !== prepared.timeZone ||
      (c.assistantReads
        ? yield c.assistantReads.revision()
        : c.tenantStore(c.current.organizationId).get('revision', 0)) !== prepared.revision
    )
      throw fail(409, 'Запись или клиент изменились. Уточните перенос ещё раз.');
    return source;
  }).call(this);
}
function bindMovePreparation(c, entry, source, slot, clock) {
  return readSteps(function* () {
    const m = entry.data.management,
      target = targetTuple(slot);
    if (
      m.operation !== 'move' ||
      m.executionEnabled !== true ||
      target.date !== m.targetDate ||
      target.time !== m.targetTime ||
      target.staffId !== source.staffId ||
      target.duration !== source.duration ||
      !validDate(target.date) ||
      !Number.isFinite(minutes(target.time))
    )
      throw fail(409, 'Выберите актуальное время переноса.');
    if (m.movePreparation) {
      yield assertMoveBinding(c, entry, m.movePreparation, Date.now());
      if (!isDeepStrictEqual(m.movePreparation.target, target))
        throw unavailableExecutionTime('Время или кабинет изменились. Выберите перенос ещё раз.');
      return;
    }
    const name = patientFullName(source.patient) || source.patient.designation || 'Клиент';
    m.movePreparation = {
      source: structuredClone(m.source),
      appointment: structuredClone(source.appointment),
      target,
      patientStamp: clientChoiceMetadata(source.patient).clientNameStamp,
      revision: c.assistantReads
        ? yield c.assistantReads.revision()
        : c.tenantStore(c.current.organizationId).get('revision', 0),
      timeZone: c.assistantReads
        ? yield c.assistantReads.timeZone()
        : c.platform.organizationTimeZone(c.current.organizationId),
      closedConfirmation: m.closedConfirmation || '',
      description: name + ', ' + spokenDate(target.date, clock) + ' в ' + target.time,
    };
  }).call(this);
}
function verifyPreparedMove(c, entry, prepared, source, now) {
  return readSteps(function* () {
    const storage = c.tenantStore(c.current.organizationId);
    // A move keeps historical services byte-for-byte and supplies no serviceIds.
    // The fixed empty projection avoids a standalone catalog transaction in writer.
    const selected = { ...storage, readServices: () => [] };
    const scoped = {
      ...c,
      tenantStore(org) {
        if (org !== c.current.organizationId) throw fail(403, 'Организация изменилась.');
        return selected;
      },
    };
    const allowClosedDay = moveClosedDayAllowed(c, entry.data.management, source);
    const slot = yield verifyAppointmentMoveAvailability(
      scoped,
      {
        ...prepared.target,
        ...(allowClosedDay ? { allowClosedDay: true } : {}),
      },
      prepared.source,
      now,
    );
    if (!slot || !isDeepStrictEqual(targetTuple(slot), prepared.target))
      throw unavailableExecutionTime(
        'Это время или кабинет уже недоступны. Выберите другое время переноса.',
      );
    return { slot, allowClosedDay };
  }).call(this);
}
function moveExecutionSnapshot(c, entry, now) {
  return readSteps(function* () {
    c.assertCurrent();
    const prepared = entry.data.management?.movePreparation;
    const source = yield assertMoveBinding(c, entry, prepared, now);
    const { allowClosedDay } = yield verifyPreparedMove(c, entry, prepared, source, now);
    return {
      data: structuredClone(entry.data),
      previous: structuredClone(source.appointment),
      appointment: {
        ...structuredClone(source.appointment),
        date: prepared.target.date,
        time: prepared.target.time,
        roomId: prepared.target.roomId,
      },
      revision: prepared.revision,
      staffId: source.staffId,
      allowClosedDay,
      text: 'Перенёс запись: ' + prepared.description + '.',
    };
  }).call(this);
}
function assertMoveExecutionSnapshot(c, entry, captured, now) {
  return readSteps(function* () {
    c.assertCurrent();
    if (!isDeepStrictEqual(entry.data, captured.data))
      throw fail(409, 'Подготовленный перенос изменился.');
    const prepared = entry.data.management.movePreparation;
    const source = yield assertMoveBinding(c, entry, prepared, now);
    if (!isDeepStrictEqual(source.appointment, captured.previous))
      throw fail(409, 'Исходная запись уже изменилась.');
    const { allowClosedDay } = yield verifyPreparedMove(c, entry, prepared, source, now);
    if (allowClosedDay !== captured.allowClosedDay)
      throw fail(409, 'Подтверждение дня изменилось.');
    c.assertCurrent();
  }).call(this);
}
module.exports = { bindMovePreparation, moveExecutionSnapshot, assertMoveExecutionSnapshot };
