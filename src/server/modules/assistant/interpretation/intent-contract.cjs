// One vocabulary for the application normalizer and constrained provider output.
// Provider structure never replaces semantic validation or action authorization.
const intentNames = Object.freeze([
  'help',
  'calendar',
  'clients',
  'clientCard',
  'availability',
  'prepareAppointment',
  'moveAppointment',
  'cancelAppointment',
  'editAppointment',
]);
// Executable conditions for each action; the provider envelope remains flat and nullable.
const commandFields = Object.freeze({
  help: Object.freeze([]),
  calendar: Object.freeze(['date', 'mode', 'staffQuery']),
  clients: Object.freeze(['query']),
  clientCard: Object.freeze(['query']),
  availability: Object.freeze([
    'date',
    'endDate',
    'time',
    'endTime',
    'staffQuery',
    'serviceQuery',
    'duration',
  ]),
  moveAppointment: Object.freeze(['query', 'date', 'time', 'staffQuery', 'serviceQuery']),
  cancelAppointment: Object.freeze(['query', 'date', 'time', 'staffQuery', 'serviceQuery']),
  editAppointment: Object.freeze(['query', 'date', 'time', 'staffQuery', 'serviceQuery']),
  prepareAppointment: Object.freeze([
    'query',
    'date',
    'time',
    'staffQuery',
    'serviceQuery',
    'duration',
  ]),
});
const properties = {
  intent: { type: 'string', enum: intentNames },
  query: { type: ['string', 'null'], maxLength: 160 },
  date: {
    type: ['string', 'null'],
    maxLength: 10,
    pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
  },
  endDate: {
    type: ['string', 'null'],
    maxLength: 10,
    pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
  },
  time: { type: ['string', 'null'], maxLength: 5, pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
  endTime: { type: ['string', 'null'], maxLength: 5, pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
  mode: { type: ['string', 'null'], enum: ['day', 'week', 'month', null] },
  staffQuery: { type: ['string', 'null'], maxLength: 160 },
  serviceQuery: { type: ['string', 'null'], maxLength: 160 },
  duration: { type: ['integer', 'null'], minimum: 5, maximum: 1440, multipleOf: 5 },
};
const intentFields = Object.freeze(Object.keys(properties));
const providerSchema = {
  type: 'object',
  additionalProperties: false,
  properties,
  // Structured output requires every field; unknown/irrelevant fields use null.
  required: intentFields,
};
// Wire examples expand only already validated local expectations. Model input still
// goes through normalizeIntent and validateCommandFields, never this projection.
function intentEnvelope(value) {
  return Object.fromEntries(
    intentFields.map((field) => [field, value[field] === '' ? null : (value[field] ?? null)]),
  );
}
module.exports = { intentNames, intentFields, providerSchema, commandFields, intentEnvelope };
