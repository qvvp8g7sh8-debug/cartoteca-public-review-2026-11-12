const { readSteps } = require('../../read-steps.cjs');
const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../../../../shared/errors.cjs');
const { patientFullName } = require('../../../../../shared/patient-names.cjs');
const { clientChoiceMetadata } = require('../../dialogue/client-choice-names.cjs');
const { managementSource } = require('./appointment-management-references.cjs');
const { managementResponse, spokenDate } = require('./appointment-management-view.cjs');
function confirmationState(c, entry, source, clock) {
  return readSteps(function* () {
    const name = patientFullName(source.patient) || source.patient.designation || 'Клиент';
    return {
      binding: {
        source: structuredClone(entry.data.management.source),
        revision: c.assistantReads
          ? yield c.assistantReads.revision()
          : c.tenantStore(c.current.organizationId).get('revision', 0),
      },
      appointment: structuredClone(source.appointment),
      patientStamp: clientChoiceMetadata(source.patient).clientNameStamp,
      timeZone: c.assistantReads
        ? yield c.assistantReads.timeZone()
        : c.platform.organizationTimeZone(c.current.organizationId),
      description:
        name + ', ' + spokenDate(source.appointment.date, clock) + ' в ' + source.appointment.time,
    };
  }).call(this);
}
function assertConfirmation(c, entry, confirmation, now = Date.now()) {
  return readSteps(function* () {
    if (
      !confirmation ||
      !isDeepStrictEqual(entry.data.management.source, confirmation.binding?.source)
    )
      throw fail(409, 'Подтверждение относится к другой записи.');
    const source = yield managementSource(c, confirmation.binding.source, now);
    if (
      !isDeepStrictEqual(source.appointment, confirmation.appointment) ||
      clientChoiceMetadata(source.patient).clientNameStamp !== confirmation.patientStamp ||
      (c.assistantReads
        ? yield c.assistantReads.timeZone()
        : c.platform.organizationTimeZone(c.current.organizationId)) !== confirmation.timeZone ||
      (c.assistantReads
        ? yield c.assistantReads.revision()
        : c.tenantStore(c.current.organizationId).get('revision', 0)) !==
        confirmation.binding.revision
    )
      throw Object.assign(fail(409, 'Запись или клиент изменились. Подтвердите отмену заново.'), {
        code: 'ASSISTANT_CANCEL_CONFIRMATION_STALE',
      });
    return source;
  }).call(this);
}
function cancellationConfirmation(c, entry, source, clock) {
  return readSteps(function* () {
    const m = entry.data.management;
    if (!m.cancelConfirmation)
      m.cancelConfirmation = yield confirmationState(c, entry, source, clock);
    else yield assertConfirmation(c, entry, m.cancelConfirmation);
    return managementResponse(
      entry,
      {
        step: 'appointment',
        phase: 'cancelConfirmation',
        prompt:
          'Отменить ' +
          spokenDate(m.cancelConfirmation.appointment.date, clock) +
          ' в ' +
          m.cancelConfirmation.appointment.time +
          '?',
        choices: [
          {
            kind: 'managementCancelConfirm',
            value: structuredClone(m.cancelConfirmation.binding),
            label: 'Да, отменить',
          },
        ],
      },
      source,
    );
  }).call(this);
}
function confirmCancellation(c, entry, choice) {
  return readSteps(function* () {
    const m = entry.data.management;
    if (
      choice?.kind !== 'managementCancelConfirm' ||
      !isDeepStrictEqual(choice.value, m.cancelConfirmation?.binding)
    )
      throw fail(409, 'Подтверждение отмены устарело. Уточните запись.');
    yield assertConfirmation(c, entry, m.cancelConfirmation);
    m.cancelConfirmed = structuredClone(m.cancelConfirmation.binding);
  }).call(this);
}
function cancellationExecutionSnapshot(c, entry, now) {
  return readSteps(function* () {
    const m = entry.data.management;
    if (!isDeepStrictEqual(m.cancelConfirmed, m.cancelConfirmation?.binding))
      throw fail(409, 'Сначала подтвердите отмену этой записи.');
    const source = yield assertConfirmation(c, entry, m.cancelConfirmation, now);
    return {
      data: structuredClone(entry.data),
      previous: structuredClone(source.appointment),
      appointment: { ...structuredClone(source.appointment), status: 'cancelled' },
      revision: m.cancelConfirmation.binding.revision,
      text: 'Отменил запись: ' + m.cancelConfirmation.description + '.',
      staffId: source.staffId,
    };
  }).call(this);
}
function assertCancellationExecutionSnapshot(c, entry, captured, now) {
  return readSteps(function* () {
    if (!isDeepStrictEqual(entry.data, captured.data))
      throw fail(409, 'Подтверждение отмены изменилось.');
    const source = yield assertConfirmation(
      c,
      entry,
      entry.data.management.cancelConfirmation,
      now,
    );
    if (!isDeepStrictEqual(source.appointment, captured.previous))
      throw fail(409, 'Запись уже изменена.');
    c.assertCurrent();
  }).call(this);
}
module.exports = {
  cancellationConfirmation,
  confirmCancellation,
  cancellationExecutionSnapshot,
  assertCancellationExecutionSnapshot,
};
