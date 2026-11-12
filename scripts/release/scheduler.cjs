const assert = require('node:assert/strict');

// Top-level jobs are not processes: a unit job already owns several workers.
// Keep the short, time-bounded UI smoke out of contention on a two-core VM.
function resources(step, { cpus, unitWorkers }) {
  const workers = step.id === 'unit' || step.id.startsWith('unit-') ? unitWorkers : 1;
  return Math.min(cpus, step.earlyBrowser ? Math.max(2, workers) : workers);
}

async function scheduleTests(steps, { jobs, cpus, unitWorkers }, execute, signal) {
  assert.ok(Number.isInteger(jobs) && jobs >= 1 && jobs <= 4, 'Invalid job limit');
  assert.ok(Number.isInteger(cpus) && cpus >= 1, 'Invalid CPU budget');
  assert.ok(Number.isInteger(unitWorkers) && unitWorkers >= 1 && unitWorkers <= 8,
    'Invalid unit worker budget');
  const queue = [
    ...steps.filter(step => step.earlyBrowser),
    ...steps.filter(step => !step.earlyBrowser),
  ];
  const active = new Set();
  let next = 0, used = 0, failure;
  while (next < queue.length || active.size) {
    while (!failure && !signal?.aborted && next < queue.length && active.size < jobs) {
      const step = queue[next], weight = resources(step, { cpus, unitWorkers });
      // Do not leapfrog an expensive waiting job with a stream of cheaper jobs.
      if (used + weight > cpus) break;
      next++; used += weight;
      let task;
      task = Promise.resolve().then(() => execute(step)).catch(error => {
        failure ||= error;
      }).finally(() => {
        used -= weight;
        active.delete(task);
      });
      active.add(task);
    }
    if (!active.size) break;
    await Promise.race(active);
  }
  if (failure) throw failure;
}

module.exports = { resources, scheduleTests };
