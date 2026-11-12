const {
  normalizeIntent,
  validateCommandFields,
} = require('../../interpretation/intent-schema.cjs');
const { continuationExample } = require('./continuation-contract.cjs');
const { continuationOperation } = require('./continuation-operation.cjs');

// Approved initial examples are never pasted into a followup. Re-run the pure
// source/temporal guards against their own dated context, with no database/IDs.
function customContinuationRows(policy, context) {
  if (policy.commands?.prepareAppointment !== true) return [];
  return (policy.examples || [])
    .filter((row) => row.enabled)
    .flatMap((row) => {
      try {
        const value = validateCommandFields(normalizeIntent(row.expected));
        if (value.intent !== 'prepareAppointment') return [];
        const fields = Object.fromEntries(
          [
            ['client', value.query],
            ['staff', value.staffQuery],
            ['service', value.serviceQuery],
            ['date', value.date],
            ['time', value.time],
            ['duration', value.duration],
          ].filter(([, item]) => item !== undefined && item !== ''),
        );
        if (!Object.keys(fields).length) return [];
        const [hour, minute] = (row.referenceTime || '09:00').split(':').map(Number);
        const entry = {
          step: context.step,
          options: new Map(),
          data: {
            date: context.selected?.date,
            time: context.selected?.time,
          },
        };
        const proposal = continuationExample({ operation: 'patch', fields });
        const operation = continuationOperation(proposal, { text: row.text }, entry, {
          date: row.referenceDate,
          hour,
          minute,
        });
        if (operation.kind !== 'modelPatch' || !operation.edits.length) return [];
        // A partial/negative proposal is not an approved equivalent adaptation.
        if (
          Object.entries(fields).some(
            ([field, text]) =>
              !operation.edits.some((edit) => edit.field === field && edit.text === String(text)),
          )
        )
          return [];
        return [
          {
            id: row.id,
            step: '*',
            text: row.text,
            referenceDate: row.referenceDate,
            referenceTime: row.referenceTime,
            operation: 'patch',
            fields,
            source: 'custom-adapted',
          },
        ];
      } catch (error) {
        if ([400, 409, 502].includes(error.status)) return [];
        throw error;
      }
    });
}
module.exports = { customContinuationRows };
