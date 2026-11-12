function createAssistantSpeech(state, actions) {
  function assistantSpeechController(ui) {
    let voiceEnabled = false,
      epoch = 0,
      speechBusy = false,
      capturing = false,
      activeBarge = null,
      startCue = false,
      microphone = null,
      voicePaused = false,
      lastSpeech = null,
      usedTurnTicket = null,
      initialCommand = true,
      unclearCommands = 0;
    const activity = (nextBusy, recording) => {
      speechBusy = nextBusy;
      ui.activity(nextBusy, recording);
      ui.phase?.(recording ? 'listening' : nextBusy ? 'pending' : 'idle');
    };
    const token = () => ({ epoch, session: ui.session, generation: state.assistantGeneration });
    const current = (value) =>
      ui.valid() &&
      value.epoch === epoch &&
      value.session === ui.session &&
      value.generation === state.assistantGeneration;
    function stopBarge() {
      activeBarge = null;
      actions.stopAssistantBargeIn?.(true);
    }
    function listeningBarge() {
      return Boolean(activeBarge?.listening && voiceEnabled && current(activeBarge.captured));
    }
    function releaseMicrophone() {
      const entry = microphone;
      microphone = null;
      if (!entry) return;
      entry.closed = true;
      entry.root?.getAudioTracks().forEach((track) => {
        track.removeEventListener?.('ended', entry.ended);
        track.removeEventListener?.('mute', entry.muted);
        track.removeEventListener?.('unmute', entry.unmuted);
      });
      for (const media of [entry.root, ...entry.clones])
        media?.getTracks().forEach((track) => track.stop());
      entry.clones.clear();
    }
    async function sessionMicrophone(captured, allEcho = false) {
      const stopped = () =>
        Object.assign(Error('Голосовой диалог остановлен.'), { name: 'AbortError' });
      if (!voiceEnabled || !current(captured)) throw stopped();
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error('Микрофон недоступен в этом браузере. Введите запрос текстом.');
      const entry =
        microphone ||
        (microphone = {
          session: ui.session,
          generation: state.assistantGeneration,
          root: null,
          pending: null,
          clones: new Set(),
          closed: false,
          ended: null,
          muted: null,
          unmuted: null,
          bargeEchoMode: null,
        });
      const owned = () =>
        microphone === entry &&
        !entry.closed &&
        voiceEnabled &&
        ui.valid() &&
        entry.session === ui.session &&
        entry.generation === state.assistantGeneration &&
        (typeof document === 'undefined' || !document.hidden);
      if (!owned()) {
        if (microphone === entry) releaseMicrophone();
        throw stopped();
      }
      if (!entry.root && !entry.pending) {
        entry.pending = navigator.mediaDevices
          .getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          })
          .then((media) => {
            if (!owned()) {
              media.getTracks().forEach((track) => track.stop());
              throw stopped();
            }
            const track = media.getAudioTracks()[0];
            if (!track || track.readyState !== 'live' || typeof media.clone !== 'function') {
              media.getTracks().forEach((item) => item.stop());
              throw Error('Не удалось включить микрофон. Запустите диалог снова.');
            }
            entry.root = media;
            entry.ended = () => {
              if (owned()) failVoice(Error('Микрофон отключён. Запустите диалог снова.'));
            };
            entry.muted = () => {
              if (owned() && !voicePaused)
                failVoice(
                  Object.assign(Error('Микрофон временно приостановлен. Нажмите «Продолжить».'), {
                    code: 'ASSISTANT_MICROPHONE_INTERRUPTED',
                  }),
                );
            };
            entry.unmuted = () => {
              if (owned() && voicePaused) ui.status('Микрофон готов. Нажмите «Продолжить».');
            };
            track.addEventListener?.('ended', entry.ended);
            track.addEventListener?.('mute', entry.muted);
            track.addEventListener?.('unmute', entry.unmuted);
            return media;
          });
      }
      const root = entry.root || (await entry.pending);
      if (!owned()) {
        if (microphone === entry) releaseMicrophone();
        throw stopped();
      }
      if (!current(captured)) throw stopped();
      if (root.getAudioTracks()[0]?.readyState !== 'live')
        throw Error('Микрофон отключён. Запустите диалог снова.');
      for (const prior of entry.clones)
        if (prior.getTracks().every((track) => track.readyState === 'ended'))
          entry.clones.delete(prior);
      if (root.getAudioTracks()[0]?.muted)
        throw Object.assign(Error('Микрофон временно приостановлен. Нажмите «Продолжить».'), {
          code: 'ASSISTANT_MICROPHONE_INTERRUPTED',
        });
      const media = root.clone();
      entry.clones.add(media);
      try {
        const track = media.getAudioTracks()[0];
        if (allEcho && track?.getSettings?.().echoCancellation !== 'all') {
          const modes = track?.getCapabilities?.().echoCancellation;
          if (
            entry.bargeEchoMode !== true &&
            Array.isArray(modes) &&
            modes.includes('all') &&
            track.applyConstraints
          ) {
            try {
              await track.applyConstraints({ echoCancellation: { exact: 'all' }, channelCount: 1 });
            } catch (error) {
              if (error?.name !== 'OverconstrainedError' || error.constraint !== 'echoCancellation')
                throw error;
              if (!owned() || !current(captured)) throw stopped();
              await track.applyConstraints({ echoCancellation: { exact: true }, channelCount: 1 });
            }
          }
          const actual = track?.getSettings?.().echoCancellation;
          if (actual !== true && actual !== 'all')
            throw Error('Браузер не подтвердил подавление эха. Ответьте после озвучивания.');
          entry.bargeEchoMode = actual;
        }
        if (!owned() || !current(captured)) throw stopped();
        return media;
      } catch (error) {
        media.getTracks().forEach((track) => track.stop());
        entry.clones.delete(media);
        throw error;
      }
    }
    const audioDiagnostic = (event, milliseconds = 0) => {
      try {
        actions.recordAssistantAudioDiagnostic?.(event, milliseconds);
      } catch {}
    };
    const diagnosticNow = () => {
      try {
        const value = globalThis.performance?.now?.() ?? Date.now();
        return Number.isFinite(value) ? value : 0;
      } catch {
        return 0;
      }
    };
    const turnDiagnostic = (event, trace, value = undefined) => {
      try {
        actions.assistantTurnTiming?.(event, trace, value);
      } catch {}
    };
    function stopVoice({ preserveAudio = false } = {}) {
      const ownedActivity = speechBusy || capturing || ui.recording;
      voiceEnabled = false;
      voicePaused = false;
      lastSpeech = null;
      startCue = false;
      initialCommand = true;
      unclearCommands = 0;
      epoch++;
      stopBarge();
      capturing = false;
      actions.stopAssistantCapture(true);
      releaseMicrophone();
      actions.stopAssistantAudio();
      if (!preserveAudio) actions.releaseAssistantAudio?.();
      audioDiagnostic('sessionStop');
      if (ownedActivity) activity(false, false);
      ui.phase?.('idle');
      ui.voiceState?.(false);
    }
    function pauseForRetry() {
      // Preserve the UI dialogue, not a live idle microphone or an automatic retry loop.
      stopVoice();
      voicePaused = true;
      ui.voiceState?.(false);
    }
    function pauseForChoice() {
      if (!voiceEnabled) return;
      voicePaused = false;
      lastSpeech = null;
      epoch++;
      stopBarge();
      capturing = false;
      actions.stopAssistantCapture(true);
      actions.stopAssistantAudio();
      activity(false, false);
    }
    function failVoice(error) {
      const recoverable =
        voiceEnabled &&
        [
          'ASSISTANT_AUDIO_GESTURE_REQUIRED',
          'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
          'ASSISTANT_MICROPHONE_INTERRUPTED',
        ].includes(error.code);
      if (recoverable) {
        // A sound failure does not revoke a live microphone or repeat a business action.
        voicePaused = true;
        epoch++;
        stopBarge();
        capturing = false;
        actions.stopAssistantCapture(true);
        actions.stopAssistantAudio();
        activity(false, false);
        ui.voiceState?.(true);
      } else stopVoice();
      ui.status(
        error.code === 'ASSISTANT_AUDIO_GESTURE_REQUIRED'
          ? 'Браузер заблокировал звук. Нажмите «Продолжить».'
          : error.message || 'Голосовой диалог остановлен. Можно продолжить на экране.',
      );
    }
    function speechContext() {
      const value = ui.speechContext;
      return value &&
        typeof value.dialogueId === 'string' &&
        Number.isSafeInteger(value.dialogueVersion)
        ? {
            dialogueId: value.dialogueId,
            dialogueVersion: value.dialogueVersion,
            step: value.step,
            optionCount: value.optionCount,
            phase: value.phase,
          }
        : null;
    }
    function shortAnswer(context) {
      return Boolean(
        context &&
        context.optionCount > 0 &&
        ['client', 'staff', 'service', 'time', 'availability', 'date', 'appointment'].includes(
          context.step,
        ),
      );
    }
    function shortSilence(context) {
      return Boolean(
        shortAnswer(context) &&
        (['closedDay', 'cancelConfirmation'].includes(context.phase) ||
          (context.step === 'client' && context.optionCount === 1)),
      );
    }
    async function recoverNoInput(error, captured) {
      if (!current(captured)) return;
      const recoverable =
        error.code === 'ASSISTANT_NO_INPUT' ||
        (error.status === 400 &&
          error.message === 'Речь не распознана. Попробуйте короткую фразу.');
      if (!voiceEnabled || !recoverable) {
        if (voiceEnabled && (error.outcomeUnknown === true || error.status >= 500)) {
          pauseForRetry();
          ui.status(error.message || 'Не удалось получить ответ. Нажмите «Продолжить».');
        } else failVoice(error);
        return;
      }
      if (speechContext() || ui.pendingOperation) {
        pauseForRetry();
        ui.status('Не услышал ответ. Нажмите «Продолжить», чтобы продолжить с этого шага.');
        return;
      }
      // An empty initial attempt may return to idle without a request or microphone loop.
      stopVoice();
      ui.status('');
      ui.idle?.();
    }

    function captureHandlers(captured, automatic) {
      const context = speechContext();
      let completed = false;
      return {
        complete: async (audioBase64, captureInfo = {}) => {
          if (!current(captured) || completed) return;
          completed = true;
          capturing = false;
          if (captureInfo.stopReason === 'limit') {
            if (automatic && voiceEnabled) pauseForRetry();
            else activity(false, false);
            ui.status(
              'Фраза слишком длинная. Повторите короче.' +
                (automatic ? ' Нажмите «Продолжить».' : ''),
            );
            return;
          }
          activity(true, false);
          ui.status(captureInfo.autoStopped ? 'Речь записана. Распознаём…' : 'Распознаём запись…');
          let trace = 0;
          try {
            trace = ui.captureTiming?.(captureInfo) || 0;
          } catch {}
          let submitted = false;
          try {
            const availabilityTurn = automatic && !context && ui.captureAvailabilityMode?.();
            const reply = await ui.request(
              '/api/assistant/transcribe',
              {
                audioBase64,
                mimeType: 'audio/wav',
                ...(availabilityTurn ? { availabilityTurn } : {}),
                ...(context &&
                (state.assistantScope.capabilities?.stt?.local === true ||
                  state.assistantScope.capabilities?.stt?.contextHints === true ||
                  state.assistantScope.billing?.paid === true)
                  ? { dialogueId: context.dialogueId, dialogueVersion: context.dialogueVersion }
                  : {}),
              },
              trace,
            );
            if (!reply || !current(captured)) return;
            const text = String(reply.text || '')
              .slice(
                0,
                Math.max(
                  100,
                  Math.min(4000, Number(state.assistantScope.limits?.maxTextChars) || 2000),
                ),
              )
              .trim();
            if (!text)
              throw Object.assign(
                Error('Не удалось разобрать речь. Повторите или введите ответ.'),
                { code: 'ASSISTANT_NO_INPUT' },
              );
            ui.heard?.(text);
            const input = ui.input();
            if (input) {
              if (input.tagName === 'INPUT' && ['date', 'time', 'number'].includes(input.type)) {
                input.type = 'text';
                input.inputMode = 'text';
              }
              input.value = text;
            }
            activity(false, false);
            if (automatic && voiceEnabled) {
              submitted = true;
              await ui.sendText(text, trace, availabilityTurn ? reply.availabilityReply : null);
            } else ui.status('Текст распознан. Проверьте его и нажмите «Отправить».');
          } catch (error) {
            if (!current(captured)) return;
            if (automatic) {
              submitted = true;
              await recoverNoInput(error, captured);
            } else ui.status(error.message);
          } finally {
            if (!submitted && current(captured)) activity(false, false);
          }
        },
        error: async (error) => {
          if (!current(captured) || completed) return;
          completed = true;
          capturing = false;
          if (automatic) await recoverNoInput(error, captured);
          else {
            activity(false, false);
            ui.status(error.message);
          }
        },
      };
    }
    async function capture() {
      if (!ui.valid()) return;
      if (ui.recording) {
        activity(true, false);
        ui.status('Распознаём запись…');
        if (listeningBarge()) {
          const entry = activeBarge;
          actions.stopAssistantBargeIn(false);
          if (activeBarge === entry) {
            stopBarge();
            capturing = false;
            activity(false, false);
          }
          return;
        }
        actions.stopAssistantCapture();
        return;
      }
      if (ui.busy || capturing) return;
      stopBarge();
      const captured = token(),
        automatic = voiceEnabled;
      const handlers = captureHandlers(captured, automatic);
      capturing = true;
      activity(true, false);
      ui.status('Подключаем микрофон…');
      ui.phase?.('starting');
      try {
        let started = false,
          fallback = true,
          startupFailure = null;
        if (
          automatic &&
          actions.assistantAudioFormat?.() === 'pcm' &&
          actions.startAssistantBargeIn
        ) {
          const entry = await prepareBarge(true);
          if (!current(captured)) return;
          if (entry?.ready?.ready) {
            entry.listening = true;
            started = entry.ready.listen?.() === true;
            fallback = false;
            if (!started) stopBarge();
          } else {
            fallback = entry?.ready?.fallbackAllowed === true;
            startupFailure =
              entry?.ready?.error || (entry?.ready?.reason ? Error(entry.ready.reason) : null);
          }
        }
        if (fallback)
          started = await actions.startAssistantCapture(
            handlers.complete,
            handlers.error,
            state.assistantScope.limits?.maxAudioSeconds || 30,
            {
              silenceStop: automatic,
              ...(automatic
                ? { acquireMedia: () => sessionMicrophone(captured), voiceOwner: { ...captured } }
                : {}),
              shortAnswer: automatic && shortAnswer(speechContext()),
              shortSilence: automatic && shortSilence(speechContext()),
              initialCommand: automatic && !speechContext(),
              startCue: automatic && startCue,
              ...(automatic && actions.assistantAudioFormat?.() === 'pcm'
                ? { readyCue: (options) => actions.playAssistantReadyCue(options) }
                : {}),
              onLevel: (value) => {
                if (current(captured)) ui.level?.(value);
              },
            },
          );
        if (!current(captured)) return;
        if (!started) {
          capturing = false;
          if (automatic)
            throw startupFailure || Error('Не удалось включить микрофон. Запустите диалог снова.');
          else activity(false, false);
          return;
        }
        startCue = false;
        activity(false, true);
        ui.status(automatic ? 'Слушаю' : 'Записываем. Нажмите «Остановить запись».');
      } catch (error) {
        if (!current(captured)) return;
        capturing = false;
        const message =
          error.name === 'NotAllowedError'
            ? 'Доступ к микрофону закрыт. Разрешите его в браузере или введите запрос.'
            : error.message;
        if (automatic) failVoice(Object.assign(Error(message), { code: error.code }));
        else {
          activity(false, false);
          ui.status(message);
        }
      }
    }
    function speechChunks(text) {
      const limit = Math.max(
        100,
        Math.min(1000, Math.floor(Number(state.assistantScope.limits?.maxReplyChars) || 600)),
      );
      const chunks = [];
      let pending = '';
      const flush = () => {
        if (pending) chunks.push(pending);
        pending = '';
      };
      const append = (part) => {
        if (pending && pending.length + part.length + 1 > limit) flush();
        pending += (pending ? ' ' : '') + part;
      };
      for (const section of String(text)
        .split(/\n+/u)
        .map((value) => value.trim())
        .filter(Boolean)) {
        if (section.length <= limit) {
          append(section);
          continue;
        }
        flush();
        for (let word of section.split(/\s+/u)) {
          while (word.length > limit) {
            flush();
            let end = limit;
            const last = word.charCodeAt(end - 1),
              next = word.charCodeAt(end);
            if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
            chunks.push(word.slice(0, end));
            word = word.slice(end);
          }
          append(word);
        }
        flush();
      }
      flush();
      return chunks;
    }
    async function prepareBarge(initialCapture = false) {
      if (!actions.startAssistantBargeIn) return null;
      stopBarge();
      const entry = { captured: token(), interrupted: false, listening: false, ready: null };
      const handlers = captureHandlers(entry.captured, true);
      const live = () => activeBarge === entry && voiceEnabled && current(entry.captured);
      activeBarge = entry;
      try {
        const ready = await actions.startAssistantBargeIn(
          (wav, info) => {
            if (!live() || (!entry.interrupted && !entry.listening)) return;
            activeBarge = null;
            return handlers.complete(wav, info);
          },
          (error) => {
            if (!live() || (!entry.interrupted && !entry.listening)) return;
            activeBarge = null;
            return handlers.error(error);
          },
          state.assistantScope.limits?.maxAudioSeconds || 30,
          {
            current: live,
            acquireMedia: () => sessionMicrophone(entry.captured, !initialCapture),
            ...(initialCapture
              ? {
                  initialCapture: true,
                  initialCommand: !speechContext(),
                  startCue,
                  readyCue: (options) => actions.playAssistantReadyCue(options),
                }
              : {}),
            onLevel: (value) => {
              if (live()) ui.level?.(value);
            },
            shortAnswer: shortAnswer(speechContext()),
            shortSilence: shortSilence(speechContext()),
            onInterrupt() {
              if (!live() || entry.interrupted) return;
              entry.interrupted = true;
              epoch++;
              entry.captured.epoch = epoch;
              capturing = true;
              activity(false, true);
              ui.status('Слушаю ваш ответ…');
            },
            onStatus(value) {
              const message = typeof value === 'string' ? value : value?.reason;
              if (live() && !entry.interrupted && value?.diagnostic) {
                try {
                  globalThis.console?.warn?.(
                    'assistant-barge-in-failure ' + JSON.stringify(value.diagnostic),
                  );
                } catch {}
              }
              if (live() && !entry.interrupted && message) ui.status(message);
            },
          },
        );
        entry.ready = ready;
        if ((!ready?.ready || !live()) && activeBarge === entry) stopBarge();
      } catch {
        if (activeBarge === entry) stopBarge();
      }
      return entry;
    }
    function turnTicket(ticket, text, answerable, chunks) {
      if (!ticket || usedTurnTicket === ticket) return null;
      usedTurnTicket = ticket;
      if (
        !answerable ||
        !voiceEnabled ||
        state.assistantScope.capabilities?.tts?.turnTicket !== true ||
        state.assistantScope.capabilities.tts.streaming !== true ||
        actions.assistantAudioFormat?.() !== 'pcm' ||
        chunks.length !== 1 ||
        chunks[0] !== text ||
        ticket.text !== text ||
        ticket.policyVersion !== state.assistantScope.policyVersion ||
        !Number.isFinite(ticket.expiresAt) ||
        ticket.expiresAt <= Date.now() ||
        ticket.mimeType !== 'audio/pcm' ||
        ticket.sampleRate !== 24000 ||
        ticket.channels !== 1 ||
        ticket.sampleFormat !== 's16le' ||
        ticket.playbackRate !== 1 ||
        typeof ticket.streamUrl !== 'string' ||
        !/^\/api\/assistant\/speak-audio\?ticket=[A-Za-z0-9_-]{43}&accountContext=([^&#]*)&organizationContext=([^&#]*)$/u.test(
          ticket.streamUrl,
        )
      )
        return null;
      const context = /&accountContext=([^&#]*)&organizationContext=([^&#]*)$/u.exec(
        ticket.streamUrl,
      );
      try {
        if (
          decodeURIComponent(context[1]) !== (state.account?.id || '') ||
          decodeURIComponent(context[2]) !== (state.account?.organizationId || '')
        )
          return null;
      } catch {
        return null;
      }
      return ticket;
    }
    async function speak(text, answerable = false, speechPermit, offeredTicket = null) {
      if (ui.busy || ui.recording || !ui.valid() || !text) return false;
      const captured = token();
      const trace = ui.turnTiming || 0;
      const synthesis = state.assistantScope.capabilities?.tts;
      if (synthesis && synthesis.ready !== true)
        throw Error('Озвучивание сейчас недоступно. Можно продолжить на экране.');
      const chunks = speechChunks(text);
      if (!chunks.length) return false;
      const ticket = turnTicket(offeredTicket, text, answerable, chunks);
      lastSpeech = { text, answerable, speechPermit };
      activity(true, false);
      // One microphone/PCM owner spans the complete question, including chunk boundaries.
      const bargeReady = answerable && voiceEnabled ? prepareBarge() : null,
        ownedBarge = bargeReady ? activeBarge : null;
      let completed = false;
      try {
        for (let index = 0; index < chunks.length; index++) {
          const chunk = chunks[index];
          if (!current(captured)) return false;
          let prepared = null;
          try {
            const reply =
              ticket ||
              (await ui.request(
                '/api/assistant/speak',
                {
                  text: chunk,
                  ...(speechPermit?.token ? { speechToken: speechPermit.token } : {}),
                  ...(synthesis?.streaming === true
                    ? {
                        stream: true,
                        ...(actions.assistantAudioFormat?.() === 'pcm' ? { format: 'pcm' } : {}),
                      }
                    : {}),
                },
                trace,
              ));
            if (!reply || !current(captured)) return false;
            if (index && activeBarge === ownedBarge && ownedBarge?.ready?.continuePlayback) {
              if (!ownedBarge.ready.continuePlayback()) {
                if (!current(captured)) return false;
                stopBarge();
              }
            }
            let started = false;
            const output = {
              ...reply,
              ...(voiceEnabled ? { voiceOwner: { ...captured } } : {}),
              // Nonfinal chunks share the live output route with the next chunk.
              drainOnEnd: index === chunks.length - 1,
              text: chunk,
              onTiming: (event, value) => turnDiagnostic(event, trace, value),
              onStarted: () => {
                if (!current(captured)) {
                  if (
                    activeBarge === ownedBarge &&
                    ownedBarge?.interrupted &&
                    current(ownedBarge.captured)
                  )
                    actions.stopAssistantAudio();
                  return;
                }
                if (!started) {
                  started = true;
                  turnDiagnostic('audioStarted', trace);
                  ownedBarge?.ready?.playbackStarted?.();
                  if (ownedBarge) ownedBarge.listening = false;
                }
                ui.phase?.('speaking');
              },
            };
            if (bargeReady && (reply.streamUrl != null || reply.streamRequest != null))
              prepared = actions.prepareAssistantAudio?.(output);
            if (bargeReady) {
              const waitingAt = diagnosticNow();
              await bargeReady;
              if (index === 0 && current(captured))
                audioDiagnostic('bargeReadyWait', diagnosticNow() - waitingAt);
            }
            if (!current(captured)) return false;
            const played = await (prepared ? prepared.play() : actions.playAssistantAudio(output));
            if (!current(captured) || played === false) return false;
            if (ownedBarge && activeBarge === ownedBarge) {
              const final = index === chunks.length - 1;
              const listen = final ? ownedBarge.ready?.listen : ownedBarge.ready?.wait;
              if (typeof listen === 'function') {
                ownedBarge.listening = true;
                if (listen()) {
                  if (final) {
                    capturing = true;
                    activity(false, true);
                    ui.status('Слушаю ваш ответ…');
                  }
                } else ownedBarge.listening = false;
              }
            }
          } finally {
            prepared?.cancel();
          }
        }
        completed = true;
        if (current(captured)) lastSpeech = null;
        return true;
      } finally {
        if (
          ownedBarge &&
          activeBarge === ownedBarge &&
          !ownedBarge.interrupted &&
          (!completed || !ownedBarge.listening)
        )
          stopBarge();
        if (current(captured) && !listeningBarge()) activity(false, false);
      }
    }
    function includesSpokenPhrase(parts, value) {
      const key = (text) =>
        String(text)
          .normalize('NFKC')
          .toLowerCase()
          .replace(/ё/gu, 'е')
          .replace(/[^\p{L}\p{N}:]+/gu, ' ')
          .trim();
      const phrase = key(value);
      return Boolean(
        phrase && parts.some((part) => (' ' + key(part) + ' ').includes(' ' + phrase + ' ')),
      );
    }
    function spokenReply(reply, answerable = true) {
      if (reply?.speechPermit)
        return answerable ? reply.speechPermit.answerableText : reply.speechPermit.readonlyText;
      if (reply?.dialogue?.information === true) return String(reply.dialogue.prompt || '').trim();
      if (reply?.dialogue?.manualInputRequired === true)
        return String(reply.text || reply.dialogue.prompt || '').trim();
      if (reply?.dialogue?.phase === 'cancelConfirmation')
        return String(reply.dialogue.prompt || '').trim();
      // Client identity is already a short, explicit server question; do not enumerate it twice.
      if (reply?.dialogue?.step === 'client') {
        const prompt = String(reply.dialogue.prompt || reply.text || '').trim();
        // Older callers may omit the phase. Ask one identity question instead
        // of reading the prompt, the same option and another yes/no instruction.
        const options = reply.dialogue.options;
        if (
          options?.length === 1 &&
          /(?:наш[её]л похожего клиента|это нужный человек|выберите клиента)/iu.test(prompt)
        ) {
          const name = String(options[0]?.label || '')
            .replace(/ · …\d{4}$/u, '')
            .trim();
          if (name) return name + ', верно?';
        }
        return prompt;
      }
      if (reply?.dialogue?.phase === 'serviceChoice')
        return String(reply.dialogue.prompt || '').trim();
      const dialogue = reply?.dialogue,
        text = String(reply?.text || '').trim(),
        prompt = String(dialogue?.prompt || '').trim(),
        serviceQuestion = dialogue?.step === 'service',
        ordinaryServicePrompt =
          prompt === 'Выберите услугу специалиста или введите её точное название.';
      if (serviceQuestion && ordinaryServicePrompt && (!text || text === prompt))
        return 'Какую услугу?';
      const detail =
        serviceQuestion && ordinaryServicePrompt && text.endsWith(prompt)
          ? text.slice(0, -prompt.length).trim()
          : text;
      const parts = serviceQuestion
        ? [
            detail,
            answerable ? 'Назовите услугу.' : 'Выберите услугу на экране или введите название.',
          ]
        : [text || prompt];
      if (!serviceQuestion && text && prompt && !includesSpokenPhrase([text], prompt))
        parts.push(prompt);
      if (dialogue?.step === 'review' && Array.isArray(dialogue.fields))
        for (const field of dialogue.fields.slice(0, 8)) {
          const label = String(field?.label || '').trim(),
            value = actions.assistantSpokenField(field);
          if (label && value) parts.push(label + ': ' + value);
        }
      const manyClients = dialogue?.step === 'client' && dialogue.options?.length > 3;
      if (manyClients)
        parts.push(
          'Есть несколько совпадений. Назовите фамилию, отчество или телефон клиента. Все варианты показаны на экране.',
        );
      const nearestQuestion =
        dialogue?.phase === 'slots' &&
        dialogue.options?.length === 1 &&
        prompt.includes('Ближайшее свободное время');
      if (
        !serviceQuestion &&
        !manyClients &&
        !nearestQuestion &&
        !['date', 'period', 'closedDay'].includes(dialogue?.phase) &&
        dialogue?.options?.length
      ) {
        const options = dialogue.options.slice(0, 3),
          questionParts = parts.slice();
        let narrated = false;
        for (const option of options) {
          const label = actions.assistantSpokenOption(option.label, dialogue.step);
          // Compare the complete label with the question, never individual names,
          // words or numbers. Similar choices must remain distinct on screen.
          if (label && !includesSpokenPhrase(questionParts, label)) {
            parts.push(label);
            narrated = true;
          }
        }
        if (dialogue.phase !== 'slots' && narrated)
          parts.push(
            answerable
              ? dialogue.step === 'review'
                ? 'Скажите «открой форму», чтобы проверить запись перед сохранением.'
                : dialogue.step === 'client' && options.length === 1
                  ? 'Скажите «да», если это нужный клиент, или «нет», чтобы уточнить имя или телефон.'
                  : 'Какой подходит?'
              : dialogue.step === 'review'
                ? 'Для подготовки формы нажмите «Подготовить форму записи». Сохранение выполняется вручную.'
                : 'Выберите вариант на экране или введите ответ.',
          );
      }
      if (!dialogue && Array.isArray(reply?.readOnlySlots) && reply.readOnlySlots.length) {
        parts.push('Просмотр свободных окон. Запись не подготовлена');
        for (const slot of reply.readOnlySlots.slice(0, 3)) {
          const label = slot.date + ' · ' + slot.time + '–' + slot.endTime + ' · ' + slot.staffName;
          parts.push('Свободно: ' + actions.assistantSpokenOption(label, 'availability'));
        }
      }
      return parts
        .filter(Boolean)
        .map((part, index, all) =>
          index < all.length - 1 && !/[.!?…][»”"']?$/u.test(part) ? part + '.' : part,
        )
        .join('\n');
    }
    const speakReply = (reply, answerable = false) =>
      speak(spokenReply(reply, answerable), answerable, reply?.speechPermit, reply?.speech);
    async function afterReply(reply) {
      if (!voiceEnabled || !ui.valid()) return;
      if (reply?.draftCancelled === true && !reply.dialogue && !reply.action) {
        stopVoice();
        ui.status(reply.text);
        return;
      }
      const captured = token();
      try {
        const unclearCommand =
          initialCommand &&
          reply?.intent === 'help' &&
          reply.action === null &&
          !reply.dialogue &&
          !reply.readOnlySlots?.length &&
          reply.text === 'Что нужно сделать?';
        if (unclearCommand && unclearCommands >= 2) {
          pauseForRetry();
          ui.status('Не получилось разобрать команду. Начните заново.');
          return;
        }
        if (unclearCommand) unclearCommands++;
        else {
          initialCommand = false;
          unclearCommands = 0;
        }
        if (
          !reply?.dialogue &&
          [
            'prepareAppointment',
            'createAppointment',
            'cancelAppointment',
            'moveAppointment',
            'appointmentPreview',
            'calendar',
            'clientCard',
            'clients',
          ].includes(reply?.action?.type)
        ) {
          await ui.openResult({ voice: true });
          if (current(captured) && voiceEnabled) stopVoice();
          return;
        }
        const manualInputRequired = reply?.dialogue?.manualInputRequired === true;
        // An acknowledged consumed ticket must not become a second paid audio request.
        const replay = reply?.speechReplay === true;
        if (replay) lastSpeech = null;
        const played =
          replay ||
          (await speakReply(
            reply,
            unclearCommand || (Boolean(reply?.dialogue) && !manualInputRequired),
          ));
        if (!played || !current(captured) || !voiceEnabled) {
          if (current(captured) && voiceEnabled)
            failVoice(
              Error('Не удалось озвучить вопрос. Продолжите на экране или запустите диалог снова.'),
            );
          return;
        }
        if (!reply?.dialogue && !unclearCommand) {
          stopVoice();
          ui.status('Ответ готов. Дальнейшее действие доступно на экране.');
          return;
        }
        if (manualInputRequired) {
          stopVoice();
          ui.status('Можно продолжить текстом.');
          return;
        }
        if (!listeningBarge()) await capture();
      } catch (error) {
        if (
          current(captured) &&
          voiceEnabled &&
          reply?.dialogue &&
          reply.dialogue.manualInputRequired !== true &&
          error.status === 403 &&
          error.code === 'ASSISTANT_SPEECH_PROOF_REQUIRED'
        ) {
          // The question remains on screen. Listen for its answer without replaying refused speech.
          lastSpeech = null;
          await capture();
          return;
        }
        if (current(captured)) failVoice(error);
      }
    }
    async function startVoice(reply = null) {
      if (ui.busy || ui.recording || !ui.valid()) return false;
      if (voiceEnabled) {
        if (!voicePaused) return false;
        const repeat = lastSpeech;
        voicePaused = false;
        lastSpeech = null;
        epoch++;
        const resumed = token();
        ui.voiceState?.(true);
        try {
          if (repeat) {
            const played = await speak(repeat.text, repeat.answerable, repeat.speechPermit);
            if (current(resumed) && voiceEnabled && played) {
              if (!repeat.answerable) stopVoice();
              else if (!listeningBarge()) await capture();
            }
          } else await capture();
        } catch (error) {
          if (current(resumed)) failVoice(error);
        }
        return voiceEnabled;
      }
      const capabilities = state.assistantScope.capabilities;
      if (!capabilities?.stt?.ready || capabilities.stt.demo) {
        ui.status(
          'Для голосового диалога нужно подключить распознавание речи в настройках помощника.',
        );
        return false;
      }
      if (!capabilities?.tts?.ready) {
        ui.status('Для голосового диалога нужно подключить озвучивание в настройках помощника.');
        return false;
      }
      epoch++;
      voiceEnabled = true;
      voicePaused = false;
      audioDiagnostic('sessionStart');
      startCue = true;
      ui.voiceState?.(true);
      const started = token();
      if (capabilities.tts.local || capabilities.tts.demo) {
        activity(true, false);
        ui.status('Подключаем локальный голос…');
        try {
          const ready = await actions.assistantLocalVoiceReady();
          if (!current(started) || !voiceEnabled) return false;
          activity(false, false);
          if (!ready) {
            failVoice(
              Error(
                'На устройстве не найден локальный русский голос. Установите его в настройках речи Windows или продолжите на экране.',
              ),
            );
            return false;
          }
        } catch (error) {
          if (current(started)) failVoice(error);
          return false;
        }
      }
      if (!current(started) || !voiceEnabled) return false;
      if (reply) await afterReply(reply);
      else await capture();
      return voiceEnabled;
    }
    return {
      capture,
      speak,
      speakReply,
      startVoice,
      stopVoice,
      pauseForRetry,
      pauseForChoice,
      afterReply,
      get voicePaused() {
        return voicePaused;
      },
      get voiceEnabled() {
        return voiceEnabled;
      },
    };
  }
  return { assistantSpeechController };
}
