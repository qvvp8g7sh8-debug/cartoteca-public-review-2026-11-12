const test = require('node:test');
const assert = require('node:assert/strict');
const { priorityPlan } = require('../scripts/release/priority-plan.cjs');
const { steps } = require('../scripts/release/plan.cjs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

for (const target of ['windows', 'linux']) {
  test('streamed priority keeps one full unit invocation and starts independent smoke before full browsers: ' + target, () => {
    const original = steps(root, { target, unitWorkers: 2 });
    const files = original.find(step => step.id === 'unit').args.filter(arg => arg.endsWith('.test.cjs'));
    const important = ['tests/organization-time-zone.test.cjs', 'tests/appointment-time-picker.test.cjs'];
    const smoke = { id: 'early-browser-time-picker', phase: 'tests', args: ['scripts/test-time-picker-browser.cjs'],
      earlyBrowser: { widths: [390, 1440], caseNames: Array.from({ length: 7 }, (_, i) => 'case-' + i) } };
    const modified = priorityPlan(original, important, smoke, true);
    const unit = modified.find(step => step.id === 'unit');
    assert.equal(modified.filter(step => step.unitFiles).length, 1);
    assert.deepEqual(unit.unitFiles.slice(0, important.length), important);
    assert.deepEqual(unit.unitFiles.slice().sort(), files.slice().sort());
    assert.deepEqual(unit.args.filter(arg => arg.endsWith('.test.cjs')), unit.unitFiles);
    assert.equal(modified[modified.indexOf(unit) + 1].id, 'early-browser-time-picker');
    assert.ok(!unit.priority);assert.ok(!modified.find(step => step.earlyBrowser).priority);
    assert.deepEqual(modified.filter(step => step.browserCoverage), original.filter(step => step.browserCoverage));
    assert.throws(() => priorityPlan(original, important, smoke, 'yes'), /Invalid priority execution mode/);
  });
}

for (const target of ['windows', 'linux']) {
  test('priority plan preserves every native unit file and browser group once: ' + target, () => {
    const original = steps(root, { target, unitWorkers: 2 });
    const unit = original.find(step => step.id === 'unit');
    const files = unit.args.filter(arg => arg.endsWith('.test.cjs'));
    const important = ['tests/organization-time-zone.test.cjs', 'tests/appointment-time-picker.test.cjs'];
    const modified = priorityPlan(original, important);
    const priority = modified.find(step => step.id === 'unit-priority');
    const rest = modified.find(step => step.id === 'unit-remainder');
    assert.equal(priority.priority, true);
    assert.equal(rest.priority, false);
    assert.deepEqual(priority.unitFiles, important);
    assert.deepEqual([...priority.unitFiles, ...rest.unitFiles].sort(), files.sort());
    assert.equal(new Set([...priority.unitFiles, ...rest.unitFiles]).size, files.length);
    assert.deepEqual(modified.filter(step => step.browserCoverage), original.filter(step => step.browserCoverage));
    assert.match(priority.args.join(' '), /release-unit-events-priority\.jsonl/);
    assert.match(rest.args.join(' '), /release-unit-events-remainder\.jsonl/);
    assert.deepEqual(unit.args.filter(arg => arg.endsWith('.test.cjs')).sort(), files);
  });
}

test('priority cannot introduce foreign paths or duplicate/drop complete coverage', () => {
  const original = steps(root, { target: 'windows', unitWorkers: 2 });
  assert.throws(() => priorityPlan(original, ['../outside.test.cjs']), /outside complete plan/);
  assert.throws(() => priorityPlan(original, ['tests/missing.test.cjs']), /outside complete plan/);
  assert.throws(() => priorityPlan(original, ['ui.test.cjs', 'ui.test.cjs']), /Duplicate priority/);
  assert.throws(() => priorityPlan(original.filter(step => step.id !== 'unit'), []), /one complete unit/);
  const files = original.find(step => step.id === 'unit').args.filter(arg => arg.endsWith('.test.cjs'));
  const allFirst = priorityPlan(original, files);
  assert.equal(allFirst.filter(step => step.unitFiles).length, 1);
  assert.equal(allFirst.find(step => step.id === 'unit-priority').unitFiles.length, files.length);
  const allLater = priorityPlan(original, []);
  assert.equal(allLater.filter(step => step.unitFiles).length, 1);
  assert.equal(allLater.find(step => step.id === 'unit-remainder').unitFiles.length, files.length);
});

test('independent early UI remains additional coverage instead of replacing full browser matrix', () => {
  const original = steps(root, { target: 'linux', unitWorkers: 2 });
  const smoke = {
    id: 'early-browser-time-picker', phase: 'tests', args: ['scripts/test-time-picker-browser.cjs'],
    earlyBrowser: { widths: [390, 1440], caseNames: Array.from({ length: 7 }, (_, i) => 'case-' + i) },
  };
  const modified = priorityPlan(original, ['tests/appointment-time-picker.test.cjs'], smoke);
  assert.equal(modified.find(step => step.earlyBrowser).priority, true);
  assert.deepEqual(modified.filter(step => step.browserCoverage), original.filter(step => step.browserCoverage));
  assert.throws(() => priorityPlan(original, [], { ...smoke, args: ['unknown.cjs'] }), /Unknown smoke/);
  assert.throws(() => priorityPlan(original, [], { ...smoke, command: 'powershell' }), /External smoke/);
  assert.throws(() => priorityPlan(original, [], { ...smoke, earlyBrowser: { ...smoke.earlyBrowser, widths: [390] } }), /Incomplete smoke widths/);
});
