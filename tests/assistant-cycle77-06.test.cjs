const test = require('node:test');
const assert = require('node:assert/strict');
const {
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const {
  pendingMonthAnswer,
} = require('../src/server/modules/assistant/dialogue/pending-month-answer.cjs');
const clock = { date: '2099-01-05', hour: 8, minute: 0 };
const entry = () => ({
  step: 'date',
  options: new Map(),
  data: { dateProposal: { day: 29, date: '2099-01-29' }, time: '16:00', clientQuery: 'Анна' },
});
for (const raw of ['В ноябре И услуга Пилинг', 'Услуга Пилинг И В ноябре'])
  test('month and another field are independent of ASR letter case: ' + raw, () => {
    const e = entry();
    const op = continuationOperation(
      continuationExample({ operation: 'patch', fields: { service: 'Пилинг' } }),
      { text: raw },
      e,
      clock,
    );
    assert.equal(op.kind, 'modelPatch');
    assert.equal(op.constraints.date, null);
    assert.equal(op.constraints.dateProposal.date, '2099-11-29');
    assert.ok(op.edits.every((r) => r.field !== 'date'));
    assert.ok(op.edits.some((r) => r.field === 'service' && r.text === 'Пилинг'));
    assert.equal(e.data.time, '16:00');
  });
test('capitalized alternatives and conditions do not complete a month', () => {
  for (const raw of ['В ноябре ИЛИ декабре И услуга Пилинг', 'ЕСЛИ в ноябре И услуга Пилинг'])
    assert.equal(pendingMonthAnswer(entry(), raw, clock), null);
});
