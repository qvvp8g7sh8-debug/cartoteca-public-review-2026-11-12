const { normalizeIntent, validateCommandFields } = require('../interpretation/intent-schema.cjs');
const {
  capabilityRegistry,
  capabilityDefinition,
} = require('../interpretation/capability-registry.cjs');
const { diagnoseSignal, gap } = require('./behavior-diagnostics-schema.cjs');
const { createHash } = require('node:crypto');
const auditedCases = require('./behavior-case-classification.json');
const { currentIntentForCase, excludedCaseIds } = require('./example-projection.cjs');
const nextSteps = {
  available: 'Проверять соседние сценарии в текущем контракте.',
  manual_only: 'Открывать штатную форму; не обещать автоматическое изменение.',
  not_implemented: 'Сначала реализовать серверную ветку помощника; пример не добавляет действие.',
  policy_boundary: 'Сохранить проверку и коротко объяснить ограничение.',
  needs_review: 'Сначала воспроизвести случай и установить причину.',
};
function assessmentForCase(row) {
  let intent;
  try {
    intent = validateCommandFields(normalizeIntent(currentIntentForCase(row)));
  } catch {
    return {
      family: 'archive',
      support: 'needs_review',
      capabilityId: null,
      selectionRole: 'archive',
      disposition: 'review_required',
      execution: null,
      requiresSavingFlag: false,
      gaps: [gap('example_contract_stale')],
      nextStep: nextSteps.needs_review,
    };
  }
  const capability = capabilityDefinition(intent.intent);
  const active =
    row.preconditions?.activeDialogue === true ||
    (Array.isArray(row.preconditions) &&
      row.preconditions.some(
        (value) =>
          typeof value === 'string' &&
          /^(?:есть\s+)?активн(?:ый|ая|ое)\s+(?:серверный\s+)?диалог/iu.test(value),
      ));
  const projected = intent.intent !== row.current?.intent?.intent;
  const family = excludedCaseIds.has(row.id)
    ? 'archive'
    : row.current.status === 'unsupported' && !projected
      ? 'boundary'
      : active || row.current.status === 'needs_clarification'
        ? 'clarification'
        : 'action';
  let support =
    family === 'archive'
      ? 'needs_review'
      : capability?.execution === 'manual_form'
        ? 'manual_only'
        : family === 'boundary'
          ? 'needs_review'
          : 'available';
  let gaps =
      family === 'archive'
        ? [gap('example_contract_stale')]
        : support === 'needs_review'
          ? [gap(family === 'boundary' ? 'evidence_missing' : 'execution_mode_unknown')]
          : [],
    disposition = support === 'needs_review' ? 'review_required' : 'declared_behavior';
  // Audit is bound to the existing synthetic author case, not a guessed meaning
  // of every unsupported/help request. Changed or unknown cases require review.
  const audit = auditedCases[row.id];
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([row.text, row.referenceDate, row.referenceTime, intent, row.current.status]),
    )
    .digest('hex');
  if (audit && audit.fingerprint === fingerprint) {
    support = audit.support;
    gaps =
      support === 'not_implemented'
        ? [gap('function_absent')]
        : support === 'manual_only'
          ? [gap('manual_interface_step')]
          : [];
    disposition =
      support === 'policy_boundary' || support === 'not_implemented'
        ? 'expected_boundary'
        : 'declared_behavior';
  }
  if (row.diagnostics !== undefined) {
    try {
      const diagnosis = diagnoseSignal(row.diagnostics);
      if (diagnosis.signal.capabilityId && diagnosis.signal.capabilityId !== intent.intent)
        throw Error('capability mismatch');
      gaps = diagnosis.gaps;
      disposition = diagnosis.disposition;
      if (gaps.some((item) => item.code === 'function_absent')) support = 'not_implemented';
      else if (diagnosis.disposition === 'expected_boundary') support = 'policy_boundary';
      else if (diagnosis.disposition === 'defect' || diagnosis.disposition === 'review_required')
        support = 'needs_review';
    } catch {
      support = 'needs_review';
      disposition = 'review_required';
      gaps = [gap('diagnostic_invalid')];
    }
  }
  if (family === 'archive') {
    support = 'needs_review';
    disposition = 'review_required';
    gaps = [gap('example_contract_stale')];
  }
  return {
    family,
    support,
    capabilityId: support === 'not_implemented' ? null : capability?.id || null,
    execution: capability?.execution || null,
    requiresSavingFlag: capability?.gates.savingEnabled === true,
    selectionRole:
      family === 'archive'
        ? 'archive'
        : family === 'boundary'
          ? 'boundary'
          : active
            ? 'continuation'
            : 'initial',
    disposition,
    gaps,
    nextStep: nextSteps[support],
  };
}
function libraryCoverage(rows) {
  const gapCounts = {},
    capabilities = capabilityRegistry().map((item) => ({
      ...item,
      caseCounts: { action: 0, clarification: 0, boundary: 0, archive: 0 },
      gapCounts: {},
    }));
  const byId = new Map(capabilities.map((item) => [item.id, item]));
  let needsReview = 0,
    unassignedCases = 0;
  for (const row of rows) {
    const assessment = assessmentForCase(row),
      capability = byId.get(assessment.capabilityId);
    if (assessment.support === 'needs_review') needsReview++;
    if (capability) capability.caseCounts[assessment.family]++;
    else unassignedCases++;
    for (const item of assessment.gaps) {
      gapCounts[item.code] = (gapCounts[item.code] || 0) + 1;
      if (capability) capability.gapCounts[item.code] = (capability.gapCounts[item.code] || 0) + 1;
    }
  }
  return {
    schemaVersion: 1,
    totalCases: rows.length,
    capabilities,
    gapCounts,
    needsReview,
    unassignedCases,
  };
}
module.exports = { assessmentForCase, libraryCoverage };
