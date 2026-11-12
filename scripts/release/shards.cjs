const fs = require('node:fs');
const path = require('node:path');

// Timings guide placement only. Every discovered test is always assigned exactly once.
function splitTests(root, files, target, count) {
  if (!Number.isInteger(count) || count < 1 || count > 8) throw Error('Invalid unit shard count');
  if (count > files.length) throw Error('More shards than test files');
  const timings = JSON.parse(fs.readFileSync(path.join(root, 'scripts/release/unit-timings.json')));
  const weights = timings.targets[target] || {};
  const known = Object.values(weights)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  const fallback = known[Math.floor(known.length / 2)] || 1000;
  const weight = (name) =>
    Number.isFinite(weights[name]) && weights[name] > 0 ? weights[name] : fallback;
  const shards = Array.from({ length: count }, () => ({ files: [], estimatedMs: 0 }));
  for (const name of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, 'en'))) {
    const shard = shards.reduce((a, b) => (a.estimatedMs <= b.estimatedMs ? a : b));
    shard.files.push(name);
    shard.estimatedMs += weight(name);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

function parts(plan) {
  const result = [{ id: 'quality', steps: plan.filter((s) => s.phase === 'quality') }];
  for (const step of plan.filter((s) => s.id === 'unit' || s.id.startsWith('unit-')))
    result.push({ id: step.id, steps: [step] });
  for (const step of plan.filter((s) => s.browserCoverage)) {
    const id = 'browser-' + step.browserCoverage.engine + '-' + step.id.split('-').at(-1);
    let part = result.find((p) => p.id === id);
    if (!part) result.push((part = { id, steps: [] }));
    part.steps.push(step);
  }
  return result;
}

function selectPart(plan, id) {
  const part = parts(plan).find((p) => p.id === id);
  if (!part) throw Error('Unknown verification part');
  return part.steps;
}

module.exports = { splitTests, parts, selectPart };
