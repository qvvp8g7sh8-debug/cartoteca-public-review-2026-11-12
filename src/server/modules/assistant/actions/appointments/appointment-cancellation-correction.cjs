const { managementDateOperation } = require('./appointment-management-date.cjs');
const { repairOperation } = require('../../dialogue/dialogue-repair-parse.cjs');
const { sourceServiceQuery, sourceStaffQuery } = require('./appointment-source-selection.cjs');
const { sourceFilterComposition } = require('./appointment-management-entities.cjs');
const {
  managementTemporalReplacement,
  managementSourceReplacement,
} = require('./appointment-management-replacement.cjs');
const {
  bookingTemporalConstraints,
} = require('../../language/time/booking-temporal-constraints.cjs');
function cancellationSourceCorrection(entry, raw, clock, source) {
  const sourceReplacement = managementSourceReplacement(entry, raw, source, clock);
  if (sourceReplacement) return sourceReplacement;
  const replacement = managementTemporalReplacement(raw, clock);
  if (replacement) {
    const constraints = bookingTemporalConstraints(
      { intent: 'prepareAppointment' },
      replacement,
      clock,
    );
    return {
      kind: 'sourceFilters',
      edits: ['date', 'time']
        .filter((field) => constraints[field])
        .map((field) => ({ field, text: constraints[field] })),
      constraints,
    };
  }
  const match = /^нет[,\s]+(.+)$/iu.exec(raw.trim().replace(/[.!?…]+$/u, ''));
  if (!match) return null;
  const text = match[1].replace(/^запись\s+/iu, '').trim();
  const emptyEdit = /^(?:поменяй|измени|исправь)\s+(дату|время)$/iu.exec(text);
  if (emptyEdit)
    return { kind: emptyEdit[1].toLowerCase() === 'дату' ? 'sourceEditDate' : 'sourceEditTime' };
  if (
    /(?:^|[\s,;])(?:нет|не|или|либо|если|и|отмени|отменить|перенеси|перенести|создай|создать|удали|удалить|запиши|записать|сохрани|сохранить|отправь|отправить|поменяй|измени)(?=$|[\s,;.!?])/iu.test(
      text,
    )
  )
    return null;
  const composite = sourceFilterComposition(text, clock, true);
  if (composite) return composite;
  const staff = sourceStaffQuery(text);
  if (staff) return { kind: 'sourceStaff', query: staff };
  const virtual = {
    ...entry,
    step: 'appointment',
    data: { ...entry.data, management: { ...entry.data.management, source: null } },
    response: { dialogue: { phase: 'appointmentChoice' } },
    options: new Map(),
  };
  const date = managementDateOperation(virtual, text, clock, null);
  if (date) return date;
  const parsed = repairOperation(virtual, text, clock);
  if (parsed?.kind === 'edit' && parsed.field === 'date') return { kind: 'sourceEditDate' };
  if ((parsed?.kind === 'edit' && parsed.field === 'time') || parsed?.kind === 'rejectTime')
    return { kind: 'sourceEditTime' };
  if (parsed?.kind === 'patch' && parsed.edits.every((row) => ['date', 'time'].includes(row.field)))
    return { kind: 'sourceFilter', edits: parsed.edits };
  if (parsed?.kind === 'patch' && parsed.edits.length === 1 && parsed.edits[0].field === 'service')
    return { kind: 'sourceService', query: parsed.edits[0].text };
  const query = !parsed ? sourceServiceQuery(text) : null;
  return query ? { kind: 'sourceService', query } : null;
}
module.exports = { cancellationSourceCorrection };
