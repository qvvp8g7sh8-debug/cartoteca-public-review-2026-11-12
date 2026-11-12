function createAssistantTiming(state) {
  const limit = 20,
    maxMs = 150000,
    marks = new Set([
      'captureReady',
      'sttStart',
      'sttEnd',
      'turnStart',
      'turnEnd',
      'actionStart',
      'actionEnd',
      'speakStart',
      'speakEnd',
      'pcmFetchStart',
      'pcmHeaders',
      'pcmFirstByte',
      'pcmRenderStart',
      'pcmRenderEnd',
      'pcmDrainEnd',
      'audioStarted',
    ]),
    stages = new Set([
      'request',
      'access',
      'data_read',
      'admission',
      'provider_prepare',
      'outbound_mark',
      'provider_headers',
      'provider_first_byte',
      'provider_complete',
      'settlement',
      'interpretation',
      'domain',
      'tts_cache_wait',
      'tts_first_write',
      'tts_backpressure',
    ]);
  let serial = 0,
    rows = [],
    owner = null,
    identity = '';
  const now = () => {
    const value = globalThis.performance?.now?.();
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  function scope() {
    const key = JSON.stringify([
      state.assistantGeneration,
      state.account?.id,
      state.account?.organizationId,
      state.account?.role,
    ]);
    if (owner !== state.account || key !== identity) {
      rows = [];
      owner = state.account;
      identity = key;
    }
  }
  // Only fixed keys and finite numbers survive in this bounded in-memory store.
  // The origin is the last VAD-positive frame observed by the main thread, when available.
  function assistantTurnTiming(event, turn = 0, value = undefined) {
    try {
      scope();
      if (event === 'reset') {
        rows = [];
        return 0;
      }
      const at = now();
      if (at === null) return 0;
      if (event === 'begin') {
        const speech = Number.isFinite(value) && value >= 0 && value <= at && at - value <= maxMs;
        const row = {
          origin: speech ? value : at,
          values: { turn: ++serial, vadOrigin: speech ? 1 : 0 },
        };
        rows.push(row);
        if (rows.length > limit) rows.shift();
        return serial;
      }
      const row = rows.find((item) => item.values.turn === turn);
      if (!row) return 0;
      if (marks.has(event)) {
        if (['sttStart', 'turnStart', 'speakStart', 'pcmFetchStart'].includes(event)) {
          const key = event.replace('Start', '') + 'Requests';
          row.values[key] = Math.min(1000000, (row.values[key] || 0) + 1);
        }
        // Retain the first occurrence: later TTS chunks/replays must not overwrite first sound.
        if (!Object.hasOwn(row.values, event + 'Ms'))
          row.values[event + 'Ms'] = Math.round(Math.min(maxMs, Math.max(0, at - row.origin)));
      } else if (event === 'audioUnderrun') {
        row.values.audioUnderruns = Math.min(1000000, (row.values.audioUnderruns || 0) + 1);
      } else if (
        event === 'audioRefill' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= maxMs
      ) {
        row.values.audioRefills = Math.min(1000000, (row.values.audioRefills || 0) + 1);
        row.values.audioRefillMs = Math.min(
          maxMs,
          (row.values.audioRefillMs || 0) + Math.round(value),
        );
      } else if (
        ['sttSucceeded', 'turnSucceeded', 'speakSucceeded', 'actionSucceeded'].includes(event)
      ) {
        row.values[event] = 1;
      } else if (/^(stt|turn|speak|pcm)Server$/.test(event) && typeof value === 'string') {
        for (const metric of value.slice(0, 4096).split(',').slice(0, 32)) {
          const match = /^\s*ct_([a-z_]+);dur=(\d+(?:\.\d+)?)\s*$/.exec(metric);
          if (!match || !stages.has(match[1])) continue;
          const duration = Number(match[2]),
            key = event + '_' + match[1] + 'Ms';
          if (Number.isFinite(duration) && !Object.hasOwn(row.values, key))
            row.values[key] = Math.round(Math.min(maxMs, duration));
        }
      }
      return turn;
    } catch {
      return 0;
    }
  }
  function assistantTurnDiagnostics() {
    try {
      scope();
      return Object.freeze(rows.map((row) => Object.freeze({ ...row.values })));
    } catch {
      return Object.freeze([]);
    }
  }
  return { assistantTurnTiming, assistantTurnDiagnostics };
}
