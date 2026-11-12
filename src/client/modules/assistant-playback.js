function createAssistantPlayback(state, actions) {
  const turnTiming = (entry, event, value = undefined) => {
    try {
      entry.result.onTiming?.(event, value);
    } catch {}
  };
  let session = null,
    active = null,
    serial = 0,
    setupError = null,
    contextChanged = false;
  const contextError = () =>
    Object.assign(Error('Учётная запись изменилась. Откройте кабинет заново.'), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      outcomeUnknown: false,
    });
  const maximumBytes = 4 * 1024 * 1024,
    capacity = 48000;
  const identity = () =>
    JSON.stringify([
      state.assistantGeneration,
      state.account?.id,
      state.account?.organizationId,
      state.account?.role,
    ]);
  // One numeric session and one stopped snapshot; no content, actor IDs or packet history.
  const diagnosticCounts = {
      playbackRequested: 'requests',
      playbackStarted: 'starts',
      playbackCompleted: 'completed',
      playbackCancelled: 'cancelled',
      playbackFailed: 'failures',
      underrun: 'underruns',
      refill: 'refills',
      bargePause: 'bargePauses',
      bargeFalsePause: 'bargeFalsePauses',
      bargeInterrupt: 'bargeInterrupts',
    },
    diagnosticTimes = [
      'startupWait',
      'outputReadyWait',
      'firstChunkWait',
      'bargeReadyWait',
      'refillWait',
    ];
  let diagnosticIdentity = identity(),
    diagnosticActive = false,
    diagnosticValues = {},
    lastDiagnostic = null,
    pendingPlaybackSummary = null;
  const contextState = (owner) =>
    ({ running: 1, suspended: 2, interrupted: 3, closed: 4 })[owner.context.state] || 0;
  let runningObservation = null,
    observationIdentity = identity(),
    observationVoiceKey = null,
    observationVoiceStarted = false;
  function observationScope() {
    if (observationIdentity === identity()) return;
    observationIdentity = identity();
    runningObservation = null;
    pendingPlaybackSummary = null;
    observationVoiceKey = null;
    observationVoiceStarted = false;
  }
  function observe(result, format) {
    observationScope();
    if (![1, 2, 3].includes(format)) throw failure();
    runningObservation?.handle.finish(false);
    const key = voiceKey(result);
    if (key && observationVoiceKey !== key) {
      observationVoiceKey = key;
      observationVoiceStarted = false;
    }
    const values = Array(24).fill(0);
    values[0] = 2;
    values[2] = key && !observationVoiceStarted ? 1 : 0;
    values[20] = format;
    const entry = {
      identity: identity(),
      key,
      values,
      pausedAt: null,
      startedAt: null,
      done: false,
    };
    const currentObservation = () => {
      observationScope();
      return !entry.done && runningObservation === entry && entry.identity === identity();
    };
    const offset = (index) => {
      if (!values[index] && entry.startedAt !== null)
        values[index] = Math.min(
          150001,
          Math.max(0, Math.round(diagnosticNow() - entry.startedAt)) + 1,
        );
    };
    const handle = {
      started() {
        if (!currentObservation() || entry.startedAt !== null) return;
        entry.startedAt = diagnosticNow();
        if (entry.key && observationVoiceKey === entry.key) observationVoiceStarted = true;
      },
      event(event, milliseconds = 0) {
        if (!currentObservation()) return;
        const index = {
          underrun: 3,
          refill: 4,
          bargePause: 6,
          bargeFalsePause: 7,
          nativeResume: 10,
          bargeInterrupt: 15,
          contextSuspended: 16,
          contextInterrupted: 17,
          mediaWaiting: 18,
          mediaStalled: 19,
        }[event];
        if (index !== undefined) values[index] = Math.min(100, values[index] + 1);
        const timeIndex = {
          refillWait: 5,
          nativeResumeWait: 11,
          startupWait: 12,
          firstChunkWait: 13,
          outputReadyWait: 14,
        }[event];
        if (timeIndex !== undefined && Number.isFinite(milliseconds) && milliseconds >= 0)
          values[timeIndex] = Math.min(150000, values[timeIndex] + Math.round(milliseconds));
        if (
          event === 'contextState' &&
          Number.isSafeInteger(milliseconds) &&
          milliseconds >= 0 &&
          milliseconds <= 4
        )
          values[9] = milliseconds;
        if (event === 'underrun') offset(21);
        if (event === 'bargePause') {
          offset(22);
          entry.pausedAt = diagnosticNow();
        }
        if (
          ['mediaWaiting', 'mediaStalled', 'contextSuspended', 'contextInterrupted'].includes(event)
        )
          offset(23);
        if (event === 'bargeFalsePause' && entry.pausedAt !== null) {
          values[8] = Math.min(
            150000,
            values[8] + Math.max(0, Math.round(diagnosticNow() - entry.pausedAt)),
          );
          entry.pausedAt = null;
        }
      },
      finish(completed, error = null) {
        if (!currentObservation()) return;
        entry.done = true;
        runningObservation = null;
        const stopped = values.slice();
        stopped[1] = error ? 2 : completed ? 0 : 1;
        if (
          pendingPlaybackSummary?.identity === entry.identity &&
          pendingPlaybackSummary.values[2] === 1 &&
          (pendingPlaybackSummary.started || stopped[2] !== 1 || entry.startedAt === null)
        )
          return;
        pendingPlaybackSummary = {
          identity: entry.identity,
          values: stopped,
          started: entry.startedAt !== null,
        };
      },
    };
    entry.handle = handle;
    runningObservation = entry;
    return handle;
  }
  function playbackObservation(event, milliseconds = 0) {
    observationScope();
    runningObservation?.handle.event(event, milliseconds);
  }
  function takeAssistantPlaybackSummary() {
    observationScope();
    const pending = pendingPlaybackSummary;
    pendingPlaybackSummary = null;
    return pending?.identity === identity() ? pending.values.slice() : null;
  }
  function finalizePlaybackSummary(entry, completed, error) {
    entry.observation?.finish(completed, error);
  }
  function clearDiagnostics() {
    diagnosticActive = false;
    diagnosticValues = {};
    lastDiagnostic = null;
  }
  function diagnosticScope() {
    if (diagnosticIdentity !== identity()) {
      diagnosticIdentity = identity();
      clearDiagnostics();
    }
  }
  function diagnosticSnapshot() {
    const result = { version: 1, active: diagnosticActive };
    for (const name of Object.values(diagnosticCounts)) result[name] = diagnosticValues[name] || 0;
    for (const name of diagnosticTimes) {
      result[name + 'Ms'] = diagnosticValues[name + 'Ms'] || 0;
      result[name + 'MaxMs'] = diagnosticValues[name + 'MaxMs'] || 0;
    }
    return Object.freeze(result);
  }
  function assistantAudioDiagnostics() {
    diagnosticScope();
    return Object.freeze({ ...(lastDiagnostic || diagnosticSnapshot()) });
  }
  function recordAssistantAudioDiagnostic(event, milliseconds = 0) {
    playbackObservation(event, milliseconds);
    diagnosticScope();
    if (typeof event !== 'string') return false;
    if (event === 'sessionStart') {
      clearDiagnostics();
      diagnosticActive = true;
      return true;
    }
    if (event === 'sessionStop') {
      if (!diagnosticActive) return false;
      diagnosticActive = false;
      lastDiagnostic = diagnosticSnapshot();
      diagnosticValues = {};
      try {
        globalThis.console?.info?.('assistant-audio-summary', lastDiagnostic);
      } catch {}
      return true;
    }
    if (!diagnosticActive) return false;
    const count = Object.hasOwn(diagnosticCounts, event) ? diagnosticCounts[event] : null;
    if (count) {
      diagnosticValues[count] = Math.min(1000000, (diagnosticValues[count] || 0) + 1);
      return true;
    }
    if (!diagnosticTimes.includes(event) || !Number.isFinite(milliseconds) || milliseconds < 0)
      return false;
    const elapsed = Math.min(150000, Math.round(milliseconds));
    diagnosticValues[event + 'Ms'] = Math.min(
      86400000,
      (diagnosticValues[event + 'Ms'] || 0) + elapsed,
    );
    diagnosticValues[event + 'MaxMs'] = Math.max(diagnosticValues[event + 'MaxMs'] || 0, elapsed);
    return true;
  }
  const diagnosticNow = () => {
    try {
      const value = globalThis.performance?.now?.() ?? Date.now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  const supported = () =>
    typeof (window.AudioContext || window.webkitAudioContext) === 'function' &&
    typeof window.AudioWorkletNode === 'function' &&
    typeof window.Audio === 'function' &&
    typeof window.fetch === 'function';
  const failure = (error) =>
    Object.assign(
      Error(
        error?.name === 'NotAllowedError'
          ? 'Браузер приостановил звук. Нажмите «Продолжить».'
          : 'Не удалось включить голосовой ответ. Нажмите «Продолжить».',
      ),
      {
        code:
          error?.name === 'NotAllowedError'
            ? 'ASSISTANT_AUDIO_GESTURE_REQUIRED'
            : 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
      },
    );
  const blocked = () => failure({ name: 'NotAllowedError' });
  const current = (entry) =>
    active === entry &&
    session === entry.session &&
    entry.identity === identity() &&
    !document.hidden;
  function bounded(promise, milliseconds, error, owner) {
    return new Promise((resolve, reject) => {
      let timer,
        settled = false;
      const settle = (value, failed = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        owner.waits.delete(cancel);
        if (failed) reject(value);
        else resolve(value);
      };
      const cancel = () => settle(blocked(), true);
      owner.waits.add(cancel);
      timer = setTimeout(() => settle(error, true), milliseconds);
      Promise.resolve(promise).then(
        (value) => settle(value),
        (reason) => settle(reason, true),
      );
    });
  }
  function finish(entry, completed, error = null) {
    if (active !== entry) return;
    const owner = entry.session;
    if (!completed || error || !current(entry)) clearCarry(owner);
    else if (entry.voiceKey && owner.carryKey === entry.voiceKey && !entry.hadUnderrun) {
      owner.stableSamples += entry.consumed;
      while (owner.stableSamples >= 48000) {
        owner.stableSamples -= 48000;
        owner.reserveSamples = Math.max(2880, Math.ceil(owner.reserveSamples * 0.75));
      }
    }
    finalizePlaybackSummary(entry, completed, error);
    recordAssistantAudioDiagnostic(
      completed ? 'playbackCompleted' : error ? 'playbackFailed' : 'playbackCancelled',
    );
    active = null;
    clearTimeout(entry.timer);
    clearTimeout(entry.headerTimer);
    clearTimeout(entry.drainTimer);
    entry.controller.abort();
    entry.transport?.cancel();
    void entry.reader?.cancel().catch(() => {});
    if (!entry.reader) void entry.response?.body?.cancel?.().catch(() => {});
    entry.space?.();
    entry.pause?.(false);
    entry.session.node?.port.postMessage({ type: 'begin', id: ++serial });
    if (error) entry.reject(error);
    else entry.resolve(completed);
  }
  function clearCarry(owner = session) {
    if (!owner) return;
    owner.carryKey = null;
    owner.reserveSamples = 2880;
    owner.stableSamples = 0;
    owner.voiceStarted = false;
  }
  function voiceKey(result) {
    const owner = result?.voiceOwner;
    return owner &&
      ['epoch', 'session', 'generation'].every(
        (key) => Number.isSafeInteger(owner[key]) && owner[key] >= 0,
      ) &&
      owner.generation === state.assistantGeneration
      ? JSON.stringify([owner.epoch, owner.session, owner.generation])
      : null;
  }
  function stop(preserveCarry = false) {
    if (active) finish(active, false);
    if (!preserveCarry) clearCarry();
  }
  function release() {
    stop();
    recordAssistantAudioDiagnostic('sessionStop');
    clearDiagnostics();
    setupError = null;
    const prior = session;
    session = null;
    if (!prior) return;
    actions.assistantPcmTransport?.()?.release(prior);
    for (const cancel of prior.waits) cancel();
    prior.waits.clear();
    for (const cancel of prior.cues) cancel();
    prior.cues.clear();
    if (prior.node) {
      prior.node.port.onmessage = null;
      prior.node.port.close();
      prior.node.disconnect();
    }
    prior.gain?.disconnect();
    prior.destination?.disconnect?.();
    prior.context.onstatechange = null;
    prior.node && (prior.node.onprocessorerror = null);
    prior.media.onplaying = prior.media.onerror = prior.media.onpause = null;
    prior.media.onwaiting = prior.media.onstalled = null;
    prior.media.pause();
    prior.media.srcObject = null;
    prior.media.remove?.();
    void prior.context.close().catch(() => {});
  }
  function message(owner, data) {
    const entry = active;
    if (!entry || entry.session !== owner || data?.id !== entry.id) return;
    if (!current(entry)) {
      finish(entry, false);
      return;
    }
    if (entry.transport && ['progress', 'eof'].includes(data.type)) {
      if (
        !Number.isSafeInteger(data.received) ||
        data.received < entry.sent ||
        data.received > maximumBytes / 2
      ) {
        finish(entry, false, failure());
        return;
      }
      entry.sent = data.received;
    }
    if (data.type === 'eof' && entry.transport) {
      if (!entry.sent || entry.sent < entry.consumed) {
        finish(entry, false, failure());
        return;
      }
      if (entry.eof) return;
      entry.eof = true;
      entry.transport.eof();
    } else if (data.type === 'started' && !entry.started) {
      entry.started = true;
      entry.observation?.started();
      if (entry.voiceKey && owner.carryKey === entry.voiceKey) owner.voiceStarted = true;
      recordAssistantAudioDiagnostic('playbackStarted');
      recordAssistantAudioDiagnostic('startupWait', diagnosticNow() - entry.preparedAt);
      // Worklet render acknowledgement; this cannot measure the physical speaker.
      turnTiming(entry, 'pcmRenderStart');
      entry.result.onStarted?.();
    } else if (data.type === 'progress') {
      if (
        !Number.isSafeInteger(data.consumed) ||
        data.consumed < entry.consumed ||
        data.consumed > entry.sent
      ) {
        finish(entry, false, failure());
        return;
      }
      entry.consumed = data.consumed;
      entry.space?.();
    } else if (data.type === 'diagnostic') {
      if (data.event === 'underrun') {
        entry.hadUnderrun = true;
        if (entry.voiceKey && owner.carryKey === entry.voiceKey) {
          owner.reserveSamples = 7200;
          owner.stableSamples = 0;
        }
        recordAssistantAudioDiagnostic('underrun');
        turnTiming(entry, 'audioUnderrun');
      } else if (
        data.event === 'refill' &&
        Number.isFinite(data.waitMs) &&
        data.waitMs >= 0 &&
        data.waitMs <= 150000
      ) {
        recordAssistantAudioDiagnostic('refill');
        recordAssistantAudioDiagnostic('refillWait', data.waitMs);
        turnTiming(entry, 'audioRefill', data.waitMs);
      }
    } else if (data.type === 'paused') entry.pause?.(true);
    else if (data.type === 'probed') entry.pause?.('ducked');
    else if (data.type === 'ended') {
      if (!entry.started || !entry.eof) {
        finish(entry, false, failure());
        return;
      }
      if (entry.drainTimer) return;
      turnTiming(entry, 'pcmRenderEnd');
      // Render-empty is upstream of MediaStream -> HTMLAudio -> device buffers.
      // Keep the final response's route alive briefly before callers release it.
      // This bounded safeguard is not a physical-sink acknowledgement. Reported
      // context latency cannot measure the separate HTMLAudio queue.
      if (entry.result.drainOnEnd === false) {
        finish(entry, true);
        return;
      }
      const latency = (value) => (Number.isFinite(value) && value > 0 ? Math.min(value, 0.5) : 0);
      const milliseconds = Math.min(
        500,
        Math.max(
          200,
          1000 * (latency(owner.context.baseLatency) + latency(owner.context.outputLatency)) + 10,
        ),
      );
      entry.drainTimer = setTimeout(() => {
        if (!current(entry)) {
          finish(entry, false);
          return;
        }
        turnTiming(entry, 'pcmDrainEnd');
        finish(entry, true);
      }, milliseconds);
    } else if (data.type === 'error') finish(entry, false, failure());
  }
  function unlock(capture = null) {
    if (contextChanged) return Promise.resolve(false);
    let capturing = false;
    try {
      capturing =
        capture
          ?.getAudioTracks?.()
          .some((track) => track.kind === 'audio' && track.readyState === 'live') === true;
    } catch {}
    // WebKit also permits MediaStream playback while the page is capturing.
    // Only accept an already granted live microphone; play/resume still decide.
    if (
      !supported() ||
      document.hidden ||
      (navigator.userActivation?.isActive === false && !capturing)
    )
      return Promise.resolve(false);
    const build = document.querySelector?.('meta[name="cartoteca-build"]')?.content;
    if (typeof build !== 'string' || !/^[a-f0-9]{16}$/.test(build)) {
      setupError = failure();
      return Promise.resolve(false);
    }
    setupError = null;
    if (session && session.identity !== identity()) release();
    let owner = session,
      creating = null;
    try {
      if (!owner) {
        const Context = window.AudioContext || window.webkitAudioContext,
          context = new Context();
        creating = context;
        const destination = context.createMediaStreamDestination(),
          gain = context.createGain(),
          media = new window.Audio();
        gain.connect(destination);
        media.setAttribute?.('playsinline', '');
        media.autoplay = false;
        media.hidden = true;
        media.muted = false;
        media.volume = 1;
        media.srcObject = destination.stream;
        document.body?.appendChild(media);
        owner = {
          context,
          destination,
          gain,
          media,
          identity: identity(),
          node: null,
          waits: new Set(),
          cues: new Set(),
          ready: null,
          error: null,
          carryKey: null,
          reserveSamples: 2880,
          stableSamples: 0,
          voiceStarted: false,
        };
        session = owner;
      }
      // Start both APIs in the gesture, but an early media rejection is not
      // proof that the complete output graph cannot run after mic permission.
      const resumed = Promise.resolve(owner.context.resume()),
        played = Promise.resolve(owner.media.play()),
        token = owner;
      void resumed.catch(() => {});
      void played.catch(() => {});
      if (!owner.module)
        owner.module = owner.context.audioWorklet
          .addModule('/assistant-playback-worklet.js?v=' + encodeURIComponent(build))
          .then(() => {
            if (session !== token || token.identity !== identity()) throw blocked();
            const node = new window.AudioWorkletNode(token.context, 'assistant-playback', {
              numberOfInputs: 0,
              numberOfOutputs: 1,
              outputChannelCount: [1],
            });
            token.node = node;
            node.port.onmessage = ({ data }) => message(token, data);
            const unavailable = (error) => {
              token.error = error;
              clearCarry(token);
              for (const cancel of token.cues) cancel(error);
              if (active?.session === token) finish(active, false, error);
            };
            node.onprocessorerror = () => unavailable(failure());
            token.context.onstatechange = () => {
              if (session === token && active?.session === token) {
                if (token.context.state === 'suspended') playbackObservation('contextSuspended');
                if (token.context.state === 'interrupted')
                  playbackObservation('contextInterrupted');
              }
              if (session === token && token.context.state !== 'running') unavailable(blocked());
            };
            token.media.onwaiting = () => {
              if (session === token && active?.session === token)
                playbackObservation('mediaWaiting');
            };
            token.media.onstalled = () => {
              if (session === token && active?.session === token)
                playbackObservation('mediaStalled');
            };
            token.media.onerror = () => unavailable(failure());
            token.media.onpause = () => {
              if (session === token) unavailable(blocked());
            };
            node.connect(token.gain);
            // Prime the actual worklet/MediaStream graph, not another audio element.
            const samples = new window.Int16Array(2400);
            node.port.postMessage({ type: 'buffer', id: 0, samples }, [samples.buffer]);
            node.port.postMessage({ type: 'resume', id: 0 });
            node.port.postMessage({ type: 'end', id: 0 });
            void bounded(token.media.play(), 3000, blocked(), token).catch(() => {});
          });
      owner.error = null;
      owner.ready = bounded(Promise.all([resumed, owner.module]), 3000, blocked(), owner)
        .then(
          () =>
            session === token && token.identity === identity() && token.context.state === 'running',
        )
        .catch((error) => {
          token.error = error?.code ? error : failure(error);
          return false;
        });
      return owner.ready;
    } catch (error) {
      if (owner) {
        owner.error = failure(error);
        owner.ready = Promise.resolve(false);
      } else if (creating) void creating.close().catch(() => {});
      return Promise.resolve(false);
    }
  }
  async function ready() {
    const owner = session;
    if (!owner || owner.identity !== identity() || document.hidden) throw setupError || blocked();
    try {
      await bounded(owner.module, 3000, blocked(), owner);
    } catch (error) {
      throw error?.code ? error : failure(error);
    }
    if (session !== owner || owner.identity !== identity() || !owner.node) throw blocked();
    return owner;
  }
  async function audible(owner) {
    try {
      if (owner.context.state !== 'running') {
        const waitingAt = diagnosticNow();
        playbackObservation('nativeResume');
        try {
          await bounded(owner.context.resume(), 3000, blocked(), owner);
        } finally {
          playbackObservation('nativeResumeWait', diagnosticNow() - waitingAt);
        }
      }
      await bounded(owner.media.play(), 3000, blocked(), owner);
      if (
        session !== owner ||
        owner.identity !== identity() ||
        document.hidden ||
        owner.context.state !== 'running' ||
        owner.media.paused === true
      )
        throw blocked();
      owner.error = null;
    } catch (error) {
      throw error?.code ? error : failure(error);
    }
  }
  async function cue(options = {}) {
    const owner = await ready();
    await audible(owner);
    const initial =
        options.startCue === true ||
        (options.initialCommand === true && options.shortAnswer !== true),
      duration = options.shortAnswer === true ? 0.06 : initial ? 0.12 : 0.14,
      oscillator = owner.context.createOscillator(),
      gain = owner.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = initial ? 523.25 : 880;
    gain.gain.value = initial ? 0.075 : 0.08;
    if (initial && typeof gain.gain.setValueAtTime === 'function') {
      const start = owner.context.currentTime;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.075, start + Math.min(0.018, duration / 4));
      gain.gain.linearRampToValueAtTime(0, start + duration * 0.45);
      oscillator.frequency.setValueAtTime?.(659.25, start + duration * 0.45);
      gain.gain.linearRampToValueAtTime(0.06, start + duration * 0.56);
      gain.gain.linearRampToValueAtTime(0, start + duration);
    }
    oscillator.connect(gain);
    gain.connect(owner.gain);
    return new Promise((resolve, reject) => {
      let timer;
      const finishCue = (error = null) => {
        if (!owner.cues.delete(finishCue)) return;
        clearTimeout(timer);
        oscillator.onended = null;
        try {
          oscillator.stop();
        } catch {}
        oscillator.disconnect();
        gain.disconnect();
        if (error) reject(error);
        else if (
          session !== owner ||
          owner.identity !== identity() ||
          owner.context.state !== 'running' ||
          owner.media.paused === true ||
          owner.error
        )
          reject(owner.error || blocked());
        else resolve(true);
      };
      owner.cues.add(finishCue);
      oscillator.onended = () => finishCue();
      timer = setTimeout(finishCue, 400);
      oscillator.start();
      oscillator.stop(owner.context.currentTime + duration);
    });
  }
  function validate(result) {
    if (
      result?.mimeType !== 'audio/pcm' ||
      result.sampleRate !== 24000 ||
      result.channels !== 1 ||
      result.sampleFormat !== 's16le' ||
      result.playbackRate !== 1 ||
      result.audioBase64 != null
    )
      throw failure();
    if (result.streamRequest != null) {
      const body = result.streamRequest;
      if (
        result.streamUrl != null ||
        state.assistantScope?.capabilities?.tts?.directPcm !== true ||
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (key) =>
            !['text', 'policyVersion', 'format', 'taskRequestId', 'speechToken'].includes(key),
        ) ||
        typeof body.text !== 'string' ||
        !body.text.trim() ||
        body.text.length > 1000 ||
        body.format !== 'pcm' ||
        !Number.isSafeInteger(body.policyVersion) ||
        body.policyVersion < 0 ||
        body.policyVersion !== result.policyVersion ||
        body.policyVersion !== state.assistantScope.policyVersion ||
        (body.taskRequestId !== undefined &&
          (typeof body.taskRequestId !== 'string' || body.taskRequestId.length > 200)) ||
        (body.speechToken !== undefined &&
          (typeof body.speechToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.speechToken)))
      )
        throw failure();
      return;
    }
    if (typeof result.streamUrl !== 'string') throw failure();
    const match =
      /^\/api\/assistant\/speak-audio\?ticket=[A-Za-z0-9_-]{43}&accountContext=([^&#]*)&organizationContext=([^&#]*)$/u.exec(
        result.streamUrl,
      );
    if (!match) throw failure();
    let account, organization;
    try {
      account = decodeURIComponent(match[1]);
      organization = decodeURIComponent(match[2]);
    } catch {
      throw failure();
    }
    if (
      account !== (state.account?.id || '') ||
      organization !== (state.account?.organizationId || '')
    )
      throw contextError();
  }
  async function room(entry, count) {
    while (current(entry) && entry.sent - entry.consumed + count > capacity)
      await new Promise((resolve) => {
        entry.space = resolve;
      });
    entry.space = null;
    if (!current(entry)) throw blocked();
  }
  async function directRefusal(entry, response) {
    let code = 'ASSISTANT_SPEECH_REQUEST_FAILED';
    const allowed = new Set([
      'TASK_IN_PROGRESS',
      'TASK_ALREADY_COUNTED',
      'TASK_KEY_CONFLICT',
      'TASK_NOT_RESERVED',
      'ASSISTANT_PACKAGE_EXHAUSTED',
      'ASSISTANT_PACKAGE_REQUIRED',
      'ASSISTANT_TASK_REQUIRED',
      'ASSISTANT_SPEECH_PROOF_REQUIRED',
      'ASSISTANT_DIRECT_SPEECH_CAPACITY',
    ]);
    if (response.body?.getReader && typeof window.TextDecoder === 'function') {
      entry.reader = response.body.getReader();
      const decoder = new window.TextDecoder();
      let text = '',
        bytes = 0;
      try {
        while (current(entry)) {
          const part = await entry.reader.read();
          if (!current(entry) || part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 8192) break;
          text += decoder.decode(part.value, { stream: true });
        }
        if (bytes <= 8192) {
          const value = JSON.parse(text + decoder.decode());
          if (allowed.has(value?.code)) code = value.code;
        }
      } catch {
        // Error payloads are optional. Never turn them into audio or retry synthesis.
      } finally {
        void entry.reader.cancel().catch(() => {});
      }
    }
    return Object.assign(
      Error(
        response.status === 429 || code === 'ASSISTANT_PACKAGE_EXHAUSTED'
          ? 'Лимит помощника исчерпан. Можно продолжить на экране.'
          : response.status === 401
            ? 'Войдите снова.'
            : 'Не удалось озвучить ответ. Ответ доступен на экране.',
      ),
      { status: response.status, code },
    );
  }
  async function acceptPcmHeaders(entry, response, direct) {
    if (response.status === 428) {
      const error = contextError();
      contextChanged = true;
      if (direct) entry.result.onRefused?.(428, 'AUTH_CONTEXT_CHANGED');
      finish(entry, false, error);
      release();
      if (typeof location !== 'undefined') location.replace('/');
      throw error;
    }
    const header = (name) => response.headers.get(name);
    if (direct && !response.ok) {
      const error = await directRefusal(entry, response);
      clearTimeout(entry.headerTimer);
      if (!current(entry)) return false;
      entry.result.onRefused?.(response.status, error.code);
      throw error;
    }
    if (direct && header('x-assistant-policy-version') !== String(entry.result.policyVersion)) {
      entry.result.onRefused?.(409);
      throw failure();
    }
    if (
      !response.ok ||
      header('content-type')?.split(';')[0].trim() !== 'audio/pcm' ||
      header('x-audio-sample-rate') !== '24000' ||
      header('x-audio-channels') !== '1' ||
      header('x-audio-sample-format') !== 's16le'
    )
      throw failure();
    turnTiming(entry, 'pcmHeaders');
    if (direct) turnTiming(entry, 'speakSucceeded');
    try {
      turnTiming(entry, 'pcmServer', header('Server-Timing'));
    } catch {}
    return current(entry);
  }
  async function pump(entry) {
    const owner = await ready();
    if (!current(entry) || owner !== entry.session) return;
    owner.node.port.postMessage({
      type: 'begin',
      id: entry.id,
      startupSamples: entry.startupSamples,
      coldStart: entry.coldStart,
    });
    const direct = entry.requestBody !== null;
    let fetchStarted = 0;
    if (!direct) {
      const service = actions.assistantPcmTransport?.();
      let transport = null;
      if (service) {
        try {
          transport = await service.prepare(owner, {
            id: entry.id,
            node: owner.node,
            current: () => current(entry),
            onHeaders: async (meta) => {
              const names = {
                'content-type': 'contentType',
                'x-audio-sample-rate': 'sampleRate',
                'x-audio-channels': 'channels',
                'x-audio-sample-format': 'sampleFormat',
                'Server-Timing': 'serverTiming',
              };
              if (!current(entry)) throw blocked();
              const accepted = await acceptPcmHeaders(
                entry,
                {
                  status: meta.status,
                  ok: meta.ok,
                  headers: { get: (name) => meta[names[name]] || null },
                },
                false,
              );
              if (!accepted || !current(entry)) throw blocked();
            },
            onFirstByte: () => {
              if (current(entry)) {
                recordAssistantAudioDiagnostic('firstChunkWait', diagnosticNow() - fetchStarted);
                turnTiming(entry, 'pcmFirstByte');
              }
            },
          });
        } catch {
          // Preparation performs no GET. Only an unavailable setup may use the legacy reader.
          transport = null;
        }
      }
      if (!current(entry)) {
        transport?.cancel();
        return;
      }
      if (transport) {
        entry.transport = transport;
        fetchStarted = diagnosticNow();
        turnTiming(entry, 'pcmFetchStart');
        await transport.start({
          url: entry.result.streamUrl,
          accountContext: entry.accountContext,
        });
        return;
      }
    }
    fetchStarted = diagnosticNow();
    turnTiming(entry, 'pcmFetchStart');
    if (direct) {
      turnTiming(entry, 'speakStart');
      entry.headerTimer = setTimeout(
        () => finish(entry, false, failure()),
        state.assistantScope?.limits?.requestTimeoutMs || 20000,
      );
    }
    let response;
    try {
      response = await window.fetch(
        direct ? '/api/assistant/speak-audio' : entry.result.streamUrl,
        {
          ...(direct ? { method: 'POST', body: entry.requestBody } : {}),
          credentials: 'same-origin',
          mode: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          signal: entry.controller.signal,
          headers: {
            ...(direct ? { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' } : {}),
            'X-Cartoteca-Account-Id': entry.accountContext.accountId,
            'X-Cartoteca-Organization-Id': entry.accountContext.organizationId,
          },
        },
      );
      entry.response = response;
    } finally {
      if (direct) turnTiming(entry, 'speakEnd');
    }
    if (!current(entry)) {
      void response.body?.cancel?.().catch(() => {});
      return;
    }
    if (!(await acceptPcmHeaders(entry, response, direct))) return;
    if (!response.body?.getReader) throw failure();
    entry.reader = response.body.getReader();
    let remainder = null,
      bytes = 0,
      arrivalGroup = 0;
    while (current(entry)) {
      const { value, done } = await entry.reader.read();
      if (!current(entry)) return;
      if (done) {
        if (remainder !== null || !bytes) throw failure();
        entry.eof = true;
        owner.node.port.postMessage({ type: 'end', id: entry.id });
        return;
      }
      if (!(value instanceof window.Uint8Array) || !value.length) throw failure();
      // A fetch read is one arrival, even when room() delays its 4096-sample fragments.
      arrivalGroup++;
      if (!bytes) {
        clearTimeout(entry.headerTimer);
        recordAssistantAudioDiagnostic('firstChunkWait', diagnosticNow() - fetchStarted);
        turnTiming(entry, 'pcmFirstByte');
      }
      bytes += value.length;
      if (bytes > maximumBytes) throw failure();
      const input = new window.Uint8Array(value.length + (remainder === null ? 0 : 1));
      if (remainder !== null) input[0] = remainder;
      input.set(value, remainder === null ? 0 : 1);
      const length = input.length - (input.length % 2),
        view = new window.DataView(input.buffer);
      remainder = input.length % 2 ? input[input.length - 1] : null;
      for (let offset = 0; offset < length;) {
        const count = Math.min(4096, (length - offset) / 2);
        await room(entry, count);
        const samples = new window.Int16Array(count);
        for (let i = 0; i < count; i++) samples[i] = view.getInt16(offset + i * 2, true);
        entry.sent += count;
        owner.node.port.postMessage({ type: 'buffer', id: entry.id, samples, arrivalGroup }, [
          samples.buffer,
        ]);
        offset += count * 2;
      }
    }
  }
  function prepare(result) {
    if (contextChanged) throw contextError();
    if (state.multiUser && !state.account?.id) throw contextError();
    try {
      validate(result);
    } catch (error) {
      clearCarry();
      throw error;
    }
    diagnosticScope();
    if (!diagnosticActive) recordAssistantAudioDiagnostic('sessionStart');
    stop(true);
    recordAssistantAudioDiagnostic('playbackRequested');
    if (!session || session.identity !== identity()) throw blocked();
    const key = voiceKey(result);
    if (!key || session.carryKey !== key) {
      clearCarry();
      session.carryKey = key;
    }
    let resolve, reject;
    const done = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Preparation may fail before its owner calls play(); retain the error for that call.
    void done.catch(() => {});
    const observation = observe(result, 1);
    observation.event('contextState', contextState(session));
    const entry = {
      id: ++serial,
      identity: identity(),
      accountContext: {
        accountId: state.account?.id || '',
        organizationId: state.account?.organizationId || '',
      },
      session,
      voiceKey: key,
      hadUnderrun: false,
      startupSamples: key ? session.reserveSamples : 2880,
      coldStart: Boolean(key && !session.voiceStarted),
      observation,
      result,
      requestBody: result.streamRequest != null ? JSON.stringify(result.streamRequest) : null,
      controller: new AbortController(),
      resolve,
      reject,
      done,
      started: false,
      preparedAt: diagnosticNow(),
      eof: false,
      sent: 0,
      consumed: 0,
      space: null,
      pause: null,
      transport: null,
    };
    active = entry;
    entry.timer = setTimeout(() => finish(entry, false, failure()), 150000);
    void pump(entry).catch((error) => {
      if (active === entry) finish(entry, false, error?.code ? error : failure(error));
    });
    return {
      async play() {
        if (active !== entry) return done;
        try {
          const waitingAt = diagnosticNow();
          const owner = await ready();
          if (!current(entry)) return done;
          await audible(owner);
          if (!current(entry)) return done;
          recordAssistantAudioDiagnostic('outputReadyWait', diagnosticNow() - waitingAt);
          owner.node.port.postMessage({ type: 'resume', id: entry.id });
        } catch (error) {
          finish(entry, false, error?.code ? error : failure(error));
        }
        return done;
      },
      cancel() {
        if (active === entry) finish(entry, false);
      },
    };
  }
  function pause(keepAudible = false) {
    const entry = active;
    if (!entry?.started || !current(entry)) return Promise.resolve(false);
    entry.pause?.(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.pause?.(false);
      }, 500);
      entry.pause = (result) => {
        clearTimeout(timer);
        entry.pause = null;
        const accepted = keepAudible ? result === 'ducked' : result === true;
        if (!accepted && current(entry))
          entry.session.node.port.postMessage({ type: 'resume', id: entry.id });
        resolve(accepted && current(entry) ? result : false);
      };
      entry.session.node.port.postMessage({ type: keepAudible ? 'probe' : 'pause', id: entry.id });
    });
  }
  function resume() {
    const entry = active;
    if (!entry?.started || !current(entry) || entry.session.context.state !== 'running')
      return false;
    entry.pause?.(false);
    entry.session.node.port.postMessage({ type: 'resume', id: entry.id });
    return true;
  }
  const api = {
    reference: () => {
      const owner = session;
      return owner
        ? {
            stream: owner.destination.stream,
            current: () => session === owner && owner.identity === identity(),
            playbackId: () =>
              active?.started && active.session === owner && current(active) ? active.id : null,
          }
        : null;
    },
    supported,
    unlock,
    prepare,
    cue,
    stop,
    release,
    pause,
    resume,
    play: (result) => prepare(result).play(),
    playing: () => active?.started === true,
    observe,
    diagnostics: assistantAudioDiagnostics,
    takeSummary: takeAssistantPlaybackSummary,
    recordDiagnostic: recordAssistantAudioDiagnostic,
  };
  return {
    assistantPlayback: () => api,
    assistantAudioDiagnostics,
    takeAssistantPlaybackSummary,
    recordAssistantAudioDiagnostic,
  };
}
