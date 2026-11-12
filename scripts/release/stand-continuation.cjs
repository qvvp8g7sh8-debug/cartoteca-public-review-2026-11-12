const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// This exception belongs only to the immutable image08 and its recorded transport fix.
const identity = Object.freeze({
  candidate: 'interface-20261014-08',
  sourceHash: 'b9725a1567efd44b2e5143ce7aadf0eab1e30b80f021a83647d73f094e0902e1',
  imageId: 'sha256:7bf4fc9a6ef9411846e0e3b932f81dd989339dda646f5243b192c840432214f2',
});
const pins = Object.freeze({
  runtime: '47594c9fdfe398498f7de24a5090901ab870d1358cc8ad2bddfec6b54a8d5312',
  controller: 'bae789dc11a84851ae3ff6991e79d32d811ca1eb202da03ce296b34a8b08cf54',
  helperBefore: '1e75323809cb283abbf65ab6a028381ec7de10d975825665853c610c5b39a73b',
  helperAfter: '109be3b6a7278379d33f6352bb0fa9bed83106722482acdc68e82e9dac3601c9',
});
const scenarios = Object.freeze([
  'success-after-disconnect-and-duplicate-launch',
  'damaged-archive',
  'backup-failed-before-switch',
  'concurrent-release-lock',
  'startup-failure-rolls-back',
  'schema-15-without-migration',
  'staff-max-15-to-16-after-disconnect',
  'schema-16-without-migration',
  'staff-max-preparation-failure-keeps-schema15',
  'staff-max-gated-startup-failure-returns-schema15',
  'staff-max-activation-failure-keeps-new-data',
  'staff-max-directory-key-15-to-16',
  'staff-push-16-to-17-after-disconnect',
  'schema-17-without-migration',
  'staff-push-preparation-failure-keeps-schema16',
  'staff-push-gated-startup-failure-returns-schema16',
  'staff-push-activation-failure-keeps-new-data',
  'staff-push-directory-key-16-to-17',
  'structural-17-to-18-after-disconnect',
  'schema-18-without-migration',
  'structural-preparation-failure-keeps-schema17',
  'structural-gated-startup-failure-returns-schema17',
  'structural-activation-failure-keeps-new-data',
  'read-budget-17-after-disconnect',
  'read-budget-17-without-migration',
  'read-budget-preparation-failure-keeps-schema17',
  'read-budget-gated-startup-failure-returns-schema17',
  'read-budget-activation-failure-keeps-new-data',
  'booking-links-17-after-disconnect',
  'booking-links-17-without-migration',
  'booking-links-preparation-failure-keeps-schema17',
  'booking-links-gated-startup-failure-returns-schema17',
  'booking-links-activation-failure-keeps-new-data',
  'publication-gate-after-disconnect',
  'publication-gate-without-migration',
  'publication-gate-startup-failure-returns-current',
  'publication-gate-activation-failure-keeps-current-data',
]);
const helperOverlay = Object.freeze({
  path: 'tests/helpers/release-stand-publication-gate.py',
  beforeSha256: pins.helperBefore,
  afterSha256: pins.helperAfter,
  astOnlyBusinessApi: true,
  changes: Object.freeze(['BUSINESS_API']),
});
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) =>
  Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
function document(bytes, name) {
  const data = jsonBytes(bytes);
  assert.ok(
    data.length > 0 && data.length <= 4 * 1024 * 1024,
    name + ' exceeds bounded report size',
  );
  const value = JSON.parse(data.toString('utf8'));
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    name + ' must be a report',
  );
  return { data, value, sha256: digest(data) };
}
function hash(value, name) {
  assert.match(value || '', /^[a-f0-9]{64}$/, name + ' requires a SHA256');
}
function same(actual, expected, name) {
  assert.deepEqual(actual, expected, name + ' differs from the explicit image08 proof');
}
function boundIdentity(value, name, imageRequired = true) {
  for (const key of ['candidate', 'sourceHash']) same(value[key], identity[key], name + '.' + key);
  if (imageRequired || value.imageId !== undefined)
    same(value.imageId, identity.imageId, name + '.imageId');
}
function exactCases(rows, names, name) {
  assert.ok(Array.isArray(rows), name + ' scenarios missing');
  same(
    rows.map((row) => row.scenario),
    names,
    name + ' ordered coverage',
  );
  assert.equal(
    new Set(rows.map((row) => row.scenario)).size,
    names.length,
    name + ' duplicate scenario',
  );
  assert.ok(
    rows.every((row) => row.passed === true),
    name + ' contains a failed scenario',
  );
}
function stage(row, names) {
  assert.ok(Array.isArray(row.stages), row.scenario + ' timings missing');
  const latest = new Map(row.stages.map((item) => [item.stage, item.status]));
  for (const name of names) same(latest.get(name), 'passed', row.scenario + '/' + name);
  return latest;
}
function continuationCases(rows, faults) {
  const [ordinary, startup, activation] = rows;
  const common = {
    schema: 17,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
    personalReservationsPreserved: true,
    noSqlMigration: true,
    noDataRollback: true,
  };
  for (const [index, row] of rows.entries()) {
    same(row.schema, 17, row.scenario + ' schema');
    for (const [name, value] of Object.entries(common))
      same(row.publicationGate?.[name], value, row.scenario + '/' + name);
    same(row.publicationGate?.retainedLatestData, index === 2, row.scenario + ' latest data');
    same(row.publicationGate?.gatedBeforeActivation, index !== 1, row.scenario + ' gated phase');
  }
  same(ordinary.status, 'completed', 'ordinary status');
  same(
    ordinary.personalCalendarApi,
    {
      personalCreated: true,
      manualOverlapBlocked: true,
      publicOverlapBlocked: true,
      neighboringTimeAvailable: true,
      noPatientOrAppointmentCreated: true,
    },
    'business API',
  );
  stage(ordinary, [
    'preflight',
    'save-configuration',
    'backup-before',
    'recheck-previous',
    'switch',
    'public-checks',
    'publication-activate',
    'public-checks-activated',
    'backup-after',
    'restore-backup-timer',
  ]);
  same(startup.status, 'rolled_back', 'gated startup failure');
  const startupStages = stage(startup, [
    'preflight',
    'backup-before',
    'recheck-previous',
    'rollback',
    'restore-backup-timer',
  ]);
  assert.notEqual(
    startupStages.get('publication-activate'),
    'passed',
    'startup unexpectedly activated',
  );
  same(activation.status, 'needs_attention', 'activation failure');
  stage(activation, [
    'preflight',
    'backup-before',
    'recheck-previous',
    'switch',
    'public-checks',
    'publication-quarantine',
    'restore-backup-timer',
  ]);
  assert.ok(
    !activation.stages.some((item) => item.stage === 'rollback'),
    'committed failure attempted old rollback',
  );
  same(
    faults,
    {
      startup: { activationCommitted: false, rollbackPassed: true },
      activation: {
        activationCommitted: true,
        publicationCommitted: true,
        quarantinePassed: true,
        applicationRunning: false,
        oldImageRestored: false,
        currentDataRetained: true,
      },
    },
    'gate failure observations',
  );
}

function validateContinuation(originalBytes, supplementBytes, receiptBytes) {
  const original = document(originalBytes, 'original'),
    supplement = document(supplementBytes, 'supplement'),
    receiptDocument = document(receiptBytes, 'receipt'),
    receipt = receiptDocument.value,
    extra = supplement.value;
  same(receipt.version, 1, 'receipt version');
  boundIdentity(receipt.identity || {}, 'receipt');
  boundIdentity(original.value, 'original', false);
  boundIdentity(extra, 'supplement');
  same(extra.version, 1, 'supplement version');
  same(original.value.passed, false, 'original must remain failed');
  same(extra.passed, true, 'supplement status');
  hash(receipt.originalReportSha256, 'original report');
  same(receipt.originalReportSha256, original.sha256, 'original bytes');
  same(extra.originalReportSha256, original.sha256, 'supplement original reference');
  if (receipt.supplementSha256 !== undefined) {
    hash(receipt.supplementSha256, 'supplement report');
    same(receipt.supplementSha256, supplement.sha256, 'supplement bytes');
  }
  for (const name of ['runtime', 'controller']) {
    const expected = { beforeSha256: pins[name], afterSha256: pins[name] };
    same(receipt[name], expected, 'receipt ' + name);
    same(extra[name], expected, 'supplement ' + name);
  }
  same(receipt.helperOverlay, helperOverlay, 'receipt helper overlay');
  same(extra.helperOverlay, helperOverlay, 'supplement helper overlay');
  if (receipt.adapter !== undefined || extra.adapter !== undefined) {
    assert.ok(receipt.adapter && extra.adapter, 'adapter hashes require explicit receipt pins');
    same(Object.keys(receipt.adapter).sort(), ['proofSha256', 'requestSha256'], 'adapter fields');
    for (const name of ['requestSha256', 'proofSha256'])
      hash(receipt.adapter[name], 'adapter ' + name);
    same(extra.adapter, receipt.adapter, 'adapter request/proof binding');
  }
  exactCases(original.value.scenarios, scenarios.slice(0, 34), 'original');
  exactCases(extra.scenarios, scenarios.slice(34), 'supplement');
  continuationCases(extra.scenarios, extra.gateFaults);
  return {
    version: 1,
    kind: 'stand-continuation-aggregate',
    ...identity,
    passed: true,
    scope: 'stand-only; full application reports and source identity are unchanged',
    scenarios: structuredClone([...original.value.scenarios, ...extra.scenarios]),
    provenance: {
      original: { sha256: original.sha256, passed: false, scenarios: 34 },
      supplement: { sha256: supplement.sha256, scenarios: 3 },
      receiptSha256: receiptDocument.sha256,
      runtime: receipt.runtime,
      controller: receipt.controller,
      helperOverlay: receipt.helperOverlay,
      gateFaults: extra.gateFaults,
      ...(receipt.adapter ? { adapter: receipt.adapter } : {}),
    },
  };
}
function writeAggregate(originalFile, supplementFile, receiptFile, outputFile) {
  const fs = require('node:fs'),
    path = require('node:path');
  const inputs = [originalFile, supplementFile, receiptFile].map((file) => path.resolve(file)),
    output = path.resolve(outputFile);
  assert.ok(!inputs.includes(output), 'aggregate must never replace an input report');
  for (const file of [...inputs, path.dirname(output)])
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false, 'linked report path');
  const result = validateContinuation(...inputs.map((file) => fs.readFileSync(file)));
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
module.exports = { validateContinuation, writeAggregate, identity, pins, helperOverlay, scenarios };
if (require.main === module) {
  try {
    assert.equal(
      process.argv.length,
      6,
      'Expected original, supplement, receipt and NEW aggregate paths',
    );
    const result = writeAggregate(...process.argv.slice(2));
    console.log(
      JSON.stringify({
        candidate: result.candidate,
        imageId: result.imageId,
        scenarios: result.scenarios.length,
        originalPreserved: true,
        passed: true,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
