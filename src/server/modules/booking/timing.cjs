const { performance } = require('node:perf_hooks');

// Fixed phase names only; never record organization, input or contact data.
function bookingTiming(context, phase, callback) {
  if (!context.recordTiming) return callback();
  const started = performance.now();
  try {
    return callback();
  } finally {
    try {
      context.recordTiming(phase, performance.now() - started);
    } catch {
      /* Diagnostics must not change the booking result. */
    }
  }
}
async function bookingTimingAsync(context, phase, callback) {
  const started = performance.now();
  let failed = true;
  try {
    const result = await callback();
    failed = false;
    return result;
  } finally {
    try {
      context.recordTiming?.(phase, performance.now() - started, failed);
    } catch {}
  }
}
module.exports = { bookingTiming, bookingTimingAsync };
