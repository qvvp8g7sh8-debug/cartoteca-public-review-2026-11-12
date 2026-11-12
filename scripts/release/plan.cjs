const fs = require('node:fs');
const path = require('node:path');

const { widths, groups } = require('./browser-matrix.cjs');
const { splitTests } = require('./shards.cjs');
function testFiles(root) {
  const files = fs.readdirSync(root).filter((name) => name.endsWith('.test.cjs'));
  files.push(
    ...fs
      .readdirSync(path.join(root, 'tests'))
      .filter((name) => name.endsWith('.test.cjs'))
      .map((name) => 'tests/' + name),
  );
  return files.sort();
}

function steps(root, { target, unitWorkers = 2, unitShards = 1 }) {
  if (!['windows', 'linux'].includes(target)) throw Error('Unsupported verification target');
  if (!Number.isInteger(unitWorkers) || unitWorkers < 1 || unitWorkers > 8)
    throw Error('Invalid unit worker limit');
  if (!Number.isInteger(unitShards) || unitShards < 1 || unitShards > 8)
    throw Error('Invalid unit shard count');
  const files = testFiles(root);
  const isolated =
    unitShards > 1 &&
    target === 'windows' &&
    JSON.parse(fs.readFileSync(path.join(root, 'scripts/release/unit-timings.json'))).version >=
      3 &&
    files.includes('tests/max-setup.test.cjs')
      ? 'tests/max-setup.test.cjs'
      : null;
  const parallel = files.filter((file) => file !== isolated);
  const shards = unitShards === 1 ? [{ files }] : splitTests(root, parallel, target, unitShards);
  // OS credential protection launches Windows PowerShell. A dedicated VM avoids
  // competing with CPU-heavy suites without relaxing its real timeout or checks.
  if (isolated) shards.push({ files: [isolated] });
  const result = [
    { id: 'architecture', phase: 'quality', args: ['scripts/check-architecture.cjs', '--check'] },
    {
      id: 'format',
      phase: 'quality',
      args: [
        'node_modules/prettier/bin/prettier.cjs',
        '--check',
        'src/client/**/*.js',
        'src/shared/*.cjs',
        'src/server/**/*.cjs',
      ],
    },
    { id: 'diff', phase: 'quality', command: 'git', args: ['diff', '--cached', '--check'] },
    ...shards.map((shard, index) => ({
      id: unitShards === 1 ? 'unit' : 'unit-' + (index + 1),
      phase: 'tests',
      ...(unitShards === 1 ? {} : { unitFiles: shard.files }),
      args: [
        '--test',
        '--test-concurrency=' + unitWorkers,
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=./scripts/release/test-reporter.cjs',
        '--test-reporter-destination=work/release-unit-events' +
          (unitShards === 1 ? '' : '-' + (index + 1)) +
          '.jsonl',
        ...shard.files,
      ],
    })),
  ];
  // Windows keeps Edge coverage. Both Linux engines remain required for release readiness.
  for (const engine of target === 'linux' ? ['chromium', 'webkit'] : ['chromium'])
    for (const suite of ['main', 'admin'])
      for (const { mode, width, layoutWidths } of groups(suite))
        result.push({
          id: `${suite}-${engine}-${mode}`,
          phase: 'tests',
          browserCoverage: { suite, engine, functionalWidth: width, layoutWidths },
          args: [
            suite === 'main' ? 'scripts/test-browsers.cjs' : 'scripts/test-admin-browsers.cjs',
          ],
          env: {
            CARTOTECA_BROWSER_ENGINES: engine,
            CARTOTECA_BROWSER_WIDTHS: layoutWidths.join(','),
            CARTOTECA_BROWSER_REPORT: `work/release-browser/${suite}-${engine}-${mode}`,
            CARTOTECA_BROWSER_SCREENSHOTS: '0',
            ...(target === 'windows' ? { CARTOTECA_CHROMIUM_CHANNEL: 'msedge' } : {}),
          },
        });
  return result;
}

function browserInstallEngines(selection) {
  const engines = [
    ...new Set(selection.filter((s) => s.browserCoverage).map((s) => s.browserCoverage.engine)),
  ];
  if (engines.some((engine) => !['chromium', 'webkit'].includes(engine)))
    throw Error('Unsupported browser install engine');
  return engines.length ? engines : ['chromium', 'webkit'];
}

function describe(root) {
  return {
    version: 2,
    profile: 'full',
    optionalProfiles: {
      'assistant-ui':
        'Explicit qualified baseline; fresh assistant/controller tests, all quality/browser groups and new image; verified backend inheritance only',
    },
    executes: false,
    publishes: false,
    baseline:
      'release-baseline.json pins last published source; impact is advisory, full verification remains mandatory',
    early:
      'verify --precheck runs quality and bounded related unit/DOM tests before the full matrix',
    targets: Object.fromEntries(
      ['windows', 'linux'].map((target) => [target, steps(root, { target }).map((s) => s.id)]),
    ),
    quality: 'architecture includes build freshness, styles, docs, contracts and types',
    browser:
      'Actions at mobile/desktop anchors; independent appearance results at every previous viewport',
    note: 'Prepare freezes allowlisted source files. Verification never uses production data. Publishing remains a separate command.',
  };
}
module.exports = { widths, testFiles, steps, describe, browserInstallEngines };
