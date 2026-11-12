// Bounded test-only local protocol. It exposes no SQL, filesystem or command verb.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const PROTOCOL = 'mixed95-control-v1',
  MAX_REQUEST = 4096,
  MAX_REPLY = 8 * 1024 * 1024;
const verbs = new Set(['ready', 'start', 'stop', 'snapshot']);
function request(identity, verb, requestId = randomUUID()) {
  assert.ok(verbs.has(verb));
  return { protocol: PROTOCOL, identity, verb, requestId };
}
function createPhases(identity, handlers) {
  let phase = 'prepared',
    active = false;
  const receipts = new Map();
  async function dispatch(value) {
    assert.deepEqual(Object.keys(value).sort(), ['identity', 'protocol', 'requestId', 'verb']);
    assert.equal(value.protocol, PROTOCOL);
    assert.deepEqual(value.identity, identity);
    assert.match(value.requestId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    assert.ok(verbs.has(value.verb));
    if (receipts.has(value.requestId)) {
      const prior = receipts.get(value.requestId);
      assert.equal(prior.verb, value.verb);
      return prior.reply;
    }
    assert.equal(active, false, 'Control operation already in flight');
    assert.ok(
      (value.verb === 'ready' && phase === 'prepared') ||
        (value.verb === 'start' && phase === 'prepared') ||
        (value.verb === 'stop' && phase === 'running') ||
        (value.verb === 'snapshot' && phase === 'stopped'),
      'Invalid control phase',
    );
    active = true;
    try {
      const result = await handlers[value.verb]();
      if (value.verb === 'start') phase = 'running';
      if (value.verb === 'stop') phase = 'stopped';
      const reply = { protocol: PROTOCOL, identity, requestId: value.requestId, phase, result };
      assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= MAX_REPLY);
      if (receipts.size >= 8) receipts.delete(receipts.keys().next().value);
      receipts.set(value.requestId, { verb: value.verb, reply });
      return reply;
    } catch (error) {
      phase = 'failed';
      throw error;
    } finally {
      active = false;
    }
  }
  return { dispatch, phase: () => phase };
}
function listen(socketPath, phases) {
  if (process.platform !== 'win32')
    assert.equal(fs.existsSync(socketPath), false, 'Never replace a socket');
  const connections = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (connections.size >= 4) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    let bytes = 0,
      body = '',
      consumed = false;
    socket.setTimeout(30000, () => socket.destroy());
    socket.setEncoding('utf8');
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    const consume = async () => {
      if (consumed) return;
      consumed = true;
      try {
        assert.equal(body.indexOf('\n'), body.length - 1);
        const result = await phases.dispatch(JSON.parse(body));
        socket.end(JSON.stringify({ ok: true, reply: result }) + '\n');
      } catch {
        socket.end(JSON.stringify({ ok: false, error: 'Synthetic control rejected' }) + '\n');
      }
    };
    socket.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (consumed || bytes > MAX_REQUEST) {
        consumed = true;
        socket.destroy();
        return;
      }
      body += chunk;
      // One bounded newline frame, without depending on transport half-close.
      // Windows named pipes cannot reliably preserve a response after EOF.
      if (body.includes('\n')) void consume();
    });
    socket.on('end', () => {
      if (!consumed) void consume();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
      resolve({
        server,
        close: () =>
          new Promise((done) => {
            for (const socket of connections) socket.destroy();
            server.close(done);
          }),
      });
    });
  });
}
function call(socketPath, identity, verb) {
  const value = request(identity, verb),
    body = JSON.stringify(value) + '\n';
  assert.ok(Buffer.byteLength(body) <= MAX_REQUEST);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let text = '',
      bytes = 0,
      settled = false;
    const fail = (error) => {
      settled = true;
      reject(error);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(30000, () => socket.destroy(Error('Control timeout')));
    socket.on('error', fail);
    socket.on('close', () => {
      if (!settled) fail(Error('Control closed without a complete receipt'));
    });
    socket.on('connect', () => socket.write(body));
    socket.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REPLY + 1024) {
        socket.destroy(Error('Control response exceeds limit'));
        return;
      }
      text += chunk;
    });
    socket.on('end', () => {
      try {
        const result = JSON.parse(text);
        assert.equal(result.ok, true, 'Background control failed');
        assert.equal(result.reply.protocol, PROTOCOL);
        assert.deepEqual(result.reply.identity, identity);
        assert.equal(result.reply.requestId, value.requestId);
        settled = true;
        resolve(result.reply.result);
      } catch (error) {
        fail(error);
      }
    });
  });
}
module.exports = { PROTOCOL, MAX_REQUEST, MAX_REPLY, request, createPhases, listen, call };
