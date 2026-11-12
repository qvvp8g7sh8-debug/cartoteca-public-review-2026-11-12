'use strict';
// Opt-in owned synthetic stand only; never installed in application/server runtime.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createTestJournalStore } = require('./assistant-test-journal-store.cjs');
const REQUEST_FIELDS = Object.freeze({
  '/api/assistant/turn': [
    'text',
    'policyVersion',
    'dialogueId',
    'dialogueVersion',
    'choice',
    'edit',
    'cancel',
    'newCommand',
  ],
  '/api/assistant/execute': ['executionId', 'policyVersion'],
  '/api/assistant/speak': ['text', 'policyVersion', 'stream', 'format'],
  '/api/assistant/transcribe': [],
});
const SECRET_FIELDS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'apikey',
  'timewebapikey',
  'credentials',
  'headers',
  'secret',
  'token',
  'ticket',
  'audiobase64',
  'audio',
  'streamurl',
]);
function sanitized(value, fields) {
  let redactions = 0,
    nodes = 0;
  function visit(input, depth) {
    if (++nodes > 20000 || depth > 24) {
      redactions++;
      return '[journal structure limit]';
    }
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    if (!input || typeof input !== 'object') return input;
    const out = Object.create(null);
    for (const [key, item] of Object.entries(input)) {
      if (SECRET_FIELDS.has(key.replace(/[-_ ]/gu, '').toLowerCase())) {
        redactions++;
        continue;
      }
      out[key] = visit(item, depth + 1);
    }
    return out;
  }
  let selected = value,
    omitted = 0;
  if (fields) {
    selected = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (fields.includes(key)) selected[key] = item;
      else omitted++;
    }
  }
  return { value: visit(selected, 0), redactions, omittedFields: omitted };
}
function createAssistantTestJournal(options) {
  const store = createTestJournalStore(options),
    bodyLimit = options.bodyBytes ?? 128 * 1024,
    activeLimit = options.activeRequests ?? 16;
  assert(Number.isInteger(bodyLimit) && bodyLimit >= 64 && bodyLimit <= 128 * 1024);
  assert(Number.isInteger(activeLimit) && activeLimit >= 1 && activeLimit <= 64);
  const attached = new WeakSet();
  let requestSequence = 0,
    active = 0,
    captures = 0,
    buffered = 0,
    maximumBuffered = 0,
    overflows = 0;
  function collector(enabled, reason, fields) {
    let chunks = [],
      bytes = 0,
      retained = 0,
      overflow = false,
      complete = false,
      released = false;
    function release() {
      if (released) return;
      buffered -= retained;
      retained = 0;
      chunks = [];
      released = true;
    }
    return {
      add(chunk, encoding) {
        if (!enabled || chunk == null || typeof chunk === 'function') return;
        const size =
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined)
            : chunk instanceof Uint8Array
              ? chunk.byteLength
              : null;
        if (size === null) return;
        bytes += size;
        if (overflow || released) return;
        if (bytes > bodyLimit) {
          overflow = true;
          overflows++;
          release();
          return;
        }
        const value = Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
        chunks.push(value);
        retained += value.length;
        buffered += value.length;
        maximumBuffered = Math.max(maximumBuffered, buffered);
      },
      finish(done) {
        complete ||= done;
        if (!enabled) return { state: 'excluded', reason };
        if (overflow) return { state: 'body-overflow', bytes, limitBytes: bodyLimit, complete };
        if (!complete) {
          release();
          return { state: 'incomplete', bytes };
        }
        const raw = Buffer.concat(chunks);
        release();
        try {
          const value = JSON.parse(raw.toString('utf8'));
          if (!value || Array.isArray(value) || typeof value !== 'object')
            return { state: 'non-object-json', bytes };
          return { state: 'json', bytes, ...sanitized(value, fields) };
        } catch {
          return { state: bytes ? 'malformed-json' : 'empty', bytes };
        }
      },
      release,
    };
  }
  function attach(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://test.invalid').pathname;
    } catch {
      return false;
    }
    if (req.method !== 'POST' || !Object.hasOwn(REQUEST_FIELDS, pathname) || attached.has(req))
      return false;
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.localAddress));
    if (options.port) assert.equal(req.socket.localPort, options.port);
    attached.add(req);
    const requestId = randomUUID(),
      number = ++requestSequence,
      began = performance.now();
    const admitted = captures < activeLimit && store.status().healthy;
    active++;
    if (admitted) captures++;
    let finalized = false,
      requestRecorded = false,
      requestEnded = false,
      requestAborted = false,
      inEnd = false;
    const requestBody = collector(
      admitted && pathname !== '/api/assistant/transcribe',
      admitted ? 'audio-request' : 'active-capture-overflow',
      REQUEST_FIELDS[pathname],
    );
    const responseBody = collector(
      admitted && pathname !== '/api/assistant/speak',
      admitted ? 'speech-response' : 'active-capture-overflow',
    );
    const record = (kind, fields) =>
      store.append({
        kind,
        requestId,
        requestSequence: number,
        elapsedMs: Math.round(performance.now() - began),
        ...fields,
      });
    record('request-start', { method: 'POST', path: pathname, bodyCapture: admitted });
    const oldPush = req.push,
      oldWrite = res.write,
      oldEnd = res.end,
      oldWriteHead = res.writeHead;
    let newPush,
      newWrite,
      newEnd,
      newWriteHead,
      jsonHead = false;
    function requestFinished(done) {
      if (requestRecorded) return;
      requestRecorded = true;
      record('request-body', { body: requestBody.finish(done) });
    }
    if (admitted && pathname !== '/api/assistant/transcribe') {
      newPush = function (...args) {
        if (!finalized) {
          if (args[0] === null) {
            requestEnded = true;
            requestFinished(true);
          } else requestBody.add(args[0], args[1]);
        }
        return Reflect.apply(oldPush, this, args);
      };
      req.push = newPush;
    } else requestFinished(false);
    const isJsonType = (type) =>
      typeof type === 'string' &&
      /^(?:application\/json|application\/problem\+json)(?:;|$)/iu.test(type);
    function jsonResponse() {
      return isJsonType(res.getHeader('Content-Type')) || jsonHead;
    }
    if (admitted && pathname !== '/api/assistant/speak') {
      newWriteHead = function (...args) {
        const returned = Reflect.apply(oldWriteHead, this, args);
        const headers = typeof args[1] === 'string' ? args[2] : args[1];
        if (Array.isArray(headers)) {
          for (let i = 0; i < headers.length; i += 2)
            if (String(headers[i]).toLowerCase() === 'content-type')
              jsonHead = isJsonType(headers[i + 1]);
        } else if (headers && typeof headers === 'object') {
          for (const [key, value] of Object.entries(headers))
            if (key.toLowerCase() === 'content-type') jsonHead = isJsonType(value);
        }
        return returned;
      };
      res.writeHead = newWriteHead;
      newWrite = function (...args) {
        if (!finalized && !inEnd && jsonResponse()) responseBody.add(args[0], args[1]);
        return Reflect.apply(oldWrite, this, args);
      };
      newEnd = function (...args) {
        if (!finalized && jsonResponse()) responseBody.add(args[0], args[1]);
        inEnd = true;
        try {
          return Reflect.apply(oldEnd, this, args);
        } finally {
          inEnd = false;
        }
      };
      res.write = newWrite;
      res.end = newEnd;
    }
    const aborted = () => {
      requestAborted = true;
      requestFinished(false);
    };
    function finish() {
      if (finalized) return;
      finalized = true;
      const complete = Boolean(res.writableFinished);
      requestFinished(requestEnded || req.complete);
      record('response', {
        status: res.headersSent ? res.statusCode : null,
        complete,
        requestAborted,
        response:
          admitted && pathname !== '/api/assistant/speak' && !jsonResponse()
            ? { state: 'excluded', reason: 'non-json-response' }
            : responseBody.finish(complete),
      });
      requestBody.release();
      responseBody.release();
      active--;
      if (admitted) captures--;
      if (req.push === newPush) req.push = oldPush;
      if (res.write === newWrite) res.write = oldWrite;
      if (res.end === newEnd) res.end = oldEnd;
      if (res.writeHead === newWriteHead) res.writeHead = oldWriteHead;
      req.removeListener('aborted', aborted);
      res.removeListener('finish', finish);
      res.removeListener('close', finish);
    }
    req.once('aborted', aborted);
    res.once('finish', finish);
    res.once('close', finish);
    return true;
  }
  function status() {
    return {
      ...store.status(),
      requestSequence,
      activeRequests: active,
      activeBodyCaptures: captures,
      bufferedBytes: buffered,
      maximumBufferedBytes: maximumBuffered,
      bodyLimit,
      activeLimit,
      bodyOverflows: overflows,
    };
  }
  return { attach, status, close: () => store.close(), directory: store.directory };
}
module.exports = { createAssistantTestJournal };
