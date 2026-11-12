const fs = require('node:fs');
const path = require('node:path');
const { readCandidate } = require('./state.cjs');
const { objectHash, safePath, controllerHash } = require('./files.cjs');
const { steps } = require('./plan.cjs');
const { validAggregate } = require('./aggregate.cjs');
const { earlySteps } = require('./impact.cjs');
const { priorityPlan } = require('./priority-plan.cjs');
const { verifyProfile, scopePlan, validateScopedReport } = require('./verification-profile.cjs');

function status(root, id) {
  const candidate = readCandidate(root, id);
  const verificationProfile = verifyProfile(root, candidate);
  const targets = {};
  for (const target of ['windows', 'linux']) {
    const file = safePath(candidate.directory, 'reports/' + target + '/report.json');
    if (!fs.existsSync(file)) {
      targets[target] = { status: 'missing' };
      continue;
    }
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    let plan = steps(candidate.source, { target, unitWorkers: report.settings?.unitWorkers });
    if (verificationProfile) plan = scopePlan(plan, verificationProfile, { target });
    let priorityValid = true;
    if (report.settings?.priorityTests !== undefined) {
      try {
        const impact = JSON.parse(
          fs.readFileSync(safePath(candidate.directory, 'impact-' + target + '.json'), 'utf8'),
        );
        const { planHash, ...data } = impact;
        if (
          objectHash(data) !== planHash ||
          planHash !== report.impactHash ||
          impact.sourceHash !== candidate.data.sourceHash ||
          impact.candidate !== id ||
          impact.target !== target
        )
          throw Error('Priority impact proof differs');
        const expectedFiles = impact.earlyTests.map((row) => row.file);
        const smoke = earlySteps(plan, impact, report.settings.unitWorkers).find(
          (step) => step.earlyBrowser,
        );
        if (
          objectHash(expectedFiles) !== objectHash(report.settings.priorityTests) ||
          Boolean(smoke) !== report.settings.priorityBrowserSmoke
        )
          throw Error('Priority selection differs');
        if (report.settings.streamPriority !== undefined && report.settings.streamPriority !== true)
          throw Error('Invalid streaming setting');
        plan = priorityPlan(plan, expectedFiles, smoke, Boolean(report.settings.streamPriority));
      } catch {
        priorityValid = false;
      }
    }
    let scopedValid = false;
    if (verificationProfile) {
      try {
        if (
          report.version !== 1 ||
          report.profile !== 'assistant-ui' ||
          report.profileHash !== verificationProfile.profileHash ||
          (verificationProfile.selectionMode &&
            (report.selectionMode !== verificationProfile.selectionMode ||
              report.scope !== 'targeted' ||
              report.fullVerification !== false ||
              objectHash(report.coverage) !== objectHash(verificationProfile.coverage))) ||
          report.settings?.verificationProfileHash !== verificationProfile.profileHash ||
          report.settings?.unitWorkers !== 1 ||
          report.settings?.unitShards !== 1 ||
          report.settings?.priorityTests !== undefined ||
          report.selectedPhase !== 'all' ||
          report.part ||
          report.partial ||
          report.fullRequired ||
          report.candidate !== id ||
          report.target !== target ||
          report.sourceHash !== candidate.data.sourceHash ||
          report.status !== 'passed' ||
          report.planHash !== objectHash(plan) ||
          report.selectionHash !== objectHash(plan) ||
          report.environment?.os !== (target === 'windows' ? 'win32' : 'linux') ||
          report.environment?.controllerHash !== controllerHash(candidate.data.files) ||
          !Array.isArray(report.steps) ||
          !plan.every((step) =>
            report.steps.some(
              (item) =>
                item.id === step.id &&
                item.inputHash === objectHash(step) &&
                item.status === 'passed',
            ),
          )
        )
          throw Error('Scoped verification does not match the sealed native plan');
        validateScopedReport(candidate, target, report, verificationProfile);
        scopedValid = true;
      } catch {
        scopedValid = false;
      }
    }
    const valid = verificationProfile
      ? scopedValid
      : report.version === 2
        ? priorityValid && validAggregate(candidate, target, report)
        : report.version === 1 &&
          report.candidate === id &&
          report.target === target &&
          report.sourceHash === candidate.data.sourceHash &&
          report.planHash === objectHash(plan) &&
          report.environment?.os === (target === 'windows' ? 'win32' : 'linux') &&
          report.environment?.controllerHash === controllerHash(candidate.data.files) &&
          report.status === 'passed' &&
          priorityValid &&
          plan.every((step) =>
            report.steps.some(
              (item) =>
                item.id === step.id &&
                item.inputHash === objectHash(step) &&
                item.status === 'passed',
            ),
          );
    targets[target] = {
      status: valid ? 'passed' : 'not_passed',
      durationMs: report.durationMs,
      error: report.error,
      report: path.relative(root, file).replaceAll('\\', '/'),
    };
  }
  return {
    id,
    sourceHash: candidate.data.sourceHash,
    profile: verificationProfile ? 'assistant-ui' : 'full',
    ...(verificationProfile
      ? {
          profileHash: verificationProfile.profileHash,
          baseline: verificationProfile.baseline.id,
          ...(verificationProfile.selectionMode
            ? {
                selectionMode: verificationProfile.selectionMode,
                scope: 'targeted',
                fullVerification: false,
              }
            : {}),
        }
      : {}),
    targets,
    readyToPackage: Object.values(targets).every((t) => t.status === 'passed'),
    published: false,
  };
}
module.exports = { status };
