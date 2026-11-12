const test = require('node:test');
const assert = require('node:assert/strict');
const { parseContinuation } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const fields = { client: null, staff: null, service: null, date: null, time: null, duration: null };
const proposal = (operation = 'repeat', patch = {}) => ({
  operation,
  fields: { ...fields },
  choice: null,
  field: null,
  ...patch,
});
test('continuation contract rejects unknown actions identifiers partial records and semantically incompatible fields', () => {
  const invalid = [
    { ...proposal(), patientId: 'invented' },
    proposal('save'),
    proposal('autosave'),
    proposal('patch', { fields: { ...fields, clientId: 'invented' } }),
    proposal('patch', { fields: { ...fields, date: '2099-02-30' } }),
    proposal('patch', { fields: { ...fields, duration: 17 } }),
    proposal('patch', { fields: { ...fields, duration: 1.5 } }),
    proposal('patch', { fields: { ...fields, time: '25:30' } }),
    proposal('choice', { choice: 2, fields: { ...fields, client: 'Анна' } }),
    proposal('repeat', { field: 'client' }),
    proposal('patch'),
    { operation: 'cancel' },
    'not JSON',
  ];
  for (const value of invalid) assert.throws(() => parseContinuation(value), { status: 502 });
});
test('continuation contract accepts only explicit complete records and preserves the quoted name ending', () => {
  const value = proposal('patch', {
    fields: {
      ...fields,
      client: 'Ольгу Семёнову',
      date: '2099-01-05',
      time: '14:30',
      duration: 80,
    },
  });
  assert.deepEqual(parseContinuation(JSON.stringify(value)), value);
  assert.deepEqual(
    parseContinuation(proposal('choice', { choice: 2 })),
    proposal('choice', { choice: 2 }),
  );
});
