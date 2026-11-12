const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { markerName, readRuntime } = require('./runtime.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const defaultSocketPath = '/tmp/cartoteca-postgres-readiness.sock';

function technicalReadiness(status) {
  const owner = status?.owner,
    queries = status?.queries;
  const child = (value) =>
    Boolean(
      value?.ready === true &&
      value.exited === false &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0,
    );
  return closedProof({
    gateway: { open: status?.closeState === 'open' && owner?.state === 'ready' },
    children: { web: child(owner?.application), background: child(owner?.background) },
    queries: {
      configured: queries?.limits?.concurrency,
      ready: queries?.readyWorkers,
      closed: queries?.closed,
    },
  });
}
function closedProof(value, profileMatches = true) {
  const configured = value?.queries?.configured,
    ready = value?.queries?.ready;
  const counts =
    Number.isSafeInteger(configured) &&
    configured > 0 &&
    configured <= 16 &&
    Number.isSafeInteger(ready) &&
    ready >= 0 &&
    ready <= configured;
  const gateway = { open: value?.gateway?.open === true };
  const children = {
    web: value?.children?.web === true,
    background: value?.children?.background === true,
  };
  const queries = {
    configured: counts ? configured : 0,
    ready: counts ? ready : 0,
    closed: value?.queries?.closed !== false,
  };
  return {
    version: 1,
    backend: 'postgres',
    ready: Boolean(
      profileMatches &&
      gateway.open &&
      children.web &&
      children.background &&
      counts &&
      ready === configured &&
      !queries.closed,
    ),
    profileMatches,
    gateway,
    children,
    queries,
  };
}
function socketFile(filename, required) {
  if (
    process.platform !== 'linux' ||
    typeof filename !== 'string' ||
    filename.includes('\0') ||
    !path.isAbsolute(filename) ||
    Buffer.byteLength(filename) > 100 ||
    fs.realpathSync(path.dirname(filename)) !== path.dirname(filename)
  )
    throw Error('POSTGRES_READINESS_SOCKET_INVALID');
  let info;
  try {
    info = fs.lstatSync(filename);
  } catch (error) {
    if (error.code !== 'ENOENT' || required) throw error;
  }
  if (info && (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid()))
    throw Error('POSTGRES_READINESS_SOCKET_INVALID');
  return info;
}
function markerStamp(filename) {
  const info = fs.lstatSync(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw Error('POSTGRES_READINESS_ASSETS_INVALID');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}
async function attachPostgresReadiness(server, { socketPath = defaultSocketPath, dataDir } = {}) {
  if (typeof server?.isolationStatus !== 'function' || socketFile(socketPath, false))
    throw Error('POSTGRES_READINESS_SOCKET_EXISTS');
  const markerFile = path.join(path.resolve(dataDir), markerName),
    stamp = markerStamp(markerFile);
  const markerHash = digest(readRuntime(dataDir));
  if (stamp !== markerStamp(markerFile)) throw Error('POSTGRES_READINESS_ASSETS_CHANGED');
  const peers = new Set();
  const control = net.createServer((peer) => {
    peers.add(peer);
    peer.once('close', () => peers.delete(peer));
    peer.setTimeout(1500, () => peer.destroy());
    let input = Buffer.alloc(0),
      done = false;
    peer.on('error', () => {});
    peer.on('data', (chunk) => {
      if (done || input.length + chunk.length > 128) return peer.destroy();
      input = Buffer.concat([input, chunk]);
      if (!input.includes(10)) return;
      done = true;
      const match = /^CARTOTECA_READY_V1 ([a-f0-9]{32}) ([a-f0-9]{64})\n$/.exec(
        input.toString('utf8'),
      );
      if (!match) return peer.destroy();
      try {
        const matches = match[2] === markerHash && markerStamp(markerFile) === stamp;
        peer.end(
          JSON.stringify({
            ...closedProof(technicalReadiness(server.isolationStatus()), matches),
            nonce: match[1],
            observedAt: Date.now(),
          }) + '\n',
        );
      } catch {
        peer.destroy();
      }
    });
  });
  control.maxConnections = 8;
  let identity, closing;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const peer of peers) peer.destroy();
      if (control.listening)
        await new Promise((resolve, reject) =>
          control.close((error) => (error ? reject(error) : resolve())),
        );
      // net.Server removes its socket; never unlink a replacement.
      let current;
      try {
        current = fs.lstatSync(socketPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (
        identity &&
        current &&
        current.ino === identity.ino &&
        current.dev === identity.dev &&
        current.isSocket()
      )
        fs.unlinkSync(socketPath);
    })();
    return closing;
  }
  try {
    await new Promise((resolve, reject) => {
      const failed = (error) => {
        control.removeListener('listening', listening);
        reject(error);
      };
      const listening = () => {
        control.removeListener('error', failed);
        resolve();
      };
      control.once('error', failed);
      control.once('listening', listening);
      control.listen(socketPath);
    });
    identity = socketFile(socketPath, true);
    fs.chmodSync(socketPath, 0o600);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  control.on('error', () => {
    server.emit('backgroundError', Error('POSTGRES_READINESS_UNAVAILABLE'));
    void close().catch(() => {});
  });
  server.once('close', () => {
    void close().catch(() => {});
  });
  if (server.isolationStatus().closeState !== 'open') {
    await close();
    throw Error('POSTGRES_READINESS_UNAVAILABLE');
  }
  return { close };
}
async function readPostgresReadiness({
  socketPath = defaultSocketPath,
  timeoutMs = 2500,
  markerHash,
} = {}) {
  const info = socketFile(socketPath, true);
  if (
    (info.mode & 0o777) !== 0o600 ||
    !/^[a-f0-9]{64}$/.test(markerHash || '') ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10000
  )
    throw Error('POSTGRES_READINESS_SOCKET_INVALID');
  const nonce = randomBytes(16).toString('hex'),
    started = Date.now();
  return new Promise((resolve, reject) => {
    const peer = net.createConnection(socketPath);
    let input = Buffer.alloc(0),
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      peer.destroy();
      error ? reject(error) : resolve(value);
    };
    peer.setTimeout(timeoutMs, () => finish(Error('POSTGRES_READINESS_TIMEOUT')));
    peer.once('error', () => finish(Error('POSTGRES_READINESS_UNAVAILABLE')));
    peer.once('close', () => {
      if (!settled) finish(Error('POSTGRES_READINESS_UNAVAILABLE'));
    });
    peer.once('connect', () => peer.write('CARTOTECA_READY_V1 ' + nonce + ' ' + markerHash + '\n'));
    peer.on('data', (chunk) => {
      if (input.length + chunk.length > 2048) return finish(Error('POSTGRES_READINESS_INVALID'));
      input = Buffer.concat([input, chunk]);
    });
    peer.once('end', () => {
      try {
        const result = JSON.parse(input.toString('utf8'));
        if (
          result.version !== 1 ||
          result.backend !== 'postgres' ||
          result.nonce !== nonce ||
          typeof result.profileMatches !== 'boolean' ||
          !Number.isSafeInteger(result.observedAt) ||
          result.observedAt < started - 1000 ||
          result.observedAt > Date.now() + 1000
        )
          throw Error('POSTGRES_READINESS_INVALID');
        finish(null, closedProof(result, result.profileMatches));
      } catch {
        finish(Error('POSTGRES_READINESS_INVALID'));
      }
    });
  });
}
module.exports = {
  defaultSocketPath,
  technicalReadiness,
  attachPostgresReadiness,
  readPostgresReadiness,
};
