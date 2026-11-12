const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { fail } = require('../../shared/errors.cjs');
const { transportHeader, addressHeader, portHeader } = require('./internal-ingress.cjs');
const { ticketHeader, ticketPattern } = require('../infrastructure/native-command-ticket.cjs');
const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
function forwardHeaders(headers) {
  const excluded = new Set(hopHeaders);
  for (const name of String(headers.connection || '').split(','))
    excluded.add(name.trim().toLowerCase());
  const result = {};
  for (const [name, value] of Object.entries(headers))
    if (!excluded.has(name) && !name.startsWith('x-cartoteca-native-')) result[name] = value;
  return result;
}
// No JSON decoding, buffering or replay. A failed write keeps its original
// operation ID and remains unknown until the normal receipt API reconciles it.
function createNativeProxy({
  endpoint,
  activeLimit = 64,
  pendingLimit = 128,
  waitMs = 5000,
  timeoutMs = 120000,
  now = () => performance.now(),
}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: activeLimit, maxFreeSockets: 8 });
  const waiting = [];
  const running = new Set();
  let closed = false;
  function advance() {
    while (!closed && running.size < activeLimit && waiting.length) {
      const entry = waiting.shift();
      clearTimeout(entry.timer);
      if (now() >= entry.deadline)
        entry.reject(fail(503, 'Сервер временно занят. Повторите запрос.'));
      else if (!entry.res.destroyed && !entry.req.aborted) {
        try {
          start(entry);
        } catch (error) {
          entry.reject(error);
        }
      } else entry.reject(fail(499, 'Запрос отменён.'));
    }
  }
  function start(entry) {
    const { req, res, resolve, reject } = entry;
    const headers = forwardHeaders(req.headers);
    const target = endpoint();
    if (target.commandTicket !== undefined) {
      if (!ticketPattern.test(target.commandTicket)) throw Error('Invalid private command ticket.');
      headers[ticketHeader] = target.commandTicket;
    }
    headers[transportHeader] = target.transportToken;
    headers[addressHeader] = req.socket.remoteAddress;
    headers[portHeader] = String(req.socket.localPort);
    let finished = false;
    const upstream = http.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      agent,
      timeout: timeoutMs,
    });
    running.add(upstream);
    const done = (error) => {
      if (finished) return;
      finished = true;
      req.unpipe(upstream);
      req.removeListener('aborted', abort);
      req.removeListener('error', abort);
      res.removeListener('close', abort);
      running.delete(upstream);
      if (error) {
        upstream.destroy();
        reject(error);
      } else resolve();
      advance();
    };
    const abort = () => done(fail(499, 'Запрос отменён.'));
    req.once('aborted', abort);
    req.once('error', abort);
    res.once('close', abort);
    upstream.once('timeout', () =>
      done(fail(504, 'Время ожидания истекло. Проверьте результат операции.')),
    );
    upstream.once('error', () =>
      done(fail(502, 'Не удалось получить ответ. Проверьте результат операции.')),
    );
    upstream.once('response', (response) => {
      res.writeHead(response.statusCode, forwardHeaders(response.headers));
      response.once('error', () => {
        res.destroy();
        done(fail(502, 'Ответ прерван.'));
      });
      response.once('aborted', () => {
        res.destroy();
        done(fail(502, 'Ответ прерван.'));
      });
      // Hold the admission slot until the slow client has actually drained.
      res.once('finish', () => done());
      response.pipe(res);
    });
    req.pipe(upstream);
    req.resume();
  }
  return {
    run(req, res) {
      req.pause();
      return new Promise((resolve, reject) => {
        if (closed) return reject(fail(503, 'Сервер останавливается.'));
        const entry = { req, res, resolve, reject, deadline: now() + waitMs };
        if (running.size < activeLimit) return start(entry);
        if (waiting.length >= pendingLimit) return reject(fail(503, 'Сервер временно занят.'));
        entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index < 0) return;
          waiting.splice(index, 1);
          reject(fail(503, 'Сервер временно занят. Повторите запрос.'));
        }, waitMs);
        entry.timer.unref?.();
        waiting.push(entry);
      });
    },
    close() {
      closed = true;
      for (const entry of waiting.splice(0)) {
        clearTimeout(entry.timer);
        entry.reject(fail(503, 'Сервер останавливается.'));
      }
      for (const request of running) request.destroy();
      agent.destroy();
    },
    stats: () => ({ active: running.size, pending: waiting.length, activeLimit, pendingLimit }),
  };
}
module.exports = { createNativeProxy, forwardHeaders };
