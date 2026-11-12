const { performance } = require('node:perf_hooks');
const { setImmediate } = require('node:timers');
const { fail } = require('../../../../../shared/errors.cjs');
const { assertSignal, waitForAbort } = require('../../buffered-request.cjs');
const PACKET_BYTES = 4096;
const PACKET_WAIT_MS = 20;
// Network fragmentation is not an authorization boundary. Only this bounded
// small-fragment packet leaves the reader; already large chunks pass through
// under the unchanged whole-stream byte ceiling, without multiplying guards.
function createSpeechPackets(reader, signal, cancel, maxBytes) {
  let pending,
    source,
    offset = 0,
    total = 0,
    ended = false,
    first = true,
    reads = 0;
  function read() {
    if (!pending)
      pending = waitForAbort(
        Promise.resolve()
          .then(() => reader.read())
          .then((result) => {
            if (result.done) return result;
            if (!(result.value instanceof Uint8Array))
              throw fail(502, 'Провайдер вернул некорректный аудиопоток.');
            total += result.value.byteLength;
            if (total > maxBytes) throw fail(502, 'Аудио провайдера превышает ограничение.');
            return result;
          }),
        signal,
        { onAbort: cancel },
      );
    return pending;
  }
  return async function next() {
    assertSignal(signal);
    const bytes = Buffer.allocUnsafe(PACKET_BYTES);
    let used = 0,
      deadline = performance.now() + PACKET_WAIT_MS;
    while (used < PACKET_BYTES) {
      assertSignal(signal);
      if (source) {
        if (source.byteLength - offset >= PACKET_BYTES) {
          if (used) break; // Send the accumulated prefix, then the original large chunk.
          const value = source.subarray(offset);
          source = null;
          offset = 0;
          first = false;
          return { done: false, value };
        }
        const count = Math.min(source.byteLength - offset, PACKET_BYTES - used);
        bytes.set(source.subarray(offset, offset + count), used);
        offset += count;
        used += count;
        if (offset === source.byteLength) {
          source = null;
          offset = 0;
        }
        // Preserve the original immediate start, without waiting to fill a packet.
        if (first || used === PACKET_BYTES) break;
      }
      if (ended) break;
      const remaining = deadline - performance.now();
      if (used && remaining <= 0) break;
      const waiting = read();
      let result, timer;
      if (used) {
        try {
          result = await Promise.race([
            waiting,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), remaining);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (result === null) break; // Retain the same pending read, never read twice.
      } else result = await waiting;
      pending = null;
      assertSignal(signal);
      if (result.done) {
        ended = true;
        break;
      }
      source = result.value;
      if (!source.byteLength) source = null;
      // Even a hostile run of immediately resolved empty fragments must allow
      // cancellation and the request deadline to run on the event loop.
      if (++reads % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    if (used) {
      first = false;
      return { done: false, value: bytes.subarray(0, used) };
    }
    return { done: ended };
  };
}
module.exports = { createSpeechPackets, PACKET_BYTES, PACKET_WAIT_MS };
