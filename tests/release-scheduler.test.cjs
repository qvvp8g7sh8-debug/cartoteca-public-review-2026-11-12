const test = require('node:test');
const assert = require('node:assert/strict');
const { resources, scheduleTests } = require('../scripts/release/scheduler.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function controlled() {
  const started = [], gates = new Map();
  const execute = step => {
    started.push(step.id);
    return new Promise((resolve, reject) => gates.set(step.id, { resolve, reject }));
  };
  return { started, gates, execute };
}

test('two-core scheduling isolates bounded smoke and unit workers, then overlaps browsers', async () => {
  const f = controlled();
  const steps = [{ id: 'unit' }, { id: 'main-a' }, { id: 'main-b' },
    { id: 'smoke', earlyBrowser: {} }];
  const run = scheduleTests(steps, { jobs: 2, cpus: 2, unitWorkers: 2 }, f.execute);
  await tick();
  assert.deepEqual(f.started, ['smoke']);
  f.gates.get('smoke').resolve(false); // An ordinary failed check must not suppress later checks.
  await tick();
  assert.deepEqual(f.started, ['smoke', 'unit']);
  f.gates.get('unit').resolve(true);
  await tick();
  assert.deepEqual(f.started, ['smoke', 'unit', 'main-a', 'main-b']);
  f.gates.get('main-b').resolve(true); f.gates.get('main-a').resolve(true);
  await run;
  assert.equal(new Set(f.started).size, steps.length);
});

test('four cores allow smoke and two unit workers together without lowering job parallelism', async () => {
  const f = controlled();
  const run = scheduleTests([{ id: 'unit' }, { id: 'main-a' }, { id: 'smoke', earlyBrowser: {} }],
    { jobs: 2, cpus: 4, unitWorkers: 2 }, f.execute);
  await tick();
  assert.deepEqual(f.started, ['smoke', 'unit']);
  f.gates.get('smoke').resolve(); await tick();
  assert.deepEqual(f.started, ['smoke', 'unit', 'main-a']);
  f.gates.get('unit').resolve(); f.gates.get('main-a').resolve(); await run;
});

test('one-core scheduling cannot deadlock on a multi-worker unit step', async () => {
  const f = controlled();
  const run = scheduleTests([{ id: 'unit' }, { id: 'main' }],
    { jobs: 4, cpus: 1, unitWorkers: 2 }, f.execute);
  await tick(); assert.deepEqual(f.started, ['unit']);
  f.gates.get('unit').resolve(); await tick(); assert.deepEqual(f.started, ['unit', 'main']);
  f.gates.get('main').resolve(); await run;
  assert.equal(resources({ id: 'unit-1' }, { cpus: 1, unitWorkers: 2 }), 1);
});

test('integrity exception stops new work and drains already running work', async () => {
  const f = controlled(), error = new Error('snapshot-integrity');
  const run = scheduleTests([{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    { jobs: 2, cpus: 2, unitWorkers: 2 }, f.execute);
  const rejected = assert.rejects(run, error);
  await tick(); assert.deepEqual(f.started, ['a', 'b']);
  f.gates.get('a').reject(error); await tick();
  assert.deepEqual(f.started, ['a', 'b']);
  f.gates.get('b').resolve(); await rejected;
});

test('cancellation starts no new work and waits for the owned operation to stop', async () => {
  const f = controlled(), controller = new AbortController();
  const run = scheduleTests([{ id: 'a' }, { id: 'b' }],
    { jobs: 1, cpus: 2, unitWorkers: 2 }, f.execute, controller.signal);
  await tick(); controller.abort(); f.gates.get('a').resolve(); await run;
  assert.deepEqual(f.started, ['a']);
});

test('invalid scheduling budgets are refused before executing any step', async () => {
  for (const invalid of [{ jobs: 0 }, { jobs: 5 }, { cpus: 0 }, { cpus: 1.5 },
    { unitWorkers: 0 }, { unitWorkers: 9 }]) {
    await assert.rejects(scheduleTests([{ id: 'a' }],
      { jobs: 2, cpus: 2, unitWorkers: 2, ...invalid }, () => assert.fail('must not execute')));
  }
});
