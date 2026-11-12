const { fail } = require('../../../../shared/errors.cjs');
const {
  diagnoseSignal,
  gapDefinitions,
  normalizeDiagnosticSignal,
} = require('./behavior-diagnostics-schema.cjs');
const bad = () => {
  throw fail(400, 'Переход диагностического случая не подтверждён.');
};
const stamp = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const caseId = (value) =>
  typeof value === 'string' &&
  /^(?:case|report)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
function keys(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    bad();
}
function createIncident(value) {
  keys(value, ['id', 'signal']);
  if (!caseId(value.id)) bad();
  const diagnosis = diagnoseSignal(value.signal);
  return {
    schemaVersion: 1,
    id: value.id,
    status: 'reported',
    signal: diagnosis.signal,
    gaps: diagnosis.gaps.map((item) => item.code),
    disposition: diagnosis.disposition,
    repro: null,
    rootCause: null,
    patch: null,
    verification: null,
  };
}
function advanceIncident(record, command) {
  const commandFields = {
    reproduce: ['action', 'caseId', 'fixtureStamp'],
    diagnose: ['action', 'gapCode', 'evidenceStamp'],
    patch: ['action', 'kind', 'sourceStamp'],
    verify: ['action', 'sourceStamp', 'regressions'],
  };
  keys(command, commandFields[command?.action] || []);
  keys(record, [
    'schemaVersion',
    'id',
    'status',
    'signal',
    'gaps',
    'disposition',
    'repro',
    'rootCause',
    'patch',
    'verification',
  ]);
  if (
    record.schemaVersion !== 1 ||
    !caseId(record.id) ||
    !['reported', 'reproduced', 'diagnosed', 'patched', 'verified'].includes(record.status)
  )
    bad();
  normalizeDiagnosticSignal(record.signal);
  if (
    !Array.isArray(record.gaps) ||
    record.gaps.length > Object.keys(gapDefinitions).length ||
    record.gaps.some((code) => !Object.hasOwn(gapDefinitions, code)) ||
    !['defect', 'expected_clarification', 'expected_boundary', 'review_required'].includes(
      record.disposition,
    )
  )
    bad();
  if (record.repro) {
    keys(record.repro, ['caseId', 'fixtureStamp']);
    if (!caseId(record.repro.caseId) || !stamp(record.repro.fixtureStamp)) bad();
  }
  if (record.rootCause) {
    keys(record.rootCause, ['code', 'evidenceStamp']);
    if (
      !Object.hasOwn(gapDefinitions, record.rootCause.code) ||
      !stamp(record.rootCause.evidenceStamp)
    )
      bad();
  }
  if (record.patch) {
    keys(record.patch, ['kind', 'sourceStamp']);
    if (
      !Object.values(gapDefinitions).some(
        (row) => row[1] === record.patch.kind && row[1] !== 'none',
      ) ||
      !stamp(record.patch.sourceStamp)
    )
      bad();
  }
  if (record.verification) {
    keys(record.verification, ['sourceStamp', 'regressions']);
    if (
      !stamp(record.verification.sourceStamp) ||
      !Array.isArray(record.verification.regressions) ||
      record.verification.regressions.length > 30
    )
      bad();
    for (const row of record.verification.regressions) {
      keys(row, ['caseId', 'relation', 'passed']);
      if (
        !caseId(row.caseId) ||
        !['reported', 'neighbor', 'boundary'].includes(row.relation) ||
        typeof row.passed !== 'boolean'
      )
        bad();
    }
  }
  const progress = ['reported', 'reproduced', 'diagnosed', 'patched', 'verified'].indexOf(
    record.status,
  );
  if (
    (progress >= 1 && !record.repro) ||
    (progress >= 2 && !record.rootCause) ||
    (progress >= 3 && !record.patch) ||
    (progress >= 4 && !record.verification)
  )
    bad();
  const result = structuredClone(record);
  if (command.action === 'reproduce' && record.status === 'reported') {
    if (!caseId(command.caseId) || !stamp(command.fixtureStamp)) bad();
    result.repro = { caseId: command.caseId, fixtureStamp: command.fixtureStamp };
    result.status = 'reproduced';
  } else if (command.action === 'diagnose' && record.status === 'reproduced') {
    if (!Object.hasOwn(gapDefinitions, command.gapCode) || !stamp(command.evidenceStamp)) bad();
    if (record.gaps.length && !record.gaps.includes(command.gapCode)) bad();
    result.rootCause = { code: command.gapCode, evidenceStamp: command.evidenceStamp };
    if (command.gapCode === 'example_selection') result.disposition = 'defect';
    result.status = 'diagnosed';
  } else if (command.action === 'patch' && record.status === 'diagnosed') {
    const layer = gapDefinitions[record.rootCause.code][1];
    if (layer === 'none' || command.kind !== layer || !stamp(command.sourceStamp)) bad();
    result.patch = { kind: command.kind, sourceStamp: command.sourceStamp };
    result.status = 'patched';
  } else if (command.action === 'verify' && record.status === 'patched') {
    if (
      command.sourceStamp !== record.patch.sourceStamp ||
      !Array.isArray(command.regressions) ||
      command.regressions.length < 3 ||
      command.regressions.length > 30
    )
      bad();
    const ids = new Set(),
      relations = new Set();
    for (const row of command.regressions) {
      keys(row, ['caseId', 'relation', 'passed']);
      if (
        !caseId(row.caseId) ||
        ids.has(row.caseId) ||
        row.passed !== true ||
        !['reported', 'neighbor', 'boundary'].includes(row.relation)
      )
        bad();
      if (row.relation === 'reported' && row.caseId !== record.repro.caseId) bad();
      ids.add(row.caseId);
      relations.add(row.relation);
    }
    if (!['reported', 'neighbor', 'boundary'].every((relation) => relations.has(relation))) bad();
    result.verification = {
      sourceStamp: command.sourceStamp,
      regressions: structuredClone(command.regressions),
    };
    result.status = 'verified';
  } else bad();
  return result;
}
module.exports = { createIncident, advanceIncident };
