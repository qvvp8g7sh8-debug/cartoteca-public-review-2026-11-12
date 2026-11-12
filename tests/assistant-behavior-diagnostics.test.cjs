const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDiagnosticSignal,
  diagnoseSignal,
} = require('../src/server/modules/assistant/behavior/behavior-diagnostics-schema.cjs');
const {
  createIncident,
  advanceIncident,
} = require('../src/server/modules/assistant/behavior/behavior-incident.cjs');
const codes = (value) => diagnoseSignal(value).gaps.map((item) => item.code);
const id = (n) => 'case-00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const hash = (letter = 'a') => letter.repeat(64);
test('malformed progress records fail closed with a bounded diagnostic error instead of a missing-state crash', () => {
  const reported = createIncident({ id: id(8), signal: { capabilityId: 'calendar' } });
  assert.throws(
    () =>
      advanceIncident(
        { ...reported, status: 'diagnosed' },
        { action: 'patch', kind: 'server', sourceStamp: hash() },
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      advanceIncident(
        { ...reported, gaps: Array(100).fill('evidence_missing') },
        { action: 'reproduce', caseId: id(9), fixtureStamp: hash() },
      ),
    { status: 400 },
  );
});
test('an incomplete request is expected clarification, not proof of lost context or a missing function', () => {
  const signal = {
    capabilityId: 'prepareAppointment',
    phase: 'time',
    fields: { missing: ['time'] },
  };
  assert.deepEqual(codes(signal), ['input_missing']);
  assert.equal(diagnoseSignal(signal).disposition, 'expected_clarification');
  assert.deepEqual(
    codes({ ...signal, fields: { before: ['time'], missing: ['date'] } }),
    ['input_missing'],
    'no after-state evidence means no loss claim',
  );
  assert.deepEqual(
    codes({
      ...signal,
      fields: { before: ['client', 'time'], after: ['client', 'time'], missing: ['date'] },
    }),
    ['input_missing'],
  );
});
test('context loss requires explicit server-selected before/after evidence and excludes intentional clearing', () => {
  const signal = {
    capabilityId: 'moveAppointment',
    phase: 'date',
    fields: { before: ['client', 'time'], after: ['client'], missing: ['date'] },
  };
  assert.ok(codes(signal).includes('context_lost'));
  assert.equal(diagnoseSignal(signal).disposition, 'defect');
  assert.deepEqual(codes({ ...signal, fields: { ...signal.fields, cleared: ['time'] } }), [
    'input_missing',
  ]);
});
test('unavailable data, recognition, contract, resolution, missing functions and policy constraints remain separate causes', () => {
  assert.deepEqual(codes({ capabilityId: 'prepareAppointment', data: { catalog: 'empty' } }), [
    'catalog_unavailable',
  ]);
  assert.deepEqual(codes({ capabilityId: 'prepareAppointment', counts: { clientCandidates: 0 } }), [
    'entity_unresolved',
  ]);
  assert.deepEqual(
    codes({ capabilityId: 'prepareAppointment', checks: { recognition: 'mismatch' } }),
    ['recognition_mismatch'],
  );
  assert.deepEqual(
    codes({ capabilityId: 'prepareAppointment', checks: { modelContract: 'invalid' } }),
    ['model_contract'],
  );
  assert.deepEqual(codes({ capabilityId: 'help', unsupportedBranch: 'create_client' }), [
    'function_absent',
  ]);
  const blocked = diagnoseSignal({
    capabilityId: 'prepareAppointment',
    checks: { constraint: 'forbidden' },
  });
  assert.deepEqual(
    blocked.gaps.map((item) => item.code),
    ['business_constraint'],
  );
  assert.equal(blocked.disposition, 'expected_boundary');
  assert.equal(
    diagnoseSignal({ capabilityId: 'prepareAppointment' }).disposition,
    'review_required',
  );
});
test('provider, limits, audio and transport evidence is bounded and never inferred from a library phrase', () => {
  assert.deepEqual(
    codes({
      checks: {
        provider: 'unavailable',
        limit: 'exceeded',
        audio: 'playback_blocked',
        transport: 'interrupted',
      },
    }),
    ['provider_unavailable', 'limit_exceeded', 'audio_playback', 'transport_interrupted'],
  );
  assert.equal(diagnoseSignal({ checks: { audio: 'playback_blocked' } }).disposition, 'defect');
  assert.deepEqual(codes({}), []);
});
test('diagnostic records reject identity, utterance, model reply, keys and arbitrary error text at every level', () => {
  for (const value of [
    { name: 'SECRET_PERSON' },
    { phone: '79990000001' },
    { rawText: 'PRIVATE_UTTERANCE' },
    { checks: { modelContract: 'PRIVATE_MODEL_TEXT' } },
    { counts: { clientName: 'SECRET_PERSON' } },
    { stamps: { apiKey: 'SECRET_KEY' } },
    { fields: { missing: ['SECRET_PERSON'] } },
    { capabilityId: 'createClient' },
    { role: 'global_admin' },
    { counts: { selectedExamples: -1 } },
    { capabilityId: 'calendar', unsupportedBranch: 'create_client' },
  ])
    assert.throws(
      () => normalizeDiagnosticSignal(value),
      (error) => error.status === 400 && !/SECRET|PRIVATE|7999000/u.test(error.message),
    );
  const safe = normalizeDiagnosticSignal({
    capabilityId: 'calendar',
    role: 'owner',
    phase: 'initial',
    counts: { selectedExamples: 3 },
    stamps: { sourceHash: hash(), policyRevision: 8, dialogueVersion: 2 },
  });
  assert.doesNotMatch(
    JSON.stringify(safe),
    /patientId|accountId|organizationId|phone|rawText|errorMessage|apiKey/u,
  );
});
test('a report cannot be closed after fixing one phrase without reproduction, cause, patch and neighboring/boundary regression evidence', () => {
  const reported = createIncident({
    id: id(1),
    signal: {
      capabilityId: 'moveAppointment',
      phase: 'date',
      fields: { before: ['time'], after: [] },
    },
  });
  assert.throws(() =>
    advanceIncident(reported, {
      action: 'diagnose',
      gapCode: 'context_lost',
      evidenceStamp: hash(),
    }),
  );
  const reproduced = advanceIncident(reported, {
    action: 'reproduce',
    caseId: id(2),
    fixtureStamp: hash(),
  });
  const diagnosed = advanceIncident(reproduced, {
    action: 'diagnose',
    gapCode: 'context_lost',
    evidenceStamp: hash('b'),
  });
  assert.throws(
    () => advanceIncident(diagnosed, { action: 'patch', kind: 'examples', sourceStamp: hash('c') }),
    'an example cannot repair a proven server-context loss',
  );
  const patched = advanceIncident(diagnosed, {
    action: 'patch',
    kind: 'context',
    sourceStamp: hash('c'),
  });
  const regressions = [
    { caseId: id(2), relation: 'reported', passed: true },
    { caseId: id(3), relation: 'neighbor', passed: true },
    { caseId: id(4), relation: 'boundary', passed: true },
  ];
  assert.throws(() =>
    advanceIncident(patched, {
      action: 'verify',
      sourceStamp: hash('c'),
      regressions: regressions.slice(0, 1),
    }),
  );
  assert.throws(() =>
    advanceIncident(patched, { action: 'verify', sourceStamp: hash('d'), regressions }),
  );
  assert.throws(() =>
    advanceIncident(patched, {
      action: 'verify',
      sourceStamp: hash('c'),
      regressions: regressions.map((row, index) => ({ ...row, passed: index !== 1 })),
    }),
  );
  const verified = advanceIncident(patched, {
    action: 'verify',
    sourceStamp: hash('c'),
    regressions,
  });
  assert.equal(verified.status, 'verified');
  assert.equal(reported.status, 'reported');
  assert.throws(() =>
    advanceIncident(
      { ...patched, rawText: 'SECRET' },
      { action: 'verify', sourceStamp: hash('c'), regressions },
    ),
  );
  assert.throws(() =>
    advanceIncident(
      { ...patched, repro: { ...patched.repro, phone: '79990000001' } },
      { action: 'verify', sourceStamp: hash('c'), regressions },
    ),
  );
});
