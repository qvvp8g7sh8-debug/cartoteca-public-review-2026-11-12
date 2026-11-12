// Millisecond histograms are bounded independently of run length. No account or token labels.
const { SLO, SLO_P99 } = require('./benchmark-mixed92-profile.cjs');
function histogram() {
  const buckets = new Map();
  let count = 0,
    sum = 0,
    max = 0;
  return {
    add(value) {
      if (!Number.isFinite(value) || value < 0) throw Error('Invalid latency');
      const bucket = Math.min(120000, Math.ceil(value));
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
      count++;
      sum += value;
      max = Math.max(max, value);
    },
    snapshot() {
      const rows = [...buckets].sort(([a], [b]) => a - b);
      const percentile = (q) => {
        let n = 0;
        const target = Math.ceil(count * q);
        for (const [ms, amount] of rows) {
          n += amount;
          if (n >= target) return ms;
        }
        return null;
      };
      return {
        count,
        meanMs: count ? sum / count : null,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        maxMs: max,
        overflowMs: max > 120000,
        resolutionMs: 1,
      };
    },
  };
}
function collector() {
  const groups = new Map();
  function row(name) {
    if (!groups.has(name))
      groups.set(name, {
        latency: histogram(),
        scheduledLatency: histogram(),
        lag: histogram(),
        attempted: 0,
        completed: 0,
        errors: 0,
        drops: 0,
        bytes: 0,
        statuses: {},
      });
    return groups.get(name);
  }
  return {
    record(name, { ms = 0, lagMs = 0, status = 200, bytes = 0, dropped = false } = {}) {
      const group = row(name);
      group.attempted++;
      group.lag.add(lagMs);
      if (dropped) {
        group.drops++;
        return;
      }
      group.completed++;
      group.latency.add(ms);
      group.scheduledLatency.add(ms + lagMs);
      group.bytes += bytes;
      group.statuses[status] = (group.statuses[status] || 0) + 1;
      if (status !== 200 && status !== 304) group.errors++;
    },
    snapshot() {
      return Object.fromEntries(
        [...groups].map(([name, group]) => [
          name,
          {
            attempted: group.attempted,
            completed: group.completed,
            errors: group.errors,
            drops: group.drops,
            bytes: group.bytes,
            statuses: { ...group.statuses },
            latency: group.latency.snapshot(),
            scheduledLatency: group.scheduledLatency.snapshot(),
            lag: group.lag.snapshot(),
            proposedP95Ms: SLO[name] || null,
            proposedP99Ms: SLO_P99[name] || null,
            withinProposedSlo: Boolean(
              group.completed &&
              !group.errors &&
              !group.drops &&
              (!SLO[name] || group.scheduledLatency.snapshot().p95Ms <= SLO[name]) &&
              (!SLO_P99[name] || group.scheduledLatency.snapshot().p99Ms <= SLO_P99[name]),
            ),
          },
        ]),
      );
    },
  };
}
function notificationCorrectness(snapshot) {
  const channels = ['telegram', 'max', 'push'];
  return Boolean(
    snapshot &&
    snapshot.inFlight === 0 &&
    channels.every((name) => {
      const channel = snapshot.counters?.[name];
      return (
        channel &&
        channel.acknowledged > 0 &&
        channel.attempts === channel.acknowledged &&
        channel.failures === 0 &&
        channel.aborted === 0 &&
        channel.duplicates === 0 &&
        channel.unknownRecipients === 0
      );
    }),
  );
}
module.exports = { histogram, collector, notificationCorrectness };
