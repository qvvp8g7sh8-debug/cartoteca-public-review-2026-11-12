const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeContinuationContext,
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const {
  pendingMonthAnswer,
} = require('../src/server/modules/assistant/dialogue/pending-month-answer.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-20', hour: 8, minute: 0 };
function entry() {
  return {
    step: 'date',
    options: new Map(),
    data: {
      dateProposal: { day: 29, date: '2026-10-29' },
      dateMonthContext: undefined,
      patient: { id: 'hidden' },
      clientQuery: 'Анна',
      serviceChosen: true,
      serviceQuery: 'Чистка',
      duration: 30,
      time: '16:00',
    },
  };
}
test('pending date context distinguishes a proposed month and omits patient identities', () => {
  const context = safeContinuationContext(entry(), 'owner', clock);
  assert.deepEqual(context.dateClarification, {
    day: 29,
    proposedDate: '2026-10-29',
    confirmedMonth: null,
    stage: 'monthConfirmation',
  });
  assert.ok(!JSON.stringify(context).includes('hidden'));
  assert.ok(context.missingFields.includes('date'));
});
for (const raw of ['В ноябре, услугу поменяй на Пилинг', 'Услугу поменяй на Пилинг, в ноябре'])
  test(
    'a whole month clause completes the pending day while preserving a second model patch: ' + raw,
    () => {
      const e = entry();
      const proposal = continuationExample({ operation: 'patch', fields: { service: 'Пилинг' } });
      const op = continuationOperation(proposal, { text: raw }, e, clock);
      assert.equal(op.kind, 'modelPatch');
      assert.ok(op.edits.some((row) => row.field === 'date' && row.text === '2026-11-29'));
      assert.ok(op.edits.some((row) => row.field === 'service' && row.text === 'Пилинг'));
      assert.equal(e.data.time, '16:00');
      assert.equal(e.data.dateProposal.date, '2026-10-29');
    },
  );
test('the model cannot invent a different day in a month-only reply', () => {
  assert.throws(
    () =>
      continuationOperation(
        continuationExample({
          operation: 'patch',
          fields: { service: 'Пилинг', date: '2026-11-28' },
        }),
        { text: 'В ноябре, услугу поменяй на Пилинг' },
        entry(),
        clock,
      ),
    { status: 400 },
  );
});
for (const raw of [
  'В ноябре или декабре, услуга Пилинг',
  'В ноябре, в декабре, услуга Пилинг',
  'Если в ноябре, услуга Пилинг',
])
  test('ambiguous month clauses cannot fill a pending date: ' + raw, () => {
    assert.equal(pendingMonthAnswer(entry(), raw, clock), null);
  });
test('month completion follows existing year-boundary semantics without guessing a different day', () => {
  const e = entry();
  e.data.dateProposal = { day: 5, date: null };
  assert.equal(
    pendingMonthAnswer(e, 'В январе, услуга Пилинг', { ...clock, date: '2026-12-20' }).date,
    '2027-01-05',
  );
});
test('month plus service reaches the same actual draft with its known client and clock', () => {
  const f = dialogueFixture();
  f.services.push({ id: 'peel', name: 'Пилинг', duration: 30, staffId: 'owner' });
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '16:00' }, { date: null });
  f.answer({ text: 'на двадцать девятое' });
  const body = {
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    text: 'В ноябре, услугу поменяй на Пилинг',
  };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  assert.equal(snapshot.context.dateClarification.day, 29);
  f.flow.applyModelTurn(
    f.c,
    body,
    f.state,
    f.member,
    f.clock,
    continuationExample({ operation: 'patch', fields: { service: 'Пилинг' } }),
    snapshot,
  );
  const data = f.flow.get(f.c, f.member, f.state, body.dialogueId).data;
  assert.equal(data.date, null);
  assert.equal(data.dateProposal.date, '2099-11-29');
  assert.equal(data.time, '16:00');
  assert.equal(data.patient.id, f.patients[0].id);
  assert.equal(data.service.id, 'peel');
  assert.equal(f.patients[0].appointments.length, 0);
});
