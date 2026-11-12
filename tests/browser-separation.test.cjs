const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { groups, widths } = require('../scripts/release/browser-matrix.cjs');
const { coverage, validateBrowserReport } = require('../scripts/release/browser-report.cjs');
const { createChecks } = require('./browser/checks.cjs');

function fakePage(width = 390) {
  let viewport = { width, height: 900 },
    scroll = { x: 4, y: 20 };
  return {
    viewportSize: () => ({ ...viewport }),
    setViewportSize: async (next) => {
      viewport = { ...next };
    },
    evaluate: async (fn, argument) =>
      vm.runInNewContext('(' + fn.toString() + ')', {
        innerWidth: viewport.width,
        innerHeight: viewport.height,
        scrollX: scroll.x,
        scrollY: scroll.y,
        requestAnimationFrame: (callback) => callback(),
        setTimeout,
        clearTimeout,
        scrollTo: (x, y) => {
          scroll = { x, y };
        },
      })(argument),
    scroll: () => scroll,
  };
}

function recorder(results) {
  return async (name, run, metadata) => {
    const row = { name, ...metadata, passed: false };
    try {
      await run();
      row.passed = true;
    } catch (error) {
      row.error = error.message;
    }
    results.push(row);
  };
}

test('two responsive flows retain every previous geometry width and reject empty/duplicate widths', () => {
  for (const suite of ['main', 'admin']) {
    const matrix = groups(suite);
    assert.deepEqual(
      matrix.map((group) => group.width),
      [390, 1440],
    );
    assert.deepEqual(
      matrix.flatMap((group) => group.layoutWidths),
      widths[suite],
    );
    assert.ok(
      matrix.every((group) =>
        group.layoutWidths.every((width) => width < 700 === (group.mode === 'mobile')),
      ),
    );
  }
  assert.equal(groups('main', '412')[0].width, 412);
  for (const value of ['', '390,390', '390,no', '279', []])
    assert.throws(() => groups('main', value), /Invalid viewport/);
});

test('appearance failure does not repeat or suppress a business action and restores viewport/scroll', async () => {
  const page = fakePage(),
    results = [],
    measured = [];
  const check = createChecks({
    page,
    width: 390,
    layoutWidths: [320, 390, 412],
    record: recorder(results),
    layout: async (current) => {
      const width = current.viewportSize().width;
      measured.push(width);
      if (width === 320) throw Error('Synthetic overflow');
    },
  });
  let saves = 0;
  await check('save', async () => {
    await check.layout(page, '#dialog');
    assert.equal(page.viewportSize().width, 390);
    assert.deepEqual(page.scroll(), { x: 4, y: 20 });
    saves++;
  });
  assert.equal(saves, 1);
  assert.deepEqual(measured, [320, 390, 412]);
  assert.equal(results.filter((row) => row.category === 'appearance' && !row.passed).length, 1);
  assert.equal(results.find((row) => row.category === 'functional').passed, true);
  await check('real-failure', async () => {
    throw Error('Synthetic save failed');
  });
  assert.equal(results.at(-1).passed, false);
});

test('popup appearance uses its own viewport and restoration failure blocks the functional flow', async () => {
  const page = fakePage(),
    popup = fakePage(600),
    results = [];
  const check = createChecks({
    page,
    width: 390,
    layoutWidths: [320, 390],
    record: recorder(results),
    layout: async (target) => assert.equal(target, popup),
  });
  await check('popup', async () => {
    await check.layout(popup);
  });
  assert.equal(page.viewportSize().width, 390);
  assert.equal(popup.viewportSize().width, 600);
  const set = popup.setViewportSize;
  popup.setViewportSize = async (value) => {
    if (value.width === 600) throw Error('Synthetic restore failure');
    await set(value);
  };
  await check('restore', async () => {
    await check.layout(popup);
  });
  assert.equal(results.at(-1).category, 'functional');
  assert.equal(results.at(-1).passed, false);
});

function completeReport(suite) {
  const expected = { suite, engine: 'webkit', functionalWidth: 390, layoutWidths: [320, 390, 412] };
  const common = { engine: 'webkit', flowWidth: 390, passed: true };
  const rows = [];
  for (const [name, minimum] of Object.entries(coverage[suite])) {
    rows.push({ ...common, name, category: 'functional', width: 390 });
    const required = name === 'login' ? 3 : minimum;
    for (let checkpoint = 0; checkpoint < required; checkpoint++)
      for (const width of expected.layoutWidths)
        rows.push({
          ...common,
          name: `${name}/${checkpoint}-layout`,
          category: 'appearance',
          width,
        });
  }
  return { rows, expected };
}

test('release refuses a green report missing a scenario, appearance state, width or browser identity', () => {
  for (const suite of ['main', 'admin']) {
    const { rows, expected } = completeReport(suite);
    validateBrowserReport(rows, expected);
    assert.throws(
      () =>
        validateBrowserReport(
          rows.filter((row) => row.category !== 'appearance'),
          expected,
        ),
      /Missing appearance/,
    );
    assert.throws(
      () =>
        validateBrowserReport(
          rows.filter((row) => row.category !== 'functional'),
          expected,
        ),
      /Incomplete functional/,
    );
    const first = rows.find((row) => row.category === 'appearance');
    assert.throws(
      () =>
        validateBrowserReport(
          rows.filter((row) => row !== first),
          expected,
        ),
      /Incomplete appearance widths/,
    );
    assert.throws(
      () => validateBrowserReport([...rows, first], expected),
      /Incomplete appearance widths/,
    );
    assert.throws(() => validateBrowserReport(rows.slice(1), expected), /Incomplete functional/);
    assert.throws(
      () => validateBrowserReport(rows, { ...expected, engine: 'chromium' }),
      /Wrong browser/,
    );
    assert.throws(
      () => validateBrowserReport(rows, { ...expected, functionalWidth: 1440 }),
      /Wrong functional/,
    );
    assert.throws(
      () =>
        validateBrowserReport(
          rows.map((row) => ({ ...row, passed: false })),
          expected,
        ),
      /failures/,
    );
  }
});
