const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const countFields = {
  3: 'underruns',
  4: 'refills',
  6: 'bargePauses',
  7: 'falsePauses',
  10: 'resumeAttempts',
  15: 'bargeInterrupts',
  16: 'contextSuspendedCount',
  17: 'contextInterruptedCount',
  18: 'mediaWaitingCount',
  19: 'mediaStalledCount',
};
const waitFields = {
  5: 'refillWait',
  8: 'falsePause',
  11: 'resumeWait',
  12: 'firstSampleWait',
  13: 'firstChunkWait',
  14: 'outputReadyWait',
};
const contexts = ['unknown', 'running', 'suspended', 'interrupted', 'closed'];
const outcomes = ['completed', 'cancelled', 'failed'];
const formats = ['Pcm', 'NativeMedia', 'LocalSpeech'];
const classes = ['UnderflowOnly', 'FalsePauseOnly', 'Both', 'Neither', 'NativeEvent'];
const offsetFields = {
  21: 'firstUnderrunAfterReportedStart',
  22: 'firstBargePauseAfterReportedStart',
  23: 'firstNativeAfterReportedStart',
};
function emptySummary() {
  return Object.fromEntries([
    ['samples', 0],
    ['firstInVoice', 0],
    ...outcomes.map((name) => [name, 0]),
    ...['underflowOnly', 'falsePauseOnly', 'both', 'neither'].map((name) => [name, 0]),
    ...['first', 'later'].flatMap((prefix) =>
      ['UnderflowOnly', 'FalsePauseOnly', 'Both', 'Neither', 'NativeEvent'].map((name) => [
        prefix + name,
        0,
      ]),
    ),
    ...contexts.map((name) => ['context' + name[0].toUpperCase() + name.slice(1), 0]),
    ...Object.values(countFields).map((name) => [name, 0]),
    ...Object.values(waitFields).flatMap((name) => [
      [name + 'TotalMs', 0],
      [name + 'MaxMs', 0],
    ]),
    ...formats.flatMap((format) =>
      [
        'Samples',
        'FirstSamples',
        'LaterSamples',
        ...['First', 'Later'].flatMap((phase) => classes.map((name) => phase + name)),
      ].map((name) => ['format' + format + name, 0]),
    ),
    ...Object.values(offsetFields).flatMap((name) =>
      ['Samples', 'TotalMs', 'MaxMs'].map((suffix) => [name + suffix, 0]),
    ),
  ]);
}
function parsePlaybackSummary(value) {
  if (typeof value !== 'string' || value.length > 256 || !/^\d+(?:,\d+)*$/.test(value)) return null;
  const tuple = value.split(',').map(Number);
  if (
    !((tuple[0] === 1 && tuple.length === 20) || (tuple[0] === 2 && tuple.length === 24)) ||
    tuple.some((n) => !Number.isSafeInteger(n))
  )
    return null;
  for (let i = 1; i < 20; i++) {
    const max =
      i === 1 ? 2 : i === 2 ? 1 : i === 9 ? 4 : Object.hasOwn(waitFields, i) ? 150000 : 100;
    if (tuple[i] < 0 || tuple[i] > max) return null;
  }
  if (
    tuple[0] === 2 &&
    (tuple[20] < 1 || tuple[20] > 3 || tuple.slice(21).some((n) => n < 0 || n > 150001))
  )
    return null;
  return tuple;
}
function requestKey(current, body) {
  if (
    !current ||
    !body ||
    !['sessionId', 'accountId', 'organizationId', 'role'].every(
      (key) =>
        typeof current[key] === 'string' && current[key].length > 0 && current[key].length <= 128,
    ) ||
    (body.dialogueId !== undefined &&
      (typeof body.dialogueId !== 'string' || body.dialogueId.length > 64)) ||
    (body.dialogueVersion !== undefined &&
      (!Number.isSafeInteger(body.dialogueVersion) || body.dialogueVersion < 0))
  )
    return null;
  if (body.taskRequestId === undefined) {
    if (
      typeof body.dialogueId !== 'string' ||
      !body.dialogueId.trim() ||
      !Number.isSafeInteger(body.dialogueVersion)
    )
      return null;
    // Only the successful turn route calls record: the existing dialogue owner,
    // version and access checks have already accepted this continuation.
    return createHash('sha256')
      .update(
        JSON.stringify([
          'accepted-dialogue-continuation',
          current.sessionId,
          current.accountId,
          current.organizationId,
          current.role,
          body.dialogueId,
          body.dialogueVersion,
        ]),
      )
      .digest('hex');
  }
  if (
    typeof body.taskRequestId !== 'string' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(body.taskRequestId)
  )
    return null;
  // Existing authenticated request context only; never hash content or emit this key.
  return createHash('sha256')
    .update(
      JSON.stringify([
        current.sessionId,
        current.accountId,
        current.organizationId,
        current.role,
        body.taskRequestId,
        body.dialogueId ?? null,
        body.dialogueVersion ?? null,
      ]),
    )
    .digest('hex');
}
function createAssistantPlaybackMetrics({
  now = () => performance.now(),
  capacity = 4096,
  ttlMs = 600000,
} = {}) {
  const seen = new Map();
  let summary = emptySummary(),
    closed = false;
  const add = (name, value = 1) => {
    summary[name] = Math.min(Number.MAX_SAFE_INTEGER, summary[name] + value);
  };
  function record(current, body, header) {
    if (closed) return false;
    const tuple = parsePlaybackSummary(header),
      key = tuple && requestKey(current, body),
      time = now();
    if (!key || !Number.isFinite(time)) return false;
    // Insertion order is expiry order. Bounded at capacity, with no idle timer.
    for (const [old, expires] of seen) {
      if (expires > time) break;
      seen.delete(old);
    }
    if (seen.has(key) || seen.size >= capacity) return false;
    seen.set(key, time + ttlMs);
    add('samples');
    add('firstInVoice', tuple[2]);
    add(outcomes[tuple[1]]);
    const underflow = tuple[3] > 0,
      falsePause = tuple[7] > 0;
    const classification = underflow
      ? falsePause
        ? 'both'
        : 'underflowOnly'
      : falsePause
        ? 'falsePauseOnly'
        : 'neither';
    add(classification);
    const phase = tuple[2] ? 'first' : 'later';
    const capitalPhase = tuple[2] ? 'First' : 'Later',
      capitalClass = classification[0].toUpperCase() + classification.slice(1),
      nativeEvent = tuple.slice(16, 20).some((count) => count > 0),
      format = 'format' + formats[tuple[0] === 2 ? tuple[20] - 1 : 0];
    add(phase + capitalClass);
    if (nativeEvent) add(phase + 'NativeEvent');
    add(format + 'Samples');
    add(format + capitalPhase + 'Samples');
    add(format + capitalPhase + capitalClass);
    if (nativeEvent) add(format + capitalPhase + 'NativeEvent');
    const context = contexts[tuple[9]];
    add('context' + context[0].toUpperCase() + context.slice(1));
    for (const [index, name] of Object.entries(countFields)) add(name, tuple[index]);
    for (const [index, name] of Object.entries(waitFields)) {
      add(name + 'TotalMs', tuple[index]);
      summary[name + 'MaxMs'] = Math.max(summary[name + 'MaxMs'], tuple[index]);
    }
    if (tuple[0] === 2)
      for (const [index, name] of Object.entries(offsetFields)) {
        if (tuple[index] === 0) continue; // No observed post-start event, not zero delay.
        const elapsed = tuple[index] - 1;
        add(name + 'Samples');
        add(name + 'TotalMs', elapsed);
        summary[name + 'MaxMs'] = Math.max(summary[name + 'MaxMs'], elapsed);
      }
    return true;
  }
  return {
    record,
    snapshot(reset = false) {
      const result = { ...summary };
      if (reset) summary = emptySummary();
      return result;
    },
    close() {
      closed = true;
      seen.clear();
      summary = emptySummary();
    },
  };
}
module.exports = { createAssistantPlaybackMetrics, parsePlaybackSummary };
