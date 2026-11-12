const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { actionDeck, PROFILE } = require('./benchmark-mixed92-profile.cjs');
const { collector } = require('./benchmark-mixed92-results.cjs');
function selectIdleActor(pool, preferred, busy) {
  for (let offset = 0; offset < pool.length; offset++) {
    const actor = pool[(preferred + offset) % pool.length];
    if (!busy.has(actor.id)) return { actor, reassigned: offset > 0, scanned: offset + 1 };
  }
  return { actor: null, reassigned: false, scanned: pool.length };
}
async function runSchedule({
  actors,
  seconds,
  rate = PROFILE.actionRate,
  maxInFlight = PROFILE.maxInFlight,
  maxLagMs = PROFILE.maxLagMs,
  action,
  seed = 20261021,
  now = () => performance.now(),
  wait = sleep,
}) {
  assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 600);
  assert.ok(Number.isFinite(rate) && rate > 0 && rate <= 5000);
  assert.ok(Number.isInteger(maxInFlight) && maxInFlight >= 1 && maxInFlight <= 3000);
  assert.ok(Number.isFinite(maxLagMs) && maxLagMs >= 0 && maxLagMs <= 1000);
  assert.ok(actors.length >= 1 && actors.length <= 3000);
  const deck = actionDeck(seed),
    busy = new Set(),
    pending = new Set(),
    results = collector();
  const assistant = actors.filter((actor) => actor.assistant),
    photos = actors.filter((actor) => actor.photo);
  assert.ok(
    assistant.length && photos.length,
    'Active cohort requires enabled assistant and photo readers',
  );
  const started = now(),
    planned = Math.floor(seconds * rate);
  let peak = 0,
    actorReassignments = 0;
  const dropReasons = { late: 0, capacity: 0, noIdleActor: 0 };
  const accounts = new Set(),
    organizations = new Set();
  for (let sequence = 0; sequence < planned; sequence++) {
    const name = deck[sequence % deck.length];
    const pool = name === 'assistant' ? assistant : name.startsWith('photo') ? photos : actors;
    const preferred = Math.floor(sequence / deck.length + sequence) % pool.length;
    const due = started + (sequence * 1000) / rate;
    if (now() < due) await wait(due - now());
    const lagMs = Math.max(0, now() - due);
    if (lagMs > maxLagMs || pending.size >= maxInFlight) {
      dropReasons[lagMs > maxLagMs ? 'late' : 'capacity']++;
      results.record(name, { lagMs, dropped: true });
      continue;
    }
    const selected = selectIdleActor(pool, preferred, busy),
      actor = selected.actor;
    if (selected.reassigned) actorReassignments++;
    if (!actor) {
      dropReasons.noIdleActor++;
      results.record(name, { lagMs, dropped: true });
      continue;
    }
    accounts.add(actor.id);
    organizations.add(actor.org);
    busy.add(actor.id);
    const begin = now();
    const task = Promise.resolve()
      .then(() => action(name, actor, sequence))
      .then(() => results.record(name, { ms: now() - begin, lagMs }))
      .catch((error) =>
        results.record(name, { ms: now() - begin, lagMs, status: error.status || 'error' }),
      )
      .finally(() => {
        busy.delete(actor.id);
        pending.delete(task);
      });
    pending.add(task);
    peak = Math.max(peak, pending.size);
  }
  const stopped = now();
  await Promise.all(pending);
  return {
    offeredActions: planned,
    requestedActionRate: rate,
    activeAccounts: actors.length,
    peakInFlight: peak,
    actorReassignments,
    dropReasons,
    measuredMs: stopped - started,
    drainMs: now() - stopped,
    coveredAccounts: accounts.size,
    coveredOrganizations: organizations.size,
    classes: results.snapshot(),
  };
}
module.exports = { runSchedule, selectIdleActor };
