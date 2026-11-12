const migration = 'paid-services-17-to-19';
const scenarios = Object.freeze([
  'paid-services-17-to-19-after-disconnect',
  'schema-19-without-migration',
  'paid-services-preparation-failure-keeps-schema17',
  'paid-services-gated-startup-failure-returns-schema17',
  'paid-services-activation-failure-keeps-new-data',
]);
function paidTransition(config) {
  return config.migration === migration && config.schema === 19;
}
function validatePaidConfig(config) {
  if (config.schema !== 19 && config.paymentNetworkEnabled !== undefined)
    throw Error('Payment network pin is supported only by schema19 releases.');
  if (config.schema !== 19) return;
  if (
    config.paymentNetworkEnabled !== false ||
    config.readBudgetVersion !== 1 ||
    config.bookingLinksVersion !== 1 ||
    config.assistantSavingVersion !== 1 ||
    !(paidTransition(config)
      ? config.publicationGate === undefined
      : config.migration === undefined && config.publicationGate === true)
  )
    throw Error(
      'Schema19 requires the full paid-services transition or gated release with exact component pins and payment network OFF.',
    );
}
function matchesImage(report, selected) {
  if (selected === undefined) return true; // Selected artifact is checked again before transfer.
  if (typeof selected === 'string') return report.imageId === selected;
  const requested = selected?.report?.imageId;
  const binding = report.imageBinding;
  if (
    binding &&
    (binding.requestedId !== requested ||
      binding.targetId !== report.imageId ||
      binding.archiveSha256 !== selected.report?.archive?.sha256)
  )
    return false;
  if (report.imageId === requested) return true;
  try {
    const assert = require('node:assert/strict');
    const { hash } = require('./files.cjs');
    const record = selected.identity;
    const config = require('./image-base.cjs').imageConfig(record);
    assert.equal(record.requestedId, requested);
    assert.equal(config.os, 'linux');
    assert.equal(config.architecture, 'amd64');
    assert.equal(typeof record.manifest, 'string');
    assert.equal(record.manifestId, 'sha256:' + hash(Buffer.from(record.manifest)));
    const manifest = JSON.parse(record.manifest);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.config?.digest, record.configId);
    assert.equal(manifest.config?.size, Buffer.byteLength(record.config));
    assert.ok(binding && /^[a-f0-9]{64}$/.test(binding.archiveSha256));
    assert.deepEqual(
      new Set([requested, report.imageId]),
      new Set([record.manifestId, record.configId]),
    );
    return true;
  } catch {
    return false;
  }
}
function assertPaidStand(candidate, config, report, image) {
  if (config.schema !== 19) return;
  const expected = paidTransition(config) ? scenarios : ['schema-19-without-migration'];
  if (
    candidate.data.profile !== 'full' ||
    !/^sha256:[a-f0-9]{64}$/.test(report.imageId || '') ||
    !matchesImage(report, image) ||
    expected.some(
      (name) =>
        !report.scenarios?.some(
          (row) =>
            row.scenario === name &&
            row.passed === true &&
            row.paidServices?.paymentNetworkEnabled === false &&
            row.paidServices?.sourceSchema === (name === 'schema-19-without-migration' ? 19 : 17) &&
            row.paidServices?.platformOnly === true &&
            row.paidServices?.componentsPreserved === true,
        ),
    )
  )
    throw Error('Matching exact-image paid-services stand evidence is required.');
}
module.exports = {
  migration,
  scenarios,
  paidTransition,
  validatePaidConfig,
  assertPaidStand,
  matchesImage,
};
