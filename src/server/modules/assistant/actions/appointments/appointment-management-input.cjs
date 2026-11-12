const { managementDateOperation } = require('./appointment-management-date.cjs');
const { boundedText } = require('../../interpretation/intent-schema.cjs');
const {
  isAffirmativeAnswer,
  isConfirmationAnswer,
} = require('../../dialogue/affirmative-answer.cjs');
const { repairOperation } = require('../../dialogue/dialogue-repair-parse.cjs');
const { applyRepair } = require('../../dialogue/dialogue-repair-apply.cjs');
const { managementRelativeProof } = require('./appointment-management-temporal.cjs');
const { isSlotRequest, nearestSlotMode } = require('../slot-request.cjs');
const { sourceServiceQuery, sourceStaffQuery } = require('./appointment-source-selection.cjs');
const { shiftDirection, shiftAmount } = require('./appointment-management-repair.cjs');
const { managementTargetOperation } = require('./appointment-management-target-input.cjs');
const { choiceTargetOperation } = require('./appointment-choice-target.cjs');
const { sourceFilterComposition } = require('./appointment-management-entities.cjs');
const { managementTemporalReplacement } = require('./appointment-management-replacement.cjs');
const { cancellationSourceCorrection } = require('./appointment-cancellation-correction.cjs');
function managementTextOperation(entry, raw, clock, source) {
  const value = boundedText(raw, 160, 'ответ для изменения записи').trim();
  const replacement = managementTemporalReplacement(value, clock);
  if (replacement) return managementTextOperation(entry, replacement, clock, source);
  const text = value
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[.!?…]+$/u, '')
    .trim();
  if (/^(?:отмена|стоп|не надо|отмени подготовку)$/u.test(text)) return { kind: 'cancel' };
  const selection = choiceTargetOperation(entry, value, clock);
  if (selection) return selection;
  if (!source && entry.step === 'appointment') {
    const correction = cancellationSourceCorrection(entry, value, clock);
    if (correction) return correction;
    const composite = sourceFilterComposition(
      value,
      clock,
      entry.data.management.operation !== 'move',
    );
    if (composite) return composite;
    const staff = sourceStaffQuery(value);
    if (staff)
      return /(?:^|[\s,;])(?:отмени|отменить|перенеси|перенести|создай|создать|удали|удалить|запиши|записать|сохрани|сохранить|отправь|отправить|поменяй|измени)(?=$|[\s,;.!?])/iu.test(
        value,
      )
        ? { kind: 'repeat' }
        : { kind: 'sourceStaff', query: staff };
  }
  const target = managementTargetOperation(entry, value, clock, Boolean(source));
  if (target) return target;
  if (
    /^(?:еще|другие)(?: свободные)? (?:промежутки|окна)$/u.test(text) ||
    /^(?:другая дата|другой день)$/u.test(text)
  ) {
    const kind = /^(?:другая дата|другой день)$/u.test(text)
      ? 'managementOtherDate'
      : 'managementMoreRanges';
    const control = [...(entry.controls || [])].find(([, row]) => row.kind === kind);
    if (control) return { kind: 'choice', choice: control[0] };
  }
  if (source && isSlotRequest(value))
    return { kind: 'rangeSearch', nearest: nearestSlotMode(value) };
  const amount = source ? shiftAmount(entry.data.management, value) : null;
  const relative = amount
    ? { relativeTarget: amount }
    : source
      ? managementRelativeProof({ query: '' }, value, clock)
      : {};
  if (relative.keepTime || relative.relativeTarget) {
    const m = entry.data.management;
    const preview = {
      data: {
        date: relative.date || m.targetDate || (relative.keepTime ? null : source.appointment.date),
        time: relative.keepTime
          ? source.appointment.time
          : m.targetTime || m.requestedTime || source.appointment.time,
        duration: source.duration,
        roomId: '',
      },
    };
    const applied = relative.keepTime ? {} : applyRepair(preview, relative.relativeTarget, clock);
    if (applied.message) return { kind: 'localHelp', field: 'time', text: applied.message };
    const changedTime = relative.keepTime || relative.relativeTarget.kind === 'shiftTime';
    if (relative.dateProposal)
      return {
        kind: 'dateMonthPropose',
        proposal: relative.dateProposal,
        time: changedTime ? preview.data.time : m.targetTime || null,
        changedTime,
      };
    return {
      kind: 'target',
      date: preview.data.date,
      time: changedTime ? preview.data.time : m.targetTime || m.requestedTime || null,
      changedDate: Boolean(relative.date || relative.relativeTarget?.kind === 'shiftDate'),
      changedTime,
    };
  }
  const date = managementDateOperation(entry, value, clock, source);
  if (date)
    return date.kind === 'edit' && date.field === 'date' ? { kind: 'targetEditDate' } : date;
  if (
    isAffirmativeAnswer(value) ||
    (entry.options.size === 1 &&
      ['managementClosedDay', 'managementTarget'].includes([...entry.options.values()][0].kind) &&
      isConfirmationAnswer(value, 'move'))
  )
    return { kind: 'acceptCurrent' };
  let parsed;
  try {
    parsed = repairOperation(entry, value, clock);
  } catch (error) {
    if (error.status !== 400) throw error;
  }
  if (parsed?.kind === 'choice') return parsed;
  if (!source && entry.step === 'appointment' && parsed?.kind === 'edit' && parsed.field === 'date')
    return { kind: 'sourceEditDate' };
  if (
    !source &&
    entry.step === 'appointment' &&
    ((parsed?.kind === 'edit' && parsed.field === 'time') || parsed?.kind === 'rejectTime')
  )
    return { kind: 'sourceEditTime' };
  if (
    source &&
    parsed?.kind === 'edit' &&
    parsed.field === 'date' &&
    entry.data.management.operation !== 'cancel'
  )
    return { kind: 'targetEditDate' };
  if (
    source &&
    parsed?.kind === 'edit' &&
    parsed.field === 'time' &&
    entry.data.management.operation !== 'cancel'
  )
    return { kind: 'targetEditTime' };
  if (source && parsed?.kind === 'localHelp')
    return { kind: 'managementHelp', text: parsed.text, direction: shiftDirection(value) };
  if (entry.step === 'appointment') {
    if (
      parsed?.kind === 'patch' &&
      parsed.edits.every((row) => ['date', 'time'].includes(row.field))
    )
      return parsed.seekSlots
        ? {
            kind: 'targetPatch',
            edits: parsed.edits,
            seekSlots: true,
            nearest: nearestSlotMode(value),
          }
        : { kind: 'sourceFilter', edits: parsed.edits };
    const query = !parsed ? sourceServiceQuery(value) : null;
    return query ? { kind: 'sourceService', query } : { kind: 'repeat' };
  }
  if (source && parsed?.kind === 'rejectTime') return { kind: 'managementRejectTime' };
  if (
    !parsed ||
    !['patch', 'shiftDate', 'shiftTime'].includes(parsed.kind) ||
    parsed.edits?.some((row) => !['date', 'time'].includes(row.field)) ||
    !source
  )
    return { kind: 'repeat' };
  const m = entry.data.management;
  const preview = {
    data: {
      date: m.targetDate || source.appointment.date,
      time: m.targetTime || m.requestedTime || source.appointment.time,
      duration: source.duration,
      roomId: '',
    },
  };
  if (applyRepair(preview, parsed, clock).message) return { kind: 'repeat' };
  return {
    kind: 'target',
    seekSlots: parsed.seekSlots === true,
    nearest: nearestSlotMode(value),
    date: preview.data.date,
    time:
      parsed.kind === 'shiftTime' || parsed.edits?.some((row) => row.field === 'time')
        ? preview.data.time
        : m.targetTime || m.requestedTime || null,
    changedDate:
      parsed.kind === 'shiftDate' || parsed.edits?.some((row) => row.field === 'date') === true,
    changedTime:
      parsed.kind === 'shiftTime' || parsed.edits?.some((row) => row.field === 'time') === true,
  };
}
module.exports = { managementTextOperation };
