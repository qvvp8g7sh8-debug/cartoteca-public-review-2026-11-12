// Server-side maintenance remains active with all browser tabs closed.
// Manual tick stays synchronous; managed work admits one organization at a time.
function createBookingPublicationRuntime({
  publication,
  clock = Date.now,
  canRun = () => true,
  runBackgroundWork = (callback) => callback(),
}) {
  let timer = null,
    cursor = '',
    running = false,
    epoch = 0;
  function tick() {
    if (!canRun()) return { cursor, skipped: true };
    const result = publication.reconcileBatch(cursor, 10, clock());
    cursor = result.cursor;
    return result;
  }
  async function tickManaged(canContinue = canRun) {
    const generation = epoch;
    const active = () => generation === epoch && canContinue();
    for (let i = 0; i < 10 && active(); i++) {
      const result = await runBackgroundWork(
        () => {
          if (!active()) return null;
          const next = publication.reconcileBatch(cursor, 1, clock());
          cursor = next.cursor;
          return next;
        },
        '',
        active,
      );
      if (!result || !cursor) break;
    }
    return { cursor };
  }
  async function run(generation) {
    const active = () => running && generation === epoch && canRun();
    if (!running || generation !== epoch) return;
    let delay = 30000;
    try {
      await tickManaged(active);
      if (cursor) delay = 20;
    } catch {
      // Failure is not an empty schedule. Retry without changing any flags.
      delay = 5000;
    }
    if (!running || generation !== epoch) return;
    timer = setTimeout(() => {
      void run(generation);
    }, delay);
    timer.unref?.();
  }
  function start() {
    if (running) return;
    running = true;
    const generation = ++epoch;
    timer = setTimeout(() => {
      void run(generation);
    }, 0);
    timer.unref?.();
  }
  function stop() {
    running = false;
    epoch++;
    clearTimeout(timer);
    timer = null;
    cursor = '';
  }
  return { start, stop, tick, tickManaged };
}
module.exports = { createBookingPublicationRuntime };
