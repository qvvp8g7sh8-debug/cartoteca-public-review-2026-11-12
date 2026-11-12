const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { actionPlan, actorOrder } = require('./benchmark-organizations-profile.cjs');
const {
  failureDetails,
  createFailureSummary,
} = require('./benchmark-organizations-diagnostics.cjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Open-loop has no waiting queue. Missed arrivals and busy accounts remain visible as drops.
async function runSchedule({
  mode,
  actors,
  seconds,
  concurrent = 20,
  rate = 40,
  seed = 20261012,
  action,
  now = () => performance.now(),
  sleep = pause,
}) {
  assert.ok(['typical', 'busy', 'smoke', 'diagnostic', 'fixed', 'open'].includes(mode));
  assert.ok(seconds >= 3 && seconds <= 3600);
  assert.ok(Number.isInteger(concurrent) && concurrent >= 1 && concurrent <= 200);
  assert.ok(Number.isFinite(rate) && rate >= 1 && rate <= 200);
  const order = actorOrder(actors.length, seed),
    start = now(),
    deadline = start + seconds * 1000;
  const active = new Set(),
    busy = new Set(),
    durations = [],
    failures = [],
    diagnostics = createFailureSummary();
  const counts = {
    offered: 0,
    started: 0,
    completed: 0,
    droppedAtLimit: 0,
    droppedBusyAccount: 0,
    missedGeneratorSchedule: 0,
    peakActions: 0,
    plannedRoutes: {},
    startedRoutes: {},
  };
  let cursor = 0;
  async function invoke(sequence, actorIndex, scheduledAt) {
    const name = actionPlan(sequence),
      user = actors[actorIndex];
    counts.started++;
    counts.startedRoutes[name] = (counts.startedRoutes[name] || 0) + 1;
    busy.add(user.id);
    counts.peakActions = Math.max(counts.peakActions, busy.size);
    try {
      await action(name, user, actorIndex, sequence);
    } catch (error) {
      const detail = failureDetails(error, { route: name, stage: 'action' });
      diagnostics.addDetails(detail);
      failures.push(
        detail.httpStatus !== null && detail.httpStatus !== 200
          ? 'HTTP ' + detail.httpStatus
          : detail.name,
      );
    } finally {
      busy.delete(user.id);
      counts.completed++;
      durations.push(now() - scheduledAt);
    }
  }
  function plan(sequence) {
    const name = actionPlan(sequence);
    counts.offered++;
    counts.plannedRoutes[name] = (counts.plannedRoutes[name] || 0) + 1;
  }
  if (mode === 'open') {
    const interval = 1000 / rate,
      planned = Math.floor(seconds * rate);
    for (let sequence = 0; sequence < planned; sequence++) {
      const due = start + sequence * interval;
      if (now() < due) await sleep(due - now());
      plan(sequence);
      if (now() - due >= interval) {
        counts.missedGeneratorSchedule++;
        continue;
      }
      const actorIndex = order[sequence % order.length];
      if (active.size >= concurrent) {
        counts.droppedAtLimit++;
        continue;
      }
      if (busy.has(actors[actorIndex].id)) {
        counts.droppedBusyAccount++;
        continue;
      }
      const pending = invoke(sequence, actorIndex, due);
      active.add(pending);
      pending.finally(() => active.delete(pending));
    }
    if (now() < deadline) await sleep(deadline - now());
    await Promise.all(active);
  } else if (mode === 'fixed') {
    await Promise.all(
      Array.from({ length: Math.min(concurrent, actors.length) }, async () => {
        while (now() < deadline) {
          const sequence = cursor++,
            actorIndex = order[sequence % order.length];
          plan(sequence);
          if (busy.has(actors[actorIndex].id)) {
            counts.droppedBusyAccount++;
            await sleep(1);
            continue;
          }
          await invoke(sequence, actorIndex, now());
        }
      }),
    );
  } else {
    await Promise.all(
      actors.map(async (_, actorIndex) => {
        await sleep((actorIndex * 5000) / actors.length);
        while (now() < deadline) {
          const due = now(),
            sequence = cursor++;
          plan(sequence);
          await invoke(sequence, actorIndex, due);
          await sleep(Math.max(0, Math.min(due + 5000, deadline) - now()));
        }
      }),
    );
  }
  return {
    ...counts,
    elapsedMs: now() - start,
    failures,
    failureDiagnostics: diagnostics.snapshot(),
    durations,
    model: mode === 'open' ? 'bounded-open-loop-no-queue' : 'closed-loop',
    seed,
    targetActionsPerSecond: mode === 'open' ? rate : null,
    maximumConcurrentActions: mode === 'open' || mode === 'fixed' ? concurrent : actors.length,
  };
}
module.exports = { runSchedule };
