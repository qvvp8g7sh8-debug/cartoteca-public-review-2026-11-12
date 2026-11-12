const fs = require('node:fs');
const path = require('node:path');
const { readCandidate, writeJson, lock } = require('./state.cjs');
const { objectHash, safePath, assertController } = require('./files.cjs');
const { testFiles } = require('./plan.cjs');
const { baseline } = require('./impact-baseline.cjs');
const { linkedTests } = require('./impact-graph.cjs');
const { riskTests, timePickerChanged } = require('./risk-tests.cjs');
const { caseNames: timePickerSmokeCases } = require('../../tests/browser/time-picker-smoke.cjs');

function impact(
  root,
  id,
  { baselineId, target = process.platform === 'win32' ? 'windows' : 'linux' } = {},
) {
  if (!['windows', 'linux'].includes(target)) throw Error('Invalid impact target');
  const candidate = readCandidate(root, id);
  assertController(root, candidate.data.files);
  const previous = baseline(root, candidate, baselineId),
    current = candidate.data.files;
  const changes = [],
    unchanged = [];
  for (const name of [
    ...new Set([...Object.keys(current), ...Object.keys(previous.files)]),
  ].sort()) {
    if (
      previous.known &&
      current[name] &&
      previous.files[name] &&
      objectHash(current[name]) === objectHash(previous.files[name])
    )
      unchanged.push(name);
    else
      changes.push({
        file: name,
        status: !previous.known
          ? 'uncompared'
          : !current[name]
            ? 'deleted'
            : !previous.files[name]
              ? 'added'
              : 'modified',
        before: previous.files[name]?.sha256 || null,
        after: current[name]?.sha256 || null,
      });
  }
  const tests = testFiles(candidate.source),
    names = changes.map((c) => c.file);
  const read = (name) => fs.readFileSync(safePath(candidate.source, name), 'utf8');
  const graph = linkedTests(current, read, names, tests);
  const selected = graph.selected;
  if (previous.known) {
    const old = linkedTests(previous.files, previous.read, names, tests);
    for (const [name, reasons] of old.selected)
      selected.set(name, [...(selected.get(name) || []), ...reasons, 'previous-source']);
  }
  const add = (name, reason) => {
    if (tests.includes(name)) selected.set(name, [...(selected.get(name) || []), reason]);
  };
  const required = riskTests(names, tests);
  for (const [name, reasons] of required) for (const reason of reasons) add(name, reason);
  for (const name of names) if (tests.includes(name)) add(name, 'changed-test');
  if (
    names.some((n) =>
      /^scripts\/(?:release(?:\/|(?:-follow)?\.cjs)|check-|build-|test-)|^\.github\//.test(n),
    )
  )
    tests
      .filter((n) => /^tests\/(?:release-|browser-separation|documentation)/.test(n))
      .forEach((n) => add(n, 'pipeline-change'));
  if (names.some((n) => /\.md$/.test(n)))
    add('tests/documentation.test.cjs', 'documentation-change');
  if (names.some((n) => /\.css$/.test(n))) add('tests/styles.test.cjs', 'style-change');
  const broad =
    !previous.known ||
    names.some((n) =>
      /^(?:src\/shared\/|src\/server\/(?:application|http|infrastructure)\/|src\/client\/core\/|package(?:-lock)?\.json$|Dockerfile|compose|Caddyfile|src\/client\/manifest\.json$)/.test(
        n,
      ),
    );
  if (broad)
    ['auth.test.cjs', 'security.test.cjs', 'tests/client-contracts.test.cjs'].forEach((n) =>
      add(n, 'shared-or-unknown-change'),
    );
  const mandatory = new Set([
    ...required.keys(),
    ...[...selected]
      .filter(([, reasons]) =>
        reasons.some((reason) =>
          ['changed-test', 'direct-source', 'module-map-direct'].includes(reason),
        ),
      )
      .map(([name]) => name),
  ]);
  const timingsFile = safePath(candidate.source, 'scripts/release/unit-timings.json');
  const weights = fs.existsSync(timingsFile)
    ? JSON.parse(fs.readFileSync(timingsFile)).targets?.[target] || {}
    : {};
  const known = Object.values(weights)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const fallback = known[Math.floor(known.length / 2)] || 1000;
  const weight = (name) =>
    Number.isFinite(weights[name]) && weights[name] > 0 ? weights[name] : fallback;
  const priority = (name) =>
    names.includes(name)
      ? 0
      : required.has(name)
        ? 1
        : selected.get(name).some((r) => ['direct-source', 'module-map-direct'].includes(r))
          ? 2
          : selected.get(name).includes('pipeline-change')
            ? 3
            : 4;
  const ordered = [...selected.keys()].sort(
    (a, b) => priority(a) - priority(b) || weight(a) - weight(b) || a.localeCompare(b, 'en'),
  );
  // The heuristic budget bounds indirect tests only, never changed contracts or risk checks.
  // Every discovered test still runs in the full stage.
  const earlyTests = [],
    deferredTests = [];
  let estimatedMs = 0;
  for (const name of ordered) {
    const duration = weight(name);
    if (!mandatory.has(name) && earlyTests.length && estimatedMs + duration > 60000)
      deferredTests.push(name);
    else {
      earlyTests.push(name);
      estimatedMs += duration;
    }
  }
  const data = {
    version: 1,
    candidate: id,
    sourceHash: candidate.data.sourceHash,
    target,
    baseline: {
      known: previous.known,
      id: previous.id || null,
      sourceHash: previous.sourceHash || null,
      origin: previous.origin || null,
      reason: previous.reason || null,
    },
    changes,
    unchanged,
    affectedFiles: graph.affected,
    earlyTests: earlyTests.map((file) => ({ file, reasons: [...new Set(selected.get(file))] })),
    deferredTests,
    requiredRiskTests: [...required.keys()],
    mandatoryEarlyTests: [...mandatory].sort(),
    earlyBrowser: timePickerChanged(names)
      ? {
          reportType: 'time-picker-early-smoke',
          engines: target === 'windows' ? ['chromium'] : ['chromium', 'webkit'],
          widths: [390, 1440],
          caseNames: timePickerSmokeCases,
        }
      : null,
    remainingTests: tests.filter((n) => !earlyTests.includes(n)),
    estimatedSerialMs: estimatedMs,
    fullRequired: true,
    readyToPackage: false,
    coverage:
      'Changed tests, direct/module-map contracts and explicit risk checks are mandatory early; indirect links are advisory. Full OS/browser/integration verification remains required.',
    browser: names.some((n) => /^src\/client\//.test(n))
      ? 'All existing browser scenarios remain in the full stage'
      : 'Full browser stage unchanged',
    uncertain: broad || graph.unresolved.length > 0,
  };
  const release = lock(candidate.directory);
  try {
    writeJson(safePath(candidate.directory, 'impact-' + target + '.json'), {
      ...data,
      planHash: objectHash(data),
    });
  } finally {
    release();
  }
  return { ...data, planHash: objectHash(data) };
}
function earlySteps(plan, report, unitWorkers) {
  const files = report.earlyTests.map((t) => t.file);
  const selected = plan.filter((s) => s.phase === 'quality');
  if (files.length)
    selected.push({
      id: 'unit-early',
      phase: 'tests',
      unitFiles: files,
      args: [
        '--test',
        '--test-concurrency=' + unitWorkers,
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=./scripts/release/test-reporter.cjs',
        '--test-reporter-destination=work/release-unit-events-early.jsonl',
        ...files,
      ],
    });
  if (report.earlyBrowser)
    selected.push({
      id: 'early-browser-time-picker',
      phase: 'tests',
      earlyBrowser: report.earlyBrowser,
      args: ['scripts/test-time-picker-browser.cjs'],
      timeoutMs: 180000,
      env: {
        CARTOTECA_BROWSER_ENGINES: report.earlyBrowser.engines.join(','),
        CARTOTECA_BROWSER_WIDTHS: report.earlyBrowser.widths.join(','),
        CARTOTECA_BROWSER_REPORT: 'work/release-time-picker-smoke',
        ...(report.target === 'windows' ? { CARTOTECA_CHROMIUM_CHANNEL: 'msedge' } : {}),
      },
    });
  return selected;
}
module.exports = { impact, earlySteps };
