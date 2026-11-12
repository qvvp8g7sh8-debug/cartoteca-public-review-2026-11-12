const path = require('node:path');
const { fork } = require('node:child_process');
// Same actual isolated-server child and bounded RPC lifecycle as memory139.
function gateway(t, processPlan) {
  const child = fork(path.join(__dirname, 'native-query-workers177-server.cjs'), [], {
    execArgv: [...processPlan.execArgv],
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const pending = new Map();
  let sequence = 0,
    closed = false,
    stdoutBytes = 0,
    stderrBytes = 0;
  const exit = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      closed = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(Error('Managed gateway closed before reply.'));
      }
      pending.clear();
      resolve({ code, signal });
    }),
  );
  for (const [stream, count] of [
    [child.stdout, 'stdout'],
    [child.stderr, 'stderr'],
  ]) {
    stream.on('data', (bytes) => {
      if (count === 'stdout') stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (stdoutBytes > 65536 || stderrBytes > 65536) child.kill();
    });
  }
  child.on('error', (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  });
  child.on('message', (message) => {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.type === 'failed')
      item.reject(Object.assign(Error('Managed startup refused.'), { code: message.code }));
    else item.resolve(message);
  });
  function rpc(type, config, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Managed IPC deadline.'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, type, ...(config ? { config } : {}) }, (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    });
  }
  async function close() {
    if (!closed) await rpc('close', undefined, 5000).catch(() => child.kill());
    let timer;
    try {
      const result = await Promise.race([
        exit,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 5000);
        }),
      ]);
      if (!result) {
        child.kill();
        await exit;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  t.after(close);
  return { rpc, exit, close, pid: child.pid };
}
module.exports = { gateway };
