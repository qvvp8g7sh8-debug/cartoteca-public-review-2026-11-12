// Executable entrypoints own process termination; the reusable server only
// emits backgroundError after failing closed. Never restart work in place.
function createEntrypointLifecycle({
  process: runtime = process,
  setTimeout: defer = setTimeout,
  clearTimeout: cancel = clearTimeout,
} = {}) {
  let server,
    stopping = false,
    finished = false,
    code = 0,
    deadline;
  function finish() {
    if (finished) return;
    finished = true;
    cancel(deadline);
    runtime.exit(code);
  }
  function stop(exitCode = 0, fatalDuringClose = false) {
    if (stopping) {
      if (exitCode && fatalDuringClose) {
        code = exitCode;
        runtime.exitCode = exitCode;
      }
      return;
    }
    stopping = true;
    code = exitCode;
    runtime.exitCode = code;
    // Keep this timer referenced: even an unresponsive close must terminate
    // so the supervisor/cluster can replace an unhealthy background owner.
    deadline = defer(finish, 5000);
    if (!server) return finish();
    server.once('close', finish);
    try {
      server.close(finish);
    } catch {
      finish();
    }
  }
  runtime.on('SIGINT', () => stop());
  runtime.on('SIGTERM', () => stop());
  runtime.on('message', (message) => {
    if (message === 'stop') stop();
  });
  return {
    stop,
    attach(value) {
      server = value;
      if (stopping) {
        server.close();
        return false;
      }
      server.on('backgroundError', (error) => stop(1, error?.code === 'NATIVE_SHUTDOWN_FAILED'));
      return true;
    },
  };
}

module.exports = { createEntrypointLifecycle };
