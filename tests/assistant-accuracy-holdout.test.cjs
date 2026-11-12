const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAccuracy, corpus } = require('./helpers/assistant-accuracy-eval.cjs');

test('independent offline Russian transcripts check local intent fields, canonical actions, dialogue preservation and manual save', async (t) => {
  const report = await evaluateAccuracy();
  t.diagnostic(
    JSON.stringify({ ...report, library: undefined, observations: undefined, failures: undefined }),
  );
  assert.equal(report.localRouting.cases, corpus.initial.length);
  assert.equal(
    report.dialogues.cases,
    corpus.dialogues.reduce((sum, row) => sum + row.turns.length, 0),
  );
  assert.equal(report.manualSave.changedClinicalData, 0);
  assert.equal(report.manualSave.executionTickets, 0);
  assert.equal(report.localRouting.falsePositive, 0);
  assert.equal(report.passed, true, JSON.stringify(report.failures, null, 2));
});
