function createAssistantBargeIn(state, actions) {
  const captureClock = () => {
    try {
      return globalThis.performance?.now?.();
    } catch {
      return undefined;
    }
  };
  let epoch = 0,
    active = null,
    last = { phase: 'idle', ready: false, reason: '' };
  function assistantBargeInState() {
    return { ...last };
  }
  function stopAssistantBargeIn(discard = true) {
    const entry = active;
    if (!entry) {
      epoch++;
      return;
    }
    if (!discard && entry.phase === 'capturing') return entry.finish('manual');
    epoch++;
    active = null;
    clearTimeout(entry.timer);
    clearTimeout(entry.loadTimer);
    entry.cancelLoad?.();
    clearInterval(entry.guard);
    window.removeEventListener?.('pagehide', entry.hidden);
    if (entry.processor) {
      entry.processor.onprocessorerror = null;
      entry.processor.port.onmessage = null;
      entry.processor.port.postMessage({ type: 'stop' });
      entry.processor.port.close();
    }
    for (const node of [entry.source, entry.referenceSource, entry.processor, entry.gain]) {
      try {
        node?.disconnect();
      } catch {}
    }
    entry.media?.getTracks().forEach((track) => {
      track.removeEventListener?.('ended', entry.ended);
      track.stop();
    });
    entry.echoProof?.close();
    void entry.context?.close().catch(() => {});
    entry.signal?.clear();
    entry.frames.length = 0;
    entry.takeoverFrames.length = 0;
    if (entry.phase === 'pausing' || entry.phase === 'confirming') actions.resumeAssistantAudio();
    last = { ...last, phase: 'idle', ready: false };
  }
  async function startAssistantBargeIn(onComplete, onError, maxSeconds = 30, options = {}) {
    stopAssistantBargeIn(true);
    const token = epoch,
      generation = state.assistantGeneration;
    const current = () =>
      token === epoch && generation === state.assistantGeneration && options.current?.() !== false;
    const audioDiagnostic = (event) => {
      try {
        actions.recordAssistantAudioDiagnostic?.(event);
      } catch {}
    };
    const diagnosticFor = (stage, error) => {
      const names = [
        'NotAllowedError',
        'OverconstrainedError',
        'NotSupportedError',
        'InvalidStateError',
        'AbortError',
        'SecurityError',
        'NetworkError',
        'OperationError',
        'TypeError',
        'RangeError',
        'Error',
      ];
      const constraints = [
        'echoCancellation',
        'channelCount',
        'sampleRate',
        'noiseSuppression',
        'autoGainControl',
      ];
      return {
        stage,
        name: names.includes(error?.name) ? error.name : 'UnknownError',
        ...(error?.name === 'OverconstrainedError' && constraints.includes(error.constraint)
          ? { constraint: error.constraint }
          : {}),
      };
    };
    const recordingOnly = options.initialCapture === true;
    let verifiedEcho = null;
    const status = (reason, ready = false, diagnostic = null, fallbackAllowed = false) => {
      last = {
        phase: ready ? 'listening' : 'unavailable',
        ready,
        reason,
        echoCancellation: ready ? verifiedEcho : null,
        ...(diagnostic ? { diagnostic } : {}),
      };
      options.onStatus?.({ ...last });
      return {
        ready,
        reason,
        ...(ready ? { echoCancellation: verifiedEcho } : {}),
        ...(recordingOnly && !ready ? { fallbackAllowed } : {}),
      };
    };
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext || !window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia)
      return status(
        'Голосовое прерывание недоступно в этом браузере. Ответьте после озвучивания.',
        false,
        null,
        true,
      );
    let media,
      live,
      entry,
      stage = 'acquire-media';
    try {
      if (options.acquireMedia) media = await options.acquireMedia();
      else if (recordingOnly)
        media = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      else {
        try {
          media = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: { exact: 'all' },
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
            video: false,
          });
        } catch (error) {
          if (error?.name !== 'OverconstrainedError' || error.constraint !== 'echoCancellation')
            throw error;
          if (!current()) return { ready: false, reason: 'cancelled' };
          media = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: { exact: true },
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
            video: false,
          });
        }
      }
      if (!current()) {
        media.getTracks().forEach((track) => track.stop());
        return { ready: false, reason: 'cancelled' };
      }
      stage = 'echo-verification';
      const actualEcho = media.getAudioTracks()[0]?.getSettings?.().echoCancellation;
      if (!recordingOnly && actualEcho !== true && actualEcho !== 'all') {
        media.getTracks().forEach((track) => track.stop());
        return status('Браузер не подтвердил подавление эха. Ответьте после озвучивания.');
      }
      verifiedEcho = actualEcho === true || actualEcho === 'all' ? actualEcho : null;
      stage = 'audio-context';
      // Let the device choose its supported clock, as ordinary capture already
      // does. Detection uses live.sampleRate; WAV encoding still normalizes16k.
      live = new AudioContext();
      if (!live.audioWorklet?.addModule) throw Error('Нет обработчика звука');
      stage = 'signal-initialization';
      entry = {
        media,
        context: live,
        source: null,
        processor: null,
        gain: null,
        timer: null,
        guard: null,
        frames: [],
        takeoverFrames: [],
        takeoverSamples: 0,
        interlude: false,
        phase: 'loading',
        signal: actions.assistantBargeSignal(live.sampleRate),
        quietMs: 0,
        initialOnsetMs: 0,
        initialOnsetSpanMs: 0,
        initialOnsetGapMs: 0,
        confirmMs: 0,
        tailMs: 0,
        confirmElapsed: 0,
        captureSamples: 0,
        silentTailSamples: 0,
        rejectedEchoes: 0,
        onsetPeakRms: 0,
        preProbe: null,
        interrupted: false,
        answerAfter: null,
        hidden: null,
        ended: null,
      };
      active = entry;
      const isCurrent = () => active === entry && current();
      entry.reference = actions.assistantOutputReference?.();
      if (entry.reference?.stream && entry.reference.current())
        entry.echoProof = actions.assistantEchoProof(
          live.sampleRate,
          () => isCurrent() && entry.reference.current(),
        );
      const fail = (error, failureStage = 'processor-runtime') => {
        if (!isCurrent()) return;
        status(
          'Голосовое прерывание остановлено. Ответьте после озвучивания.',
          false,
          diagnosticFor(failureStage, error),
        );
        stopAssistantBargeIn(true);
        onError(error);
      };
      entry.finish = (reason) => {
        if (!isCurrent() || entry.phase !== 'capturing') return;
        const rate = live.sampleRate;
        // Leave a quiet margin and trim only a contiguous near-zero tail
        // on the recording-only path, after the normal endpoint has fired.
        const trim =
          recordingOnly && reason === 'silence'
            ? Math.max(0, entry.silentTailSamples - Math.ceil(rate * 0.3))
            : 0;
        const length = entry.captureSamples - trim;
        const samples = new window.Float32Array(length);
        let offset = 0;
        for (const frame of entry.frames) {
          const remaining = length - offset;
          if (remaining <= 0) break;
          const part = frame.length > remaining ? frame.subarray(0, remaining) : frame;
          samples.set(part, offset);
          offset += part.length;
        }
        const seconds = length / rate;
        let wav;
        try {
          wav = actions.encodeAssistantWav(
            {
              duration: seconds,
              sampleRate: rate,
              numberOfChannels: 1,
              getChannelData: () => samples,
            },
            maxSeconds,
          );
        } catch (error) {
          fail(error);
          return;
        }
        stopAssistantBargeIn(true);
        if (generation === state.assistantGeneration && options.current?.() !== false)
          onComplete(wav, {
            autoStopped: reason !== 'manual',
            stopReason: reason,
            interrupted: entry.interrupted,
            seconds,
            ...(Number.isFinite(entry.speechEndedAt) ? { speechEndedAt: entry.speechEndedAt } : {}),
          });
      };
      entry.hidden = () => {
        if (active === entry) stopAssistantBargeIn(true);
      };
      entry.ended = () => {
        if (!isCurrent()) return;
        if (entry.phase === 'answerListening' || entry.phase === 'capturing')
          fail(Error('Микрофон отключён. Можно продолжить на экране.'));
        else stopAssistantBargeIn(true);
      };
      window.addEventListener?.('pagehide', entry.hidden, { once: true });
      media
        .getTracks()
        .forEach((track) => track.addEventListener?.('ended', entry.ended, { once: true }));
      entry.guard = setInterval(() => {
        if (!isCurrent() && active === entry) stopAssistantBargeIn(true);
        else if (
          isCurrent() &&
          live.state === 'closed' &&
          (entry.phase === 'answerListening' || entry.phase === 'capturing')
        )
          fail(Error('Обработка микрофона остановлена. Можно продолжить на экране.'));
      }, 100);
      stage = 'worklet-load';
      const version = document.querySelector('meta[name="cartoteca-build"]')?.content;
      if (!version) throw Error('Нет версии приложения');
      try {
        await Promise.race([
          live.audioWorklet.addModule(
            '/assistant-capture-worklet.js?v=' + encodeURIComponent(version),
          ),
          new Promise((resolve, reject) => {
            entry.cancelLoad = () => reject(Error('cancelled'));
            entry.loadTimer = setTimeout(() => reject(Error('Audio module timeout')), 8000);
          }),
        ]);
      } finally {
        clearTimeout(entry.loadTimer);
        entry.cancelLoad = null;
      }
      if (!isCurrent()) {
        if (active === entry) stopAssistantBargeIn(true);
        return { ready: false, reason: 'cancelled' };
      }
      entry.phase = 'listening';
      stage = 'media-source';
      entry.source = live.createMediaStreamSource(media);
      stage = 'processor-node';
      const createProcessor = (pairedReference) =>
        new window.AudioWorkletNode(live, 'cartoteca-assistant-capture-v1', {
          numberOfInputs: pairedReference ? 2 : 1,
          processorOptions: { pairedReference },
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
        });
      if (entry.echoProof) {
        let referenceSource, pairedProcessor;
        try {
          if (entry.reference.current()) {
            referenceSource = live.createMediaStreamSource(entry.reference.stream);
            pairedProcessor = createProcessor(true);
            referenceSource.connect(pairedProcessor, 0, 1);
            entry.referenceSource = referenceSource;
            entry.processor = pairedProcessor;
          }
        } catch {
          try {
            referenceSource?.disconnect();
          } catch {}
          try {
            pairedProcessor?.disconnect();
          } catch {}
          try {
            pairedProcessor?.port.postMessage({ type: 'stop' });
          } catch {}
          try {
            pairedProcessor?.port.close();
          } catch {}
        }
        if (!entry.processor) {
          entry.echoProof.close();
          entry.echoProof = null;
        }
      }
      entry.processor ??= createProcessor(false);
      entry.processor.onprocessorerror = () =>
        fail(Error('Обработка микрофона остановлена. Ответьте после озвучивания.'));
      stage = 'audio-graph';
      entry.gain = live.createGain();
      entry.gain.gain.value = 0;
      entry.source.connect(entry.processor);
      entry.processor.connect(entry.gain);
      entry.gain.connect(live.destination);
      const limit = Math.max(1, Math.min(60, Number(maxSeconds) || 30));
      const answerListening = (interlude = false) => {
        if (
          !isCurrent() ||
          live.state !== 'running' ||
          entry.interrupted ||
          entry.answerAfter !== null ||
          actions.assistantAudioPlaying() ||
          !['listening', 'pausing', 'confirming', 'echoBlocked'].includes(entry.phase)
        )
          return false;
        // Worklet timestamps mark the end of a frame. Only samples after this fence
        // can prove a new answer; playback history and its learned noise stay behind.
        entry.answerAfter = live.currentTime;
        entry.interlude = interlude;
        entry.phase = 'answerListening';
        entry.signal = actions.assistantBargeSignal(live.sampleRate);
        entry.frames.length = 0;
        entry.takeoverFrames.length = entry.takeoverSamples = 0;
        entry.preProbe = null;
        entry.captureSamples = entry.quietMs = entry.initialOnsetMs = 0;
        entry.silentTailSamples = 0;
        entry.initialOnsetSpanMs = entry.initialOnsetGapMs = 0;
        entry.speechEndedAt = undefined;
        last = { phase: 'listening', ready: true, reason: '', echoCancellation: verifiedEcho };
        entry.timer = setTimeout(() => {
          // A slow next audio request is not user silence: release only this warm watcher.
          if (entry.interlude && entry.phase === 'answerListening') stopAssistantBargeIn(true);
          else fail(Object.assign(Error('Не услышал ответ.'), { code: 'ASSISTANT_NO_INPUT' }));
        }, 8000);
        return true;
      };
      const continuePlayback = () =>
        isCurrent() && !entry.interrupted && ['listening', 'answerListening'].includes(entry.phase);
      const playbackStarted = () => {
        if (!isCurrent() || entry.interrupted || entry.phase === 'capturing') return false;
        entry.preProbe = null;
        if (entry.interlude) {
          clearTimeout(entry.timer);
          entry.timer = null;
          entry.answerAfter = null;
          entry.interlude = false;
          entry.phase = 'listening';
          // Preserve a reply prefix across native startup; the pause/echo proof stays mandatory.
        }
        entry.rejectedEchoes = 0;
        return entry.phase === 'listening';
      };
      const rememberTakeover = (samples) => {
        const remaining = Math.max(0, Math.floor(limit * live.sampleRate) - entry.takeoverSamples);
        if (!remaining) return;
        const frame = new window.Float32Array(samples.subarray(0, remaining));
        entry.takeoverFrames.push(frame);
        entry.takeoverSamples += frame.length;
      };
      const consumeSamples = (incoming, frameTime) => {
        let samples = incoming;
        // Queued pre-pause PCM cannot prove speech after playback actually paused.
        if (entry.phase === 'confirming' && frameTime <= entry.confirmAfter) return;
        if (entry.answerAfter !== null) {
          if (frameTime <= entry.answerAfter) return;
          const start = frameTime - samples.length / live.sampleRate;
          if (start < entry.answerAfter) {
            const skip = Math.ceil((entry.answerAfter - start) * live.sampleRate);
            samples = samples.subarray(Math.min(samples.length, skip));
            if (!samples.length) return;
          }
        }
        if (!isCurrent()) {
          if (active === entry) stopAssistantBargeIn(true);
          return;
        }
        // Recording alone does not establish an echo-safe playback watcher. Before
        // the ready cue/fence, PCM must neither arm VAD nor enter its prebuffer.
        if (recordingOnly && entry.phase === 'listening') return;
        let detection = entry.signal.inspect(samples);
        if (recordingOnly) {
          let power = 0;
          for (const value of samples) power += value * value;
          const voiced = Math.sqrt(power / samples.length) >= 0.015;
          // Keep short within-word gaps without requiring a continuous loud vowel.
          // The complete candidate must fit the existing 400ms prebuffer; silence
          // alone never triggers capture and long gaps discard the candidate.
          if (entry.phase === 'answerListening' && (voiced || entry.initialOnsetMs > 0)) {
            entry.initialOnsetSpanMs += detection.ms;
            entry.initialOnsetGapMs = voiced ? 0 : entry.initialOnsetGapMs + detection.ms;
            if (entry.initialOnsetSpanMs > 400 || entry.initialOnsetGapMs > 96) {
              entry.initialOnsetMs = entry.initialOnsetSpanMs = entry.initialOnsetGapMs = 0;
            }
            if (voiced) {
              entry.initialOnsetMs += detection.ms;
              if (!entry.initialOnsetSpanMs) entry.initialOnsetSpanMs = detection.ms;
            }
          }
          detection = { ...detection, voiced, onsetMs: entry.initialOnsetMs };
        }
        if (entry.phase === 'pausing' || entry.phase === 'confirming') rememberTakeover(samples);
        if (
          detection.voiced &&
          ['capturing', 'answerListening', 'pausing', 'confirming'].includes(entry.phase)
        )
          entry.speechEndedAt = captureClock();
        if (['answerListening', 'capturing'].includes(entry.phase))
          options.onLevel?.(detection.voiced ? 0.8 : 0);
        if (entry.phase === 'capturing') {
          const remaining = Math.max(0, Math.floor(limit * live.sampleRate) - entry.captureSamples);
          const frame = new window.Float32Array(samples.subarray(0, remaining));
          entry.frames.push(frame);
          entry.captureSamples += frame.length;
          if (recordingOnly) {
            // A sample that would quantize to a nonzero PCM16 value is retained.
            entry.silentTailSamples =
              !detection.voiced && frame.every((sample) => Math.abs(sample) < 1 / 65536)
                ? entry.silentTailSamples + frame.length
                : 0;
          }
          entry.quietMs = detection.voiced ? 0 : entry.quietMs + detection.ms;
          if (entry.captureSamples >= limit * live.sampleRate) entry.finish('limit');
          else if (
            entry.quietMs >=
            (options.shortSilence === true ||
            (options.shortSilence !== false && options.shortAnswer === true)
              ? 600
              : recordingOnly && options.initialCommand === true
                ? 1500
                : 1050)
          )
            entry.finish('silence');
          return;
        }
        if (entry.phase === 'answerListening') {
          entry.signal.remember(samples);
          if (detection.voiced && detection.onsetMs >= (options.shortAnswer === true ? 100 : 250)) {
            clearTimeout(entry.timer);
            entry.phase = 'capturing';
            entry.frames = entry.signal.prebuffer();
            entry.captureSamples = entry.frames.reduce((sum, frame) => sum + frame.length, 0);
            entry.signal.clear();
            last = { phase: 'capturing', ready: true, reason: '', echoCancellation: verifiedEcho };
            if (entry.interlude) {
              entry.interrupted = true;
              options.onInterrupt?.();
              if (!isCurrent()) return;
            }
            entry.timer = setTimeout(() => entry.finish('limit'), limit * 1000);
          }
          return;
        }
        if (entry.phase === 'listening' && !actions.assistantAudioPlaying()) {
          entry.signal.clear();
          entry.onsetPeakRms = 0;
          entry.preProbe = null;
          return;
        }
        entry.signal.remember(samples);
        const pcmPlayback = entry.phase === 'listening' ? entry.reference?.playbackId?.() : null;
        const referenceEcho =
          (entry.phase === 'listening' || (entry.phase === 'confirming' && entry.ducked)) &&
          actions.assistantAudioPlaying()
            ? entry.echoProof?.echo(detection, pcmPlayback) === true
            : false;
        if (referenceEcho) entry.signal.discardEchoDetectionUpdate();
        if (entry.phase === 'listening') {
          entry.onsetPeakRms =
            detection.voiced && !referenceEcho ? Math.max(entry.onsetPeakRms, detection.rms) : 0;
          if (!detection.voiced || referenceEcho) entry.preProbe = null;
        }
        if (entry.phase === 'listening' && detection.onsetMs >= 64 && !referenceEcho) {
          const beforeProbeRms =
            entry.preProbe && entry.preProbe.playback === pcmPlayback
              ? entry.preProbe.rms
              : entry.onsetPeakRms;
          if (entry.echoProof?.deferProbe?.()) {
            entry.preProbe = { playback: pcmPlayback, rms: beforeProbeRms };
            return;
          }
          entry.preProbe = null;
          entry.onsetPeakRms = 0;
          entry.takeoverFrames = entry.signal.prebuffer();
          entry.takeoverSamples = entry.takeoverFrames.reduce(
            (sum, frame) => sum + frame.length,
            0,
          );
          entry.phase = 'pausing';
          last.phase = 'checking';
          Promise.resolve(actions.pauseAssistantAudio(true))
            .then((paused) => {
              if (!isCurrent() || entry.phase !== 'pausing') return;
              if (!paused) {
                if (!actions.assistantAudioPlaying()) {
                  entry.phase = 'listening';
                  entry.takeoverFrames.length = entry.takeoverSamples = 0;
                  entry.signal.clear();
                  last.phase = 'listening';
                  return;
                }
                stopAssistantBargeIn(true);
                status('Браузер не подтвердил паузу озвучивания. Ответьте после озвучивания.');
                return;
              }
              entry.ducked = paused === 'ducked';
              // PCM drops to one eighth. Residual at a comparable attenuation
              // cannot by itself establish an independent voice.
              entry.probeFloor = entry.ducked ? beforeProbeRms / 4 : 0;
              if (entry.ducked) entry.echoProof?.reset?.();
              else audioDiagnostic('bargePause');
              entry.phase = 'confirming';
              entry.confirmAfter = live.currentTime;
              entry.tailMs = entry.confirmMs = entry.confirmElapsed = 0;
            })
            .catch(() =>
              fail(Error('Не удалось приостановить ответ. Продолжите после озвучивания.')),
            );
        } else if (entry.phase === 'confirming') {
          const priorTail = entry.tailMs;
          entry.tailMs += detection.ms;
          if (priorTail < 120) return;
          entry.confirmElapsed += detection.ms;
          const freshVoice =
            detection.voiced && !referenceEcho && detection.rms >= entry.probeFloor;
          entry.confirmMs = freshVoice ? entry.confirmMs + detection.ms : 0;
          if (entry.confirmMs >= 64) {
            audioDiagnostic('bargeInterrupt');
            entry.interrupted = true;
            entry.phase = 'capturing';
            entry.frames = entry.takeoverFrames;
            entry.captureSamples = entry.takeoverSamples;
            entry.takeoverFrames = [];
            entry.takeoverSamples = 0;
            entry.signal.clear();
            last = { phase: 'capturing', ready: true, reason: '', echoCancellation: verifiedEcho };
            actions.stopAssistantAudio();
            options.onInterrupt?.();
            if (!isCurrent()) {
              if (active === entry) stopAssistantBargeIn(true);
              return;
            }
            entry.timer = setTimeout(() => entry.finish('limit'), limit * 1000);
          } else if (referenceEcho || entry.confirmElapsed >= 160) {
            // A verified output match ends the probe without spending the unresolved-echo limit.
            if (!referenceEcho) {
              if (!entry.ducked) audioDiagnostic('bargeFalsePause');
              entry.rejectedEchoes++;
            }
            if (entry.rejectedEchoes >= 2) {
              entry.phase = 'echoBlocked';
              entry.takeoverFrames.length = entry.takeoverSamples = 0;
              entry.signal.clear();
              actions.resumeAssistantAudio();
              status(
                'Микрофон улавливает эхо ответа. Голосовое прерывание отключено до конца озвучивания.',
              );
              return;
            }
            entry.phase = 'listening';
            entry.takeoverFrames.length = entry.takeoverSamples = 0;
            entry.signal.clear();
            actions.resumeAssistantAudio();
            last.phase = 'listening';
          }
        }
      };
      entry.processor.port.onmessage = ({ data }) => {
        if (!isCurrent()) {
          if (active === entry) stopAssistantBargeIn(true);
          return;
        }
        if (
          data?.type !== 'pcm' ||
          !(data.samples instanceof window.Float32Array) ||
          data.samples.length !== 512 ||
          !Number.isFinite(data.time)
        ) {
          fail(Error('Обработка микрофона остановлена. Ответьте после озвучивания.'));
          return;
        }
        entry.echoProof?.feed(data.samples, data.reference, data.time);
        consumeSamples(data.samples, data.time);
        if (isCurrent()) entry.processor.port.postMessage({ type: 'ack' });
      };
      stage = 'context-resume';
      if (live.state === 'suspended' || live.state === 'interrupted') {
        await Promise.race([
          Promise.resolve(live.resume()),
          new Promise((resolve, reject) => {
            entry.cancelLoad = () => resolve(false);
            entry.loadTimer = setTimeout(
              () => reject(Error('Обработка микрофона приостановлена.')),
              3000,
            );
          }),
        ]);
        clearTimeout(entry.loadTimer);
        entry.cancelLoad = null;
      }
      if (!isCurrent()) {
        if (active === entry) stopAssistantBargeIn(true);
        return { ready: false, reason: 'cancelled' };
      }
      stage = 'context-ready';
      if (live.state !== 'running') throw Error('Обработка микрофона приостановлена.');
      if (recordingOnly) {
        stage = 'ready-cue';
        const cue = await options.readyCue?.({
          initialCommand: options.initialCommand,
          startCue: options.startCue,
          shortAnswer: options.shortAnswer,
          captureMedia: media,
          current: isCurrent,
        });
        if (!isCurrent()) return { ready: false, reason: 'cancelled' };
        if (cue === false)
          throw Error('Не удалось включить звук готовности. Запустите диалог снова.');
        return { ...status('', true), listen: () => answerListening() };
      }
      return {
        ...status('', true),
        listen: () => answerListening(),
        wait: () => answerListening(true),
        continuePlayback,
        playbackStarted,
      };
    } catch (error) {
      const relevant = current();
      if (entry) {
        if (active === entry) stopAssistantBargeIn(true);
      } else {
        media?.getTracks().forEach((track) => track.stop());
        if (live) void live.close().catch(() => {});
      }
      if (!relevant) return { ready: false, reason: 'cancelled' };
      const failed = status(
        error.name === 'NotAllowedError'
          ? 'Доступ к микрофону закрыт. Разрешите его в браузере или введите ответ.'
          : 'Не удалось подготовить микрофон для прерывания. Ответьте после озвучивания.',
        false,
        diagnosticFor(stage, error),
        recordingOnly && !['acquire-media', 'ready-cue'].includes(stage),
      );
      return recordingOnly ? { ...failed, error } : failed;
    }
  }
  return { startAssistantBargeIn, stopAssistantBargeIn, assistantBargeInState };
}
