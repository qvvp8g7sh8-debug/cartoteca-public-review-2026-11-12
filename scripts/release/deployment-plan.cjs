const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safePath, objectHash } = require('./files.cjs');
const { readCandidate } = require('./state.cjs');
const { status } = require('./status.cjs');
const paid = require('./paid-services-policy.cjs');

const stages = [
  'artifact',
  'transfer',
  'preflight',
  'backup-before',
  'switch',
  'public-checks',
  'backup-after',
];
function configuration(file) {
  const value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const keys = [
    'host',
    'user',
    'port',
    'identityFile',
    'knownHostsFile',
    'root',
    'releaseRoot',
    'container',
    'project',
    'backupTimer',
    'origin',
    'schema',
    'expectedImage',
  ];
  if (
    Object.keys(value).some(
      (key) =>
        !keys.includes(key) &&
        ![
          'migration',
          'readBudgetVersion',
          'bookingLinksVersion',
          'publicationGate',
          'assistantSavingVersion',
          'paymentNetworkEnabled',
          'storageBackend',
          'postgresProfile',
        ].includes(key),
    ) ||
    keys.some((key) => value[key] === undefined)
  )
    throw Error('Invalid deployment configuration fields');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.host) || !/^[a-z_][a-z0-9_-]*$/.test(value.user))
    throw Error('Invalid SSH destination');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
    throw Error('Invalid SSH port');
  for (const key of ['root', 'releaseRoot']) {
    if (!/^\/opt\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value[key]))
      throw Error('Invalid server directory');
  }
  if (
    value.root === value.releaseRoot ||
    value.root.startsWith(value.releaseRoot + '/') ||
    value.releaseRoot.startsWith(value.root + '/')
  )
    throw Error('Application and release directories must be separate');
  for (const key of ['container', 'project', 'backupTimer'])
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value[key])) throw Error('Invalid service name');
  const origin = new URL(value.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== value.origin ||
    origin.username ||
    origin.password
  )
    throw Error('Expected a bare HTTPS origin');
  const postgres = value.storageBackend === 'postgres';
  if (
    (value.storageBackend !== undefined &&
      !['sqlite', 'postgres'].includes(value.storageBackend)) ||
    (!postgres && value.postgresProfile !== undefined)
  )
    throw Error('Invalid deployment storage backend');
  if (!(postgres ? [11, 15, 16, 17, 18, 19, 20] : [11, 15, 16, 17, 18, 19]).includes(value.schema))
    throw Error('Unsupported prepared schema');
  if (postgres) require('./postgres-proof.cjs').assertPostgresConfiguration(value);
  if (
    value.migration !== undefined &&
    !(
      (value.migration === 'staff-max-15-to-16' && value.schema === 16) ||
      (value.migration === 'staff-push-16-to-17' && value.schema === 17) ||
      (value.migration === 'structural-17-to-18' && value.schema === 18) ||
      paid.paidTransition(value) ||
      (value.migration === 'read-budget-17' &&
        value.schema === 17 &&
        value.readBudgetVersion === 1) ||
      (value.migration === 'booking-links-17' &&
        value.schema === 17 &&
        value.readBudgetVersion === 1 &&
        value.bookingLinksVersion === 1)
    )
  )
    throw Error('Only explicit prepared MAX, Push, structural or component migration is supported');
  if (
    value.readBudgetVersion !== undefined &&
    (value.readBudgetVersion !== 1 ||
      !(postgres ? [17, 19, 20] : [17, 19]).includes(value.schema) ||
      (value.migration !== undefined &&
        !['read-budget-17', 'booking-links-17', paid.migration].includes(value.migration)))
  )
    throw Error('Only the prepared schema17 read-budget version1 release is supported');
  if (
    value.bookingLinksVersion !== undefined &&
    (value.bookingLinksVersion !== 1 ||
      !(postgres ? [17, 19, 20] : [17, 19]).includes(value.schema) ||
      value.readBudgetVersion !== 1 ||
      (value.migration !== undefined &&
        !['booking-links-17', paid.migration].includes(value.migration)))
  )
    throw Error('Only prepared schema17/read-budget1 booking links version1 are supported');
  if (!/^sha256:[a-f0-9]{64}$/.test(value.expectedImage))
    throw Error('Pin the expected current image ID');
  if (
    value.publicationGate !== undefined &&
    (value.publicationGate !== true ||
      value.migration !== undefined ||
      ![17, 19].includes(value.schema) ||
      value.readBudgetVersion !== 1 ||
      value.bookingLinksVersion !== 1)
  )
    throw Error('Publication gate requires an ordinary schema17 release with both component pins');
  if (
    value.assistantSavingVersion !== undefined &&
    (value.assistantSavingVersion !== 1 ||
      !(
        (postgres && value.schema === 19) ||
        paid.paidTransition(value) ||
        (value.publicationGate === true && value.migration === undefined)
      ) ||
      ![17, 19].includes(value.schema) ||
      value.readBudgetVersion !== 1 ||
      value.bookingLinksVersion !== 1)
  )
    throw Error(
      'Assistant saving version1 requires gated ordinary schema17 with both component pins',
    );
  if (!postgres) paid.validatePaidConfig(value);
  for (const key of ['identityFile', 'knownHostsFile']) {
    if (!path.isAbsolute(value[key]) || !fs.statSync(value[key]).isFile())
      throw Error('SSH identity/known-hosts file is unavailable');
  }
  return value;
}

function plan(root, id, config) {
  const candidate = readCandidate(root, id);
  if (config.storageBackend === 'postgres')
    return {
      id,
      sourceHash: candidate.data.sourceHash,
      storageBackend: 'postgres',
      postgresProfile: 'production-v1',
      schema: config.schema,
      executes: false,
      automatedPublicationSupported: false,
      stages: [
        'artifact',
        'postgres-linux-rehearsal',
        'native-backup-and-restore-drill',
        'separate-cutover-plan',
      ],
      preparation: status(root, id),
      requires: [
        'matching immutable image and Linux PostgreSQL rehearsal',
        'native PostgreSQL backup and actual restore drill',
        'separate approved production cutover plan',
      ],
    };
  return {
    id,
    sourceHash: candidate.data.sourceHash,
    stages: config.migration
      ? [
          ...stages.slice(0, 4),
          'migration-stop',
          'migration-prepare',
          'migration-install',
          'switch-gated',
          'public-checks-gated',
          'migration-activate',
          'public-checks-activated',
          ...stages.slice(6),
        ]
      : config.publicationGate
        ? [
            ...stages.slice(0, 4),
            'switch-gated',
            'public-checks-gated',
            'publication-activate',
            'public-checks-activated',
            ...stages.slice(6),
          ]
        : stages,
    executes: false,
    preparation: status(root, id),
    schema: config.schema,
    migrations: config.migration || false,
    publicationGate: config.publicationGate === true,
    previousSchema: paid.paidTransition(config)
      ? 17
      : config.migration && !['read-budget-17', 'booking-links-17'].includes(config.migration)
        ? config.schema - 1
        : config.schema,
    requires: [
      candidate.data.selectionMode
        ? 'sealed targeted audio Windows/Linux reports; full verification explicitly not run'
        : candidate.data.profile === 'assistant-ui'
          ? 'qualified assistant-ui Windows/Linux reports with sealed backend inheritance'
          : 'complete Windows/Linux reports',
      'packaged immutable image',
      'explicit publication command',
    ],
  };
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function artifact(root, id, { imageIdentity = false } = {}) {
  const candidate = readCandidate(root, id);
  const verificationProfile = require('./verification-profile.cjs').verifyProfile(root, candidate);
  if (!status(root, id).readyToPackage)
    throw Error('Complete Windows/Linux verification is required; no automatic waiver');
  const folders = fs
    .readdirSync(candidate.directory)
    .filter((name) => /^image-\d+$/.test(name))
    .sort()
    .reverse();
  for (const folder of folders) {
    const reportFile = safePath(candidate.directory, folder + '/image.json');
    if (!fs.existsSync(reportFile)) continue;
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if (report.status !== 'packaged') continue;
    if (
      report.id !== id ||
      report.sourceHash !== candidate.data.sourceHash ||
      (verificationProfile &&
        (report.profile !== 'assistant-ui' ||
          report.profileHash !== verificationProfile.profileHash)) ||
      !/^sha256:[a-f0-9]{64}$/.test(report.imageId || '')
    )
      throw Error('Image provenance mismatch');
    if (['build', 'smoke', 'export'].some((step) => report.steps?.[step]?.status !== 'passed'))
      throw Error('Incomplete image checks');
    const archive = safePath(candidate.directory, report.archive.file);
    if (path.basename(archive) !== 'image.tar') throw Error('Unexpected image archive name');
    if (
      fs.statSync(archive).size !== report.archive.bytes ||
      (await digest(archive)) !== report.archive.sha256
    )
      throw Error('Image archive changed');
    if (verificationProfile) require('./image-base.cjs').validateImageBase(candidate, report);
    const identity = imageIdentity
      ? await require('./image-base.cjs').extractImageOci(archive, report.imageId)
      : undefined;
    return { candidate, report, archive, ...(identity ? { identity } : {}) };
  }
  return null;
}

function runtimeFiles(candidate) {
  const files = candidate.data.files,
    result = {};
  const docker = fs.readFileSync(path.join(candidate.source, 'Dockerfile'), 'utf8');
  for (const line of docker.split('\n').filter((line) => line.startsWith('COPY '))) {
    const parts = line.trim().split(/\s+/);
    if (parts.some((part) => part.startsWith('--')) || parts.includes('['))
      throw Error('Review new Docker COPY syntax before deployment');
    for (const name of parts.slice(1, -1)) {
      if (files[name]) result[name] = files[name].sha256;
      else {
        const children = Object.entries(files).filter(([key]) => key.startsWith(name + '/'));
        if (!children.length) throw Error('Unknown Docker input');
        for (const [key, info] of children) result[key] = info.sha256;
      }
    }
  }
  return result;
}

function serverConfiguration(config) {
  return Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => !['host', 'user', 'port', 'identityFile', 'knownHostsFile'].includes(key),
    ),
  );
}
function assertMigrationStand(candidate, config, imageId) {
  if (config.storageBackend === 'postgres')
    throw Error(
      'POSTGRES_RELEASE_SWITCH_NOT_APPROVED: use the explicit server package and a separate cutover plan',
    );
  const root = path.resolve(candidate.directory, '../../..');
  const profile = require('./verification-profile.cjs').verifyProfile(root, candidate);
  if (
    profile?.selectionMode &&
    (config.expectedImage !== profile.productionBase.imageId ||
      config.migration !== undefined ||
      config.schema !== 17 ||
      config.readBudgetVersion !== 1 ||
      config.bookingLinksVersion !== 1)
  )
    throw Error(
      'Targeted audio release requires its exact production-base image and unchanged schema/components',
    );
  if (
    profile &&
    (config.schema !== 17 ||
      config.migration !== undefined ||
      config.readBudgetVersion !== 1 ||
      config.bookingLinksVersion !== 1 ||
      config.publicationGate !== true ||
      config.assistantSavingVersion !== 1)
  )
    throw Error(
      'assistant-ui permits only the unchanged gated schema17/component1 assistant-saving release',
    );
  if (![16, 17, 18, 19].includes(config.schema)) return;
  const file = safePath(candidate.directory, 'stand/stand-report.json');
  if (!fs.existsSync(file)) throw Error('Matching staff MAX migration stand report is required');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (profile) require('./verification-profile.cjs').validateScopedStand(root, candidate, report);
  if (config.schema === 19) {
    if (report.sourceHash !== candidate.data.sourceHash || report.passed !== true)
      throw Error('Paid-services stand belongs to another source or failed.');
    return paid.assertPaidStand(candidate, config, report, imageId);
  }
  const required = [
    'schema-' + config.schema + '-without-migration',
    ...(config.readBudgetVersion === 1
      ? [
          'read-budget-17-after-disconnect',
          'read-budget-preparation-failure-keeps-schema17',
          'read-budget-gated-startup-failure-returns-schema17',
          'read-budget-activation-failure-keeps-new-data',
          'read-budget-17-without-migration',
        ]
      : []),
    ...(config.migration
      ? ['read-budget-17', 'booking-links-17'].includes(config.migration)
        ? []
        : config.schema === 18
          ? [
              'structural-17-to-18-after-disconnect',
              'structural-preparation-failure-keeps-schema17',
              'structural-gated-startup-failure-returns-schema17',
              'structural-activation-failure-keeps-new-data',
            ]
          : config.schema === 17
            ? [
                'staff-push-16-to-17-after-disconnect',
                'staff-push-preparation-failure-keeps-schema16',
                'staff-push-gated-startup-failure-returns-schema16',
                'staff-push-activation-failure-keeps-new-data',
              ]
            : [
                'staff-max-15-to-16-after-disconnect',
                'staff-max-preparation-failure-keeps-schema15',
                'staff-max-gated-startup-failure-returns-schema15',
                'staff-max-activation-failure-keeps-new-data',
              ]
      : []),
    ...(config.bookingLinksVersion === 1
      ? [
          'booking-links-17-after-disconnect',
          'booking-links-preparation-failure-keeps-schema17',
          'booking-links-gated-startup-failure-returns-schema17',
          'booking-links-activation-failure-keeps-new-data',
          'booking-links-17-without-migration',
        ]
      : []),
    ...(config.publicationGate === true
      ? [
          'publication-gate-after-disconnect',
          'publication-gate-startup-failure-returns-current',
          'publication-gate-activation-failure-keeps-current-data',
          'publication-gate-without-migration',
        ]
      : []),
  ];
  if (
    report.sourceHash !== candidate.data.sourceHash ||
    report.passed !== true ||
    required.some(
      (name) => !report.scenarios?.some((s) => s.scenario === name && s.passed === true),
    )
  )
    throw Error('Staff MAX stand is incomplete or belongs to another source snapshot');
}
module.exports = {
  configuration,
  plan,
  digest,
  artifact,
  runtimeFiles,
  serverConfiguration,
  stages,
  assertMigrationStand,
  objectHash,
};
