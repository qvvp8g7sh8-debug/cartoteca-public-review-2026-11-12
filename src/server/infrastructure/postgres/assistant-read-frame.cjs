const { fail } = require('../../../shared/errors.cjs');
const { assistantProjection } = require('./assistant-read-projection.cjs');

// Values live only in one physical READ ONLY snapshot. No value or authority
// survives COMMIT. Callers receive copies so dialogue edits cannot poison reads.
function createAssistantReadFrame(env, assertActive, platformOnly) {
  const memo = new Map();
  let closed = false,
    tail = Promise.resolve(),
    pending = 0,
    calls = 0;
  const reusable = new Set(['timeZone', 'serviceGroups', 'appointmentContext', 'revision']);
  const state = { ...env, summaryCache: new Map(), summaryCacheBytes: 0, directoryEntry: null };
  function check() {
    assertActive();
    if (closed) throw fail(409, 'Чтение помощника уже завершено.');
  }
  async function read(kind, input, callerCheck) {
    check();
    callerCheck();
    if (platformOnly && !['timeZone', 'serviceGroups'].includes(kind))
      throw fail(503, 'Для этой операции нужен снимок картотеки.');
    if (++calls > 128 || pending >= 16) throw fail(503, 'Слишком много чтений помощника.');
    const preceding = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    pending++;
    try {
      await preceding;
      check();
      callerCheck();
      if (reusable.has(kind) && memo.has(kind)) return structuredClone(memo.get(kind));
      const result = await assistantProjection(state, kind, input);
      check();
      callerCheck();
      if (reusable.has(kind)) {
        memo.set(kind, structuredClone(result));
      }
      return result;
    } finally {
      pending--;
      release();
    }
  }
  async function finish() {
    // Drain an accidental unawaited internal read before ending its physical RR,
    // then fail rather than allowing that work to escape into a later dialogue.
    const dangling = pending > 0;
    await tail;
    closed = true;
    memo.clear();
    state.summaryCache.clear();
    state.directoryEntry = null;
    state.operation = null;
    state.prepared = null;
    state.cache = null;
    if (dangling) throw fail(503, 'Незавершённое чтение помощника.');
  }
  return { read, finish, check };
}
module.exports = { createAssistantReadFrame };
