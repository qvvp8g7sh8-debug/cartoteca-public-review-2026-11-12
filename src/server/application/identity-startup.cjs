// Web workers need identity for link/status APIs, not polling or message delivery.
// Retry only initialization, with one request chain and a capped backoff.
function createIdentityStartup({ initialize }) {
  const controller = new AbortController();
  let started = false,
    connected = false,
    pending = null,
    timer = null,
    delay = 1000;
  function attempt() {
    if (controller.signal.aborted || connected) return pending;
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => (controller.signal.aborted ? null : initialize(controller.signal)))
      .then(
        (result) => {
          connected = result?.connected === true;
        },
        () => {}, // Runtime owns the safe user-visible error; never log provider details here.
      )
      .finally(() => {
        pending = null;
        if (controller.signal.aborted || connected) return;
        timer = setTimeout(() => {
          timer = null;
          void attempt();
        }, delay);
        timer.unref?.();
        delay = Math.min(delay * 2, 60000);
      });
    return pending;
  }
  function start() {
    if (started) return pending;
    started = true;
    return attempt();
  }
  function stop() {
    controller.abort();
    clearTimeout(timer);
    timer = null;
  }
  return { start, stop };
}
module.exports = { createIdentityStartup };
