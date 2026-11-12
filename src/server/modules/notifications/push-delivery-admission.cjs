const { performance } = require('node:perf_hooks');
const limits = Object.freeze({
  active: 4,
  organization: 2,
  starts: 10,
  burstMs: 8,
  cpuShare: 0.25,
});
const add = (value, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + Math.max(0, amount));
function createPushDeliveryAdmission({ monotonic = () => performance.now() } = {}) {
  const held = new Map();
  let credit = limits.burstMs,
    last = monotonic(),
    peakActive = 0,
    syncWorkMs = 0,
    budgetYields = 0;
  function refill() {
    const now = monotonic();
    credit = Math.min(limits.burstMs, credit + Math.max(0, now - last) * limits.cpuShare);
    last = now;
    return now;
  }
  function measure(work) {
    const start = refill();
    try {
      return work();
    } finally {
      const end = monotonic(),
        cost = Math.max(0, end - start);
      // A native synchronous call cannot be preempted. Carry its observed debt
      // into subsequent turns instead of granting another burst after an overrun.
      credit = Math.min(limits.burstMs, credit - cost + Math.max(0, end - last) * limits.cpuShare);
      last = end;
      syncWorkMs = add(syncWorkMs, cost);
    }
  }
  function delay() {
    refill();
    return credit > 0 ? 0 : Math.max(1, Math.ceil((0.25 - credit) / limits.cpuShare));
  }
  function exclusions() {
    const organizations = new Map();
    for (const job of held.values())
      organizations.set(job.organization_id, (organizations.get(job.organization_id) || 0) + 1);
    return {
      excludeDevices: [...held.keys()],
      excludeOrganizations: [...organizations]
        .filter(([, n]) => n >= limits.organization)
        .map(([id]) => id),
    };
  }
  function hold(job) {
    const blocked = exclusions();
    if (
      typeof job.device_id !== 'string' ||
      !job.device_id ||
      typeof job.organization_id !== 'string' ||
      !job.organization_id ||
      held.size >= limits.active ||
      blocked.excludeDevices.includes(job.device_id) ||
      blocked.excludeOrganizations.includes(job.organization_id)
    )
      throw Error('Invalid managed Push admission.');
    const token = {};
    held.set(job.device_id, { ...job, token });
    peakActive = Math.max(peakActive, held.size);
    return () => {
      if (held.get(job.device_id)?.token === token) held.delete(job.device_id);
    };
  }
  return {
    measure,
    delay,
    exclusions,
    hold,
    get active() {
      return held.size;
    },
    yield: () => {
      budgetYields = add(budgetYields);
    },
    stats: () => ({
      active: held.size,
      peakActive,
      activeOrganizations: new Set([...held.values()].map((j) => j.organization_id)).size,
      syncWorkMs: Math.round(syncWorkMs * 1000) / 1000,
      budgetYields,
    }),
  };
}
module.exports = { createPushDeliveryAdmission, limits, add };
