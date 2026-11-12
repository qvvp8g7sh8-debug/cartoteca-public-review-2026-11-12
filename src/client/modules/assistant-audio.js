function createAssistantAudio(state, actions) {
  const captureClock = () => {
    try {
      return globalThis.performance?.now?.();
    } catch {
      return undefined;
    }
  };
  const pcm = actions.assistantPlayback?.();
  const assistantAudioFormat = () => (pcm?.supported() ? 'pcm' : 'mp3');
  async function playAssistantReadyCue(options) {
    if (!pcm) return false;
    const supplied = options?.captureMedia,
      media = supplied || stream,
      owned = () => (supplied ? options.current?.() === true : stream === media),
      identity = audioIdentity(),
      generation = sequence;
    const capturing = () =>
      media
        ?.getAudioTracks?.()
        .some((track) => track.kind === 'audio' && track.readyState === 'live');
    if (supplied && !owned()) return false;
    if (capturing()) {
      await pcm.unlock(media);
      if (
        !owned() ||
        generation !== sequence ||
        identity !== audioIdentity() ||
        document.hidden ||
        !capturing()
      )
        return false;
    }
    return pcm.cue(options);
  }
  let sequence = 0,
    recorder = null,
    stream = null,
    timer = null,
    context = null;
  let audio = null,
    audioUrl = '',
    audioBlobUrl = false,
    speaking = false,
    utterance = null,
    playback = null,
    monitor = null,
    voiceWait = null,
    playbackEpoch = 0,
    pauseWait = null,
    preparedAudio = null,
    audioLease = null;
  const audioIdentity = () =>
    JSON.stringify([
      state.assistantGeneration,
      state.account?.id,
      state.account?.organizationId,
      state.account?.role,
    ]);
  const audioActor = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const audioContextError = () =>
    Object.assign(Error('Учётная запись изменилась. Откройте кабинет заново.'), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      outcomeUnknown: false,
    });
  function nativeAudioFailure(owner, current) {
    if (owner.failure) return owner.failure;
    owner.failure = (async () => {
      if (!current() || owner.identity !== audioIdentity()) return null;
      try {
        // Native media does not expose its HTTP status. This guarded, free read
        // distinguishes a changed cookie from an ordinary playback failure.
        if (typeof actions.request === 'function')
          await actions.request('/api/assistant/scope', { assistantRequest: true });
      } catch (error) {
        if (owner.actor !== audioActor()) return null;
        if (error.code === 'AUTH_CONTEXT_CHANGED') return error;
      }
      if (!current() || owner.identity !== audioIdentity()) return null;
      return Error('Не удалось воспроизвести ответ. Ответ показан текстом.');
    })();
    return owner.failure;
  }
  function finishAudioPrime(lease, prime) {
    if (lease.prime !== prime) return;
    lease.prime = null;
    clearTimeout(prime.timer);
    if (audio !== lease.media) {
      lease.media.onplaying = lease.media.onended = lease.media.onerror = null;
      try {
        // Keep a valid source on the permitted element until real speech replaces it.
        lease.media.pause();
      } catch {}
    }
  }
  function replaceAssistantSource(media, source) {
    media.src = source;
    if (audioLease?.media === media && audioLease.primeUrl) {
      URL.revokeObjectURL(audioLease.primeUrl);
      audioLease.primeUrl = '';
    }
  }
  function discardAudioLease() {
    const lease = audioLease;
    audioLease = null;
    if (!lease) return;
    if (lease.prime) finishAudioPrime(lease, lease.prime);
    lease.media.onplaying = lease.media.onended = lease.media.onerror = null;
    try {
      lease.media.pause();
      lease.media.removeAttribute?.('src');
      lease.media.load?.();
    } catch {}
    if (lease.primeUrl) URL.revokeObjectURL(lease.primeUrl);
  }
  function releaseAssistantAudio() {
    stopAssistantAudio();
    pcm?.release();
    discardAudioLease();
  }
  function leasedAssistantMedia() {
    if (!audioLease) return null;
    if (audioLease.identity !== audioIdentity()) {
      discardAudioLease();
      return null;
    }
    if (audioLease.prime) finishAudioPrime(audioLease, audioLease.prime);
    return audioLease.media;
  }
  function unlockAssistantAudio() {
    if (pcm?.supported()) return pcm.unlock();
    // Invoke directly from a real user gesture; never acquire a microphone here.
    if (
      typeof window.Audio !== 'function' ||
      navigator.userActivation?.isActive === false ||
      (typeof document !== 'undefined' && document.hidden)
    )
      return Promise.resolve(false);
    if (audioLease && audioLease.identity !== audioIdentity()) releaseAssistantAudio();
    if (!audioLease)
      audioLease = {
        media: audio || new window.Audio(),
        identity: audioIdentity(),
        prime: null,
        primeUrl: '',
        unlocked: false,
      };
    const lease = audioLease,
      media = lease.media;
    if (lease.unlocked) return Promise.resolve(true);
    try {
      media.setAttribute?.('playsinline', '');
      media.preload = 'auto';
      if (!audio || audio !== media) {
        if (lease.prime) finishAudioPrime(lease, lease.prime);
        if (lease.primeUrl) {
          URL.revokeObjectURL(lease.primeUrl);
          lease.primeUrl = '';
        }
        // Valid PCM silence, not a muted autoplay bypass or a remote/provider request.
        const bytes = new window.ArrayBuffer(3244),
          view = new window.DataView(bytes);
        const text = (offset, value) => {
          for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
        };
        text(0, 'RIFF');
        view.setUint32(4, 3236, true);
        text(8, 'WAVE');
        text(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true);
        view.setUint32(28, 32000, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        text(36, 'data');
        view.setUint32(40, 3200, true);
        const prime = {
          url: URL.createObjectURL(new window.Blob([bytes], { type: 'audio/wav' })),
          timer: null,
        };
        lease.prime = prime;
        lease.primeUrl = prime.url;
        media.muted = false;
        media.volume = 1;
        media.src = prime.url;
        media.onended = () => finishAudioPrime(lease, prime);
        media.onerror = () => finishAudioPrime(lease, prime);
        prime.timer = setTimeout(() => finishAudioPrime(lease, prime), 1500);
      }
      // play() itself remains synchronous with the click/key/pointerup gesture.
      const started = media.play();
      return Promise.resolve(started).then(
        () => {
          if (audioLease !== lease || lease.identity !== audioIdentity()) return false;
          lease.unlocked = true;
          return true;
        },
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  }
  function audioFailureDetails(stage, error, media, started = false) {
    const bounded = (value, min, max) =>
      Number.isInteger(value) && value >= min && value <= max ? value : null;
    const mediaErrorCode = bounded(media?.error?.code, 1, 4);
    const allowed = [
      'AbortError',
      'NotAllowedError',
      'NotSupportedError',
      'NetworkError',
      'EncodingError',
      'InvalidStateError',
      'SecurityError',
      'TypeError',
    ];
    const name = error?.name;
    return {
      stage,
      name: allowed.includes(name) ? name : mediaErrorCode ? 'MediaError' : 'UnknownError',
      mediaErrorCode,
      readyState: bounded(media?.readyState, 0, 4),
      networkState: bounded(media?.networkState, 0, 3),
      started: started === true,
      hidden: typeof document !== 'undefined' && document.hidden === true,
    };
  }
  function reportAudioFailure(details) {
    try {
      globalThis.console?.warn?.('assistant-audio-failure', details);
    } catch {}
  }
  function observeNative(result, voice = false) {
    try {
      return pcm?.observe?.(result, voice ? 3 : 2) || null;
    } catch {
      return null;
    }
  }
  function markNativeStarted(pending) {
    const now = captureClock();
    if (Number.isFinite(now) && Number.isFinite(pending.preparedCreatedAt))
      pending.observation?.event(
        'startupWait',
        Math.min(150000, Math.max(0, now - pending.preparedCreatedAt)),
      );
    pending.observation?.started();
  }
  function finishAssistantAudio(completed, error = null) {
    const prepared = preparedAudio;
    preparedAudio = null;
    pauseWait?.finish(false);
    const pending = playback;
    playback = null;
    if (audio) {
      audio.onplaying = audio.onended = audio.onerror = audio.onwaiting = audio.onstalled = null;
      try {
        audio.pause();
        if (audioLease?.media !== audio) {
          audio.removeAttribute?.('src');
          audio.load?.();
        }
      } catch {}
      audio = null;
    }
    if (audioBlobUrl && audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = '';
    audioBlobUrl = false;
    if (utterance) utterance.onstart = utterance.onend = utterance.onerror = null;
    utterance = null;
    if (speaking) window.speechSynthesis?.cancel();
    speaking = false;
    pending?.observation?.finish(completed, error);
    if (prepared?.observation !== pending?.observation) prepared?.observation?.finish(false, error);
    if (error) pending?.reject(error);
    else pending?.resolve(completed);
  }
  function stopAssistantAudio() {
    resetAssistantOutput();
  }
  function resetAssistantOutput(preserveCarry = false) {
    pcm?.stop(preserveCarry);
    playbackEpoch++;
    voiceWait?.finish(null);
    finishAssistantAudio(false);
  }
  function assistantAudioPlaying() {
    if (pcm?.playing()) return true;
    return playback?.started === true && (speaking || !!audio);
  }
  function pauseAssistantAudio(keepAudible = false) {
    if (pcm?.playing()) return pcm.pause(keepAudible);
    pauseWait?.finish(false);
    const pending = playback;
    if (!pending?.started) return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry = {
        timer: null,
        finish(value) {
          if (pauseWait !== entry) return;
          pauseWait = null;
          clearTimeout(entry.timer);
          if (utterance) utterance.onpause = null;
          if (audio) audio.onpause = null;
          resolve(value && playback === pending);
        },
      };
      pauseWait = entry;
      entry.timer = setTimeout(() => {
        entry.finish(false);
        if (playback === pending) resumeAssistantAudio();
      }, 500);
      try {
        if (speaking && utterance && window.speechSynthesis?.pause) {
          utterance.onpause = () => entry.finish(true);
          window.speechSynthesis.pause();
        } else if (audio) {
          audio.onpause = () => entry.finish(true);
          audio.pause();
          if (audio.paused) entry.finish(true);
        } else entry.finish(false);
      } catch {
        entry.finish(false);
      }
    });
  }
  function resumeAssistantAudio() {
    if (pcm?.playing()) return pcm.resume();
    pauseWait?.finish(false);
    const pending = playback;
    if (!pending) return false;
    const failed = () => {
      if (playback === pending) finishAssistantAudio(false);
    };
    try {
      if (speaking && utterance) window.speechSynthesis.resume();
      else if (audio) Promise.resolve(audio.play()).catch(failed);
      else return false;
      return true;
    } catch {
      failed();
      return false;
    }
  }
  function localVoice() {
    if (!window.SpeechSynthesisUtterance) return null;
    return (
      window.speechSynthesis
        ?.getVoices()
        .find((item) => item.localService === true && /^ru(?:-|$)/i.test(item.lang)) || null
    );
  }
  function waitForLocalVoice() {
    voiceWait?.finish(null);
    const voice = localVoice(),
      synth = window.speechSynthesis;
    if (voice || !synth || !window.SpeechSynthesisUtterance) return Promise.resolve(voice);
    return new Promise((resolve) => {
      const entry = {
        timer: null,
        finish(value) {
          if (voiceWait !== entry) return;
          voiceWait = null;
          clearTimeout(entry.timer);
          synth.removeEventListener?.('voiceschanged', changed);
          resolve(value);
        },
      };
      const changed = () => {
        const available = localVoice();
        if (available) entry.finish(available);
      };
      voiceWait = entry;
      synth.addEventListener?.('voiceschanged', changed);
      entry.timer = setTimeout(() => entry.finish(localVoice()), 2000);
      changed();
    });
  }
  async function assistantLocalVoiceReady() {
    const epoch = playbackEpoch,
      generation = state.assistantGeneration,
      voice = await waitForLocalVoice();
    return !!voice && epoch === playbackEpoch && generation === state.assistantGeneration;
  }
  function clearReadyCue(entry) {
    const cue = entry.cue;
    entry.cue = null;
    if (!cue) return;
    clearTimeout(cue.timer);
    if (cue.oscillator) {
      cue.oscillator.onended = null;
      try {
        cue.oscillator.stop();
      } catch {}
      try {
        cue.oscillator.disconnect();
      } catch {}
    }
    try {
      cue.gain?.disconnect();
    } catch {}
  }
  async function readyCue(entry, current, options) {
    if (typeof options.readyCue === 'function') {
      const played = await options.readyCue(options);
      if (monitor !== entry || !current()) return false;
      if (played !== true)
        throw Object.assign(Error('Не удалось включить звуковой сигнал. Нажмите «Продолжить».'), {
          code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
        });
      return true;
    }
    const live = entry.context;
    if (
      monitor !== entry ||
      !current() ||
      !live.destination ||
      typeof live.createOscillator !== 'function' ||
      typeof live.createGain !== 'function'
    )
      return;
    const cue = { oscillator: null, gain: null, timer: null };
    entry.cue = cue;
    try {
      cue.oscillator = live.createOscillator();
      cue.gain = live.createGain();
      const initial =
        options.startCue === true ||
        (options.initialCommand === true && options.shortAnswer !== true);
      const duration = options.shortAnswer === true ? 0.06 : initial ? 0.12 : 0.14;
      const peak = initial ? 0.075 : 0.08;
      cue.oscillator.type = 'sine';
      cue.oscillator.frequency.value = initial ? 523.25 : 880;
      cue.gain.gain.value = peak;
      if (initial && typeof cue.gain.gain.setValueAtTime === 'function') {
        const start = live.currentTime;
        cue.gain.gain.setValueAtTime(0, start);
        cue.gain.gain.linearRampToValueAtTime(peak, start + Math.min(0.018, duration / 4));
        cue.gain.gain.linearRampToValueAtTime(0, start + duration * 0.45);
        cue.oscillator.frequency.setValueAtTime?.(659.25, start + duration * 0.45);
        cue.gain.gain.linearRampToValueAtTime(0.06, start + duration * 0.56);
        cue.gain.gain.linearRampToValueAtTime(0, start + duration);
      }
      cue.oscillator.connect(cue.gain);
      cue.gain.connect(live.destination);
      cue.oscillator.onended = () => clearReadyCue(entry);
      cue.timer = setTimeout(() => clearReadyCue(entry), 250);
      cue.oscillator.start();
      cue.oscillator.stop(live.currentTime + duration);
    } catch {
      clearReadyCue(entry);
    }
  }
  function stopSilenceMonitor() {
    if (!monitor) return;
    const prior = monitor;
    monitor = null;
    clearInterval(prior.timer);
    clearTimeout(prior.resumeTimer);
    prior.cancelResume?.();
    clearReadyCue(prior);
    prior.source?.disconnect();
    prior.analyser?.disconnect();
    prior.silentGain?.disconnect();
    void prior.context.close().catch(() => {});
  }
  async function watchSilence(media, AudioContext, current, onSilence, onEmpty, options = {}) {
    const live = new AudioContext();
    const entry = {
      context: live,
      source: null,
      analyser: null,
      silentGain: null,
      resumeTimer: null,
      cancelResume: null,
      timer: null,
      cue: null,
    };
    monitor = entry;
    const input = live.createMediaStreamSource(media),
      analyser = live.createAnalyser();
    entry.source = input;
    entry.analyser = analyser;
    analyser.fftSize = 2048;
    input.connect(analyser);
    // Keep the microphone graph rendering without playing it through the speakers.
    entry.silentGain = live.createGain();
    entry.silentGain.gain.value = 0;
    analyser.connect(entry.silentGain);
    entry.silentGain.connect(live.destination);
    const samples = new window.Float32Array(analyser.fftSize);
    if (live.state === 'suspended') {
      try {
        const resumed = await Promise.race([
          Promise.resolve(live.resume()).then(() => true),
          new Promise((resolve, reject) => {
            entry.cancelResume = () => resolve(false);
            entry.resumeTimer = setTimeout(
              () =>
                reject(
                  Error(
                    'Не удалось включить обработку микрофона. Нажмите «Микрофон» или запустите диалог снова.',
                  ),
                ),
              3000,
            );
          }),
        ]);
        if (!resumed) return false;
      } finally {
        clearTimeout(entry.resumeTimer);
        entry.cancelResume = null;
      }
    }
    if (monitor !== entry || !current()) return false;
    if (live.state !== 'running')
      throw Error('Обработка микрофона приостановлена. Запустите диалог снова.');
    let started = Date.now(),
      last = started,
      speechMs = 0,
      quietMs = 0,
      heard = false;
    entry.armed = typeof options.readyCue !== 'function';
    entry.arm = () => {
      if (monitor !== entry || !current()) return false;
      started = last = Date.now();
      speechMs = quietMs = 0;
      heard = false;
      entry.speechEndedAt = undefined;
      entry.armed = true;
      return true;
    };
    entry.timer = setInterval(() => {
      if (monitor !== entry || !current() || !entry.armed) return;
      const now = Date.now(),
        delta = Math.max(0, Math.min(100, now - last));
      last = now;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      options.onLevel?.(Math.min(1, rms * 12));
      speechMs = rms >= 0.015 ? speechMs + delta : 0;
      if (rms >= 0.015) entry.speechEndedAt = captureClock();
      if (speechMs >= (options.shortAnswer === true ? 100 : 250)) heard = true;
      if (heard) {
        quietMs = rms >= 0.015 ? 0 : quietMs + delta;
        const silenceMs =
          options.shortSilence === true ||
          (options.shortSilence !== false && options.shortAnswer === true)
            ? 600
            : options.initialCommand === true
              ? 1500
              : 1050;
        if (quietMs >= silenceMs) onSilence();
      } else if (now - started >= 8000) onEmpty();
    }, 50);
    return entry;
  }
  function stopAssistantCapture(discard = false) {
    stopSilenceMonitor();
    clearTimeout(timer);
    timer = null;
    if (discard) {
      sequence++;
      if (recorder) recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
    }
    if (recorder?.state !== 'inactive') recorder?.stop();
    if (discard) recorder = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (discard && context) {
      void context.close().catch(() => {});
      context = null;
    }
  }
  let wavKernelCache = null;
  function wavKernel(inputRate) {
    if (wavKernelCache?.inputRate === inputRate) return wavKernelCache;
    const { min, max, ceil, round, sin, cos, PI } = Math,
      ratio = inputRate / 16000,
      radius = min(192, ceil(16 * ratio)),
      cutoff = 0.45 / ratio;
    let divisor = Number.isSafeInteger(inputRate) ? inputRate : 1,
      remainder = 16000;
    while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
    const phases = min(512, max(1, round(16000 / divisor))),
      kernels = Array.from({ length: phases }, (_, phase) => {
        const weights = new window.Float64Array(radius * 2 + 1),
          fraction = phase / phases;
        let total = 0;
        for (let tap = -radius; tap <= radius; tap++) {
          const distance = tap - fraction,
            angle = (PI * distance) / radius,
            windowed =
              Math.abs(distance) > radius ? 0 : 0.42 + 0.5 * cos(angle) + 0.08 * cos(2 * angle),
            argument = 2 * PI * cutoff * distance,
            weight = 2 * cutoff * (argument ? sin(argument) / argument : 1) * windowed;
          weights[tap + radius] = weight;
          total += weight;
        }
        for (let tap = 0; tap < weights.length; tap++) weights[tap] /= total;
        return weights;
      });
    // Cache only the last rate's filter coefficients, never recording samples.
    wavKernelCache = { inputRate, ratio, radius, phases, kernels };
    return wavKernelCache;
  }
  function wavDownsampler(channels, inputRate, outputLength) {
    if (!(inputRate > 16000) || !channels.length) return null;
    const { min, max, ceil, floor, round, fround } = Math;
    const { ratio, radius, phases, kernels } = wavKernel(inputRate);
    // Bound work to the requested recording, including the filter's final support.
    const sourceLength = min(
        max(...channels.map((channel) => channel.length)),
        ceil((outputLength - 1) * ratio) + radius + 2,
      ),
      mono = channels.length === 1 ? channels[0] : new window.Float32Array(sourceLength);
    if (channels.length > 1) {
      for (let i = 0; i < sourceLength; i++) {
        let value = 0;
        for (const channel of channels) value += channel[min(i, channel.length - 1)] || 0;
        mono[i] = value / channels.length;
      }
    }
    return (position) => {
      const nearest = round(position * phases),
        left = floor(nearest / phases),
        weights = kernels[nearest % phases];
      let value = 0;
      if (left >= radius && left + radius < sourceLength) {
        const start = left - radius;
        for (let tap = 0; tap < weights.length; tap++) value += mono[start + tap] * weights[tap];
      } else {
        for (let tap = -radius; tap <= radius; tap++)
          value += (mono[max(0, min(sourceLength - 1, left + tap))] || 0) * weights[tap + radius];
      }
      // Match the capture's Float32 precision before PCM16 half-step rounding.
      return fround(value);
    };
  }
  function encodeAssistantWav(buffer, maxSeconds = 30) {
    const { min, max, floor, round } = Math,
      rate = 16000,
      length = min(floor(buffer.duration * rate), floor(max(1, min(60, maxSeconds)) * rate));
    if (!length) throw Error('Запись пустая. Повторите короткую фразу.');
    const bytes = new window.ArrayBuffer(44 + length * 2),
      view = new window.DataView(bytes);
    const text = (offset, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, bytes.byteLength - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, length * 2, true);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
        buffer.getChannelData(i),
      ),
      downsample = wavDownsampler(channels, buffer.sampleRate, length);
    for (let i = 0; i < length; i++) {
      const position = (i * buffer.sampleRate) / rate,
        left = floor(position);
      let sample = downsample ? downsample(position) : 0;
      if (!downsample) {
        for (const channel of channels) {
          const a = channel[min(left, channel.length - 1)] || 0;
          const b = channel[min(left + 1, channel.length - 1)] || 0;
          sample += a + (b - a) * (position - left);
        }
        sample /= channels.length;
      }
      sample = max(-1, min(1, sample));
      view.setInt16(44 + i * 2, round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    const values = new window.Uint8Array(bytes);
    if (typeof values.toBase64 === 'function') return values.toBase64();
    let binary = '';
    for (let i = 0; i < values.length; i += 8192)
      binary += String.fromCharCode(...values.subarray(i, i + 8192));
    return window.btoa(binary);
  }
  async function startAssistantCapture(onComplete, onError, maxSeconds = 30, options = {}) {
    const owner = options.voiceOwner;
    const sameVoice =
      options.silenceStop === true &&
      owner &&
      ['epoch', 'session', 'generation'].every(
        (key) => Number.isSafeInteger(owner[key]) && owner[key] >= 0,
      ) &&
      owner.generation === state.assistantGeneration;
    resetAssistantOutput(Boolean(sameVoice));
    stopAssistantCapture(true);
    const generation = sequence,
      assistantGeneration = state.assistantGeneration;
    const limit = Math.max(1, Math.min(60, Number(maxSeconds) || 30));
    let autoStopped = false,
      stopReason = 'manual';
    const startedAt = Date.now();
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia || !AudioContext)
      throw Error('Микрофон недоступен в этом браузере. Введите запрос текстом.');
    const media = options.acquireMedia
      ? await options.acquireMedia()
      : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
    if (generation !== sequence || assistantGeneration !== state.assistantGeneration) {
      media.getTracks().forEach((track) => track.stop());
      return false;
    }
    stream = media;
    const mime = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ].find((type) => window.MediaRecorder.isTypeSupported?.(type));
    let capture;
    try {
      capture = new window.MediaRecorder(media, mime ? { mimeType: mime } : {});
    } catch (error) {
      stopAssistantCapture(true);
      throw error;
    }
    recorder = capture;
    const chunks = [];
    let size = 0;
    const current = () =>
      generation === sequence && assistantGeneration === state.assistantGeneration;
    capture.ondataavailable = (event) => {
      if (!current() || !event.data?.size) return;
      size += event.data.size;
      if (size > 4 * 1024 * 1024) {
        stopAssistantCapture(true);
        onError(Error('Запись слишком большая. Скажите короче.'));
        return;
      }
      chunks.push(event.data);
    };
    capture.onerror = () => {
      if (!current()) return;
      stopAssistantCapture(true);
      onError(Error('Не удалось записать звук. Введите запрос текстом.'));
    };
    let monitoring = null;
    capture.onstop = async () => {
      stopSilenceMonitor();
      clearTimeout(timer);
      media.getTracks().forEach((track) => track.stop());
      if (recorder === capture) {
        recorder = null;
        stream = null;
      }
      if (!current()) return;
      try {
        const blob = new window.Blob(chunks, { type: capture.mimeType });
        if (!blob.size)
          throw Object.assign(Error('Запись пустая. Повторите или введите запрос текстом.'), {
            code: 'ASSISTANT_NO_INPUT',
          });
        const decoder = new AudioContext();
        context = decoder;
        try {
          const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
          if (current())
            onComplete(encodeAssistantWav(decoded, limit), {
              autoStopped,
              seconds:
                stopReason === 'silence'
                  ? Math.max(1, Math.round((Date.now() - startedAt) / 1000))
                  : limit,
              stopReason,
              ...(Number.isFinite(monitoring?.speechEndedAt)
                ? { speechEndedAt: monitoring.speechEndedAt }
                : {}),
            });
        } finally {
          if (context === decoder) context = null;
          await decoder.close().catch(() => {});
        }
      } catch (error) {
        if (current()) onError(error);
      }
    };
    try {
      if (options.silenceStop === true) {
        monitoring = await watchSilence(
          media,
          AudioContext,
          current,
          () => {
            autoStopped = true;
            stopReason = 'silence';
            stopAssistantCapture();
          },
          () => {
            stopAssistantCapture(true);
            onError(
              Object.assign(Error('Речь не обнаружена. Повторите или введите ответ текстом.'), {
                code: 'ASSISTANT_NO_INPUT',
              }),
            );
          },
          options,
        );
        if (!monitoring || !current()) return false;
      }
      // The detector must already be rendering before recording and its ready cue.
      capture.start(500);
      if (monitoring) await readyCue(monitoring, current, options);
      if (!current() || recorder !== capture || capture.state === 'inactive') return false;
      if (monitoring && typeof options.readyCue === 'function') monitoring.arm();
    } catch (error) {
      if (!current()) return false;
      stopAssistantCapture(true);
      throw error;
    }
    timer = setTimeout(() => {
      autoStopped = true;
      stopReason = 'limit';
      stopAssistantCapture();
    }, limit * 1000);
    return true;
  }
  function assistantStreamUrl(result) {
    if (result.streamUrl == null) return null;
    if (typeof result.streamUrl !== 'string' || result.audioBase64 != null)
      throw Error('Не удалось воспроизвести ответ.');
    const match =
      /^\/api\/assistant\/speak-audio\?ticket=[A-Za-z0-9_-]{43}&accountContext=([^&#]*)&organizationContext=([^&#]*)$/u.exec(
        result.streamUrl,
      );
    if (!match) throw Error('Не удалось воспроизвести ответ.');
    let account, organization;
    try {
      account = decodeURIComponent(match[1]);
      organization = decodeURIComponent(match[2]);
    } catch {
      throw Error('Не удалось воспроизвести ответ.');
    }
    if (
      (state.multiUser && !state.account?.id) ||
      account !== (state.account?.id || '') ||
      organization !== (state.account?.organizationId || '')
    )
      throw audioContextError();
    return result.streamUrl;
  }
  function prepareAssistantAudio(result) {
    if (result?.mimeType === 'audio/pcm') {
      resetAssistantOutput(true);
      if (!pcm?.supported())
        throw Object.assign(Error('Потоковый звук недоступен в этом браузере.'), {
          code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
        });
      return pcm.prepare(result);
    }
    const source = assistantStreamUrl(result);
    if (!source) return null;
    stopAssistantAudio();
    const observation = observeNative(result);
    let media;
    try {
      media = leasedAssistantMedia() || new window.Audio();
    } catch (error) {
      observation?.finish(false, error);
      throw error;
    }
    const entry = {
      media,
      observation,
      preparedCreatedAt: captureClock(),
      epoch: playbackEpoch,
      generation: state.assistantGeneration,
      identity: audioIdentity(),
      actor: audioActor(),
      failed: null,
      started: false,
    };
    const owns = () => preparedAudio === entry && audio === media && playbackEpoch === entry.epoch;
    preparedAudio = entry;
    audio = media;
    audioUrl = source;
    try {
      media.preload = 'auto';
      media.onerror = (event) => {
        if (!owns() || entry.identity !== audioIdentity()) return;
        entry.failed = audioFailureDetails('preload', event, media);
        entry.observation?.finish(false, Error('Native preload failed'));
        void nativeAudioFailure(entry, owns);
      };
      media.onwaiting = () => {
        if (owns() && entry.identity === audioIdentity()) entry.observation?.event('mediaWaiting');
      };
      media.onstalled = () => {
        if (owns() && entry.identity === audioIdentity()) entry.observation?.event('mediaStalled');
      };
      replaceAssistantSource(media, source);
      media.load?.();
    } catch {
      stopAssistantAudio();
      throw Error('Не удалось подготовить голосовой ответ.');
    }
    return {
      play() {
        if (!owns() || entry.started) return Promise.resolve(false);
        if (entry.identity !== audioIdentity()) {
          stopAssistantAudio();
          return Promise.resolve(false);
        }
        entry.started = true;
        if (entry.failed) {
          return nativeAudioFailure(entry, owns).then((error) => {
            if (!owns()) return false;
            if (error?.code !== 'AUTH_CONTEXT_CHANGED') reportAudioFailure(entry.failed);
            stopAssistantAudio();
            if (error) throw error;
            return false;
          });
        }
        return startAssistantPlayback(result, null, media);
      },
      cancel() {
        if (owns()) stopAssistantAudio();
      },
    };
  }
  function playAssistantAudio(result) {
    resetAssistantOutput(result?.mimeType === 'audio/pcm');
    if (result?.mimeType === 'audio/pcm') {
      if (!pcm?.supported())
        throw Object.assign(Error('Потоковый звук недоступен в этом браузере.'), {
          code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
        });
      return pcm.play(result);
    }
    const source = assistantStreamUrl(result);
    if (source) {
      audioUrl = source;
    } else if (result.audioBase64 == null) {
      const voice = localVoice();
      if (voice) return startAssistantPlayback(result, voice);
      const epoch = playbackEpoch,
        generation = state.assistantGeneration;
      return waitForLocalVoice().then((available) => {
        if (epoch !== playbackEpoch || generation !== state.assistantGeneration) return false;
        if (!available)
          throw Error(
            'Локальный русский голос недоступен. Добавьте русский голос в настройках речи устройства или продолжите на экране.',
          );
        return startAssistantPlayback(result, available);
      });
    } else {
      const maximumBytes = 4 * 1024 * 1024;
      if (
        !/^audio\/(?:wav|mpeg|ogg|mp4)$/.test(result.mimeType) ||
        typeof result.audioBase64 !== 'string' ||
        !result.audioBase64.length ||
        result.audioBase64.length > Math.ceil(maximumBytes / 3) * 4 ||
        result.audioBase64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(result.audioBase64)
      )
        throw Error('Не удалось воспроизвести ответ.');
      const binary = window.atob(result.audioBase64);
      if (binary.length > maximumBytes || window.btoa(binary) !== result.audioBase64)
        throw Error('Не удалось воспроизвести ответ.');
      const bytes = window.Uint8Array.from(binary, (value) => value.charCodeAt(0));
      audioUrl = URL.createObjectURL(new window.Blob([bytes], { type: result.mimeType }));
      audioBlobUrl = true;
    }
    return startAssistantPlayback(result, null);
  }
  function startAssistantPlayback(result, voice, preparedMedia = null) {
    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        started: false,
        identity: audioIdentity(),
        actor: audioActor(),
        failing: false,
        observation: preparedMedia ? preparedAudio?.observation : observeNative(result, !!voice),
        preparedCreatedAt: preparedMedia ? preparedAudio?.preparedCreatedAt : captureClock(),
      };
      playback = pending;
      const failed = async (stage, error) => {
        if (playback !== pending || pending.failing) return;
        pending.failing = true;
        if (result.streamUrl && error?.name !== 'NotAllowedError') {
          const refusal = await nativeAudioFailure(pending, () => playback === pending);
          if (playback !== pending) return;
          if (refusal?.code !== 'AUTH_CONTEXT_CHANGED')
            reportAudioFailure(audioFailureDetails(stage, error, audio, pending.started));
          finishAssistantAudio(false, refusal);
          return;
        }
        if (error?.name === 'NotAllowedError' && audioLease?.media === audio)
          audioLease.unlocked = false;
        reportAudioFailure(audioFailureDetails(stage, error, audio, pending.started));
        finishAssistantAudio(
          false,
          Object.assign(
            Error(
              error?.name === 'NotAllowedError'
                ? 'Браузер заблокировал звук. Нажмите «Озвучить» для повторного запуска.'
                : 'Не удалось воспроизвести ответ. Ответ показан текстом.',
            ),
            error?.name === 'NotAllowedError' ? { code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED' } : {},
          ),
        );
      };
      try {
        if (voice) {
          utterance = new window.SpeechSynthesisUtterance(result.text || '');
          utterance.voice = voice;
          utterance.rate = 2;
          utterance.lang = voice.lang;
          utterance.onstart = () => {
            if (playback !== pending) return;
            if (!pending.started) markNativeStarted(pending);
            pending.started = true;
            result.onStarted?.();
          };
          utterance.onend = () => {
            if (playback === pending) finishAssistantAudio(true);
          };
          utterance.onerror = (event) => failed('speech-error', event);
          speaking = true;
          window.speechSynthesis.speak(utterance);
        } else {
          audio = preparedMedia || leasedAssistantMedia() || new window.Audio(audioUrl);
          if (!preparedMedia && audioLease?.media === audio)
            replaceAssistantSource(audio, audioUrl);
          audio.playbackRate = 1.4;
          audio.preservesPitch = true;
          audio.onplaying = () => {
            if (playback !== pending) return;
            if (result.streamUrl && pending.identity !== audioIdentity()) {
              finishAssistantAudio(false);
              return;
            }
            if (!pending.started) markNativeStarted(pending);
            pending.started = true;
            result.onStarted?.();
          };
          audio.onended = () => {
            if (playback === pending)
              finishAssistantAudio(!result.streamUrl || pending.identity === audioIdentity());
          };
          audio.onerror = (event) => failed('media-error', event);
          audio.onwaiting = () => {
            if (playback === pending && pending.identity === audioIdentity())
              pending.observation?.event('mediaWaiting');
          };
          audio.onstalled = () => {
            if (playback === pending && pending.identity === audioIdentity())
              pending.observation?.event('mediaStalled');
          };
          Promise.resolve(audio.play()).catch((error) => failed('play-rejection', error));
        }
      } catch (error) {
        failed('play-exception', error);
      }
    });
  }
  return {
    assistantAudioFormat,
    playAssistantReadyCue,
    stopAssistantAudio,
    unlockAssistantAudio,
    releaseAssistantAudio,
    assistantOutputReference: () => pcm?.reference?.() || null,
    assistantAudioPlaying,
    pauseAssistantAudio,
    resumeAssistantAudio,
    stopAssistantCapture,
    encodeAssistantWav,
    startAssistantCapture,
    assistantLocalVoiceReady,
    playAssistantAudio,
    prepareAssistantAudio,
  };
}
