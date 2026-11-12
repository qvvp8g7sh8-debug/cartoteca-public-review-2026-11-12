function createVoiceAssistant(state, actions) {
  let panel = null,
    controller = null,
    sequence = 0,
    panelSession = 0;
  let turnTiming = 0,
    capturedTiming = 0;
  let playbackHeaders = new window.WeakMap();
  function freezePlaybackHeader(body) {
    let header = '';
    try {
      const values = actions.takeAssistantPlaybackSummary?.();
      const limits = [
        2, 2, 1, 100, 100, 150000, 100, 100, 150000, 4, 100, 150000, 150000, 150000, 150000, 100,
        100, 100, 100, 100, 3, 150001, 150001, 150001,
      ];
      if (
        Array.isArray(values) &&
        ((values[0] === 1 && values.length === 20) ||
          (values[0] === 2 && values.length === 24 && values[20] >= 1)) &&
        values.every(
          (value, index) => Number.isSafeInteger(value) && value >= 0 && value <= limits[index],
        )
      ) {
        const encoded = values.join(',');
        if (encoded.length <= 256) header = encoded;
      }
    } catch {}
    playbackHeaders.set(body, header);
  }
  const timing = (event, turn = turnTiming, value = undefined) => {
    try {
      return actions.assistantTurnTiming?.(event, turn, value) || 0;
    } catch {
      return 0;
    }
  };
  let active = false,
    voiceMode = false,
    turnPending = false,
    recoverableError = false,
    statusMessage = '',
    voicePhase = 'idle';
  let recording = false,
    busy = false,
    result = null,
    pendingTurn = null,
    pendingVoiceTurn = false,
    pendingHandoff = null,
    handoffProgress = null,
    checkingAccess = false,
    openedGeneration = -1,
    openedIdentity = '';
  const accountContext = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const valid = () =>
    active &&
    panel?.isConnected &&
    state.currentView === 'calendar' &&
    state.assistantScope?.enabled === true &&
    state.assistantScope.organizationId === state.account?.organizationId &&
    accountContext() === openedIdentity &&
    state.assistantGeneration === openedGeneration;
  const field = (name) => panel?.querySelector('[data-assistant-' + name + ']');
  const idle = actions.assistantIdleTimer((owner) => {
    if (
      valid() &&
      voiceMode &&
      owner === panelSession &&
      !busy &&
      !recording &&
      !turnPending &&
      !pendingTurn &&
      !pendingHandoff &&
      !result?.dialogue &&
      !recoverableError &&
      !speech.voicePaused
    )
      closeAssistantPanel();
  });
  const presentation = actions.assistantPresentation({
    close: closeAssistantPanel,
    choose(selection) {
      const dialogue = result?.dialogue;
      if (
        !valid() ||
        turnPending ||
        pendingTurn ||
        (busy && !recording && !speech.voiceEnabled) ||
        selection.dialogueId !== dialogue?.id ||
        selection.dialogueVersion !== dialogue?.version
      )
        return;
      speech.pauseForChoice();
      void sendCommand({ choice: selection.choice });
    },
    resume() {
      if (!valid() || turnPending || busy || recording) return;
      if (!pendingTurn && recoverableError && !result?.dialogue && field('text').value.trim()) {
        void openPanel();
        return;
      }
      void actions.unlockAssistantAudio?.();
      if (pendingTurn) void sendCommand(null, pendingTurn);
      else
        void speech.startVoice(
          result?.action || (result?.dialogue && !result.dialogue.manualInputRequired)
            ? result
            : null,
        );
    },
  });
  function updatePresentation() {
    idle.update({
      active,
      voice: voiceMode,
      busy,
      recording,
      turnPending,
      owner: panelSession,
      pendingTurn: Boolean(pendingTurn),
      pendingHandoff: Boolean(pendingHandoff),
      hasDialogue: Boolean(result?.dialogue),
      recoverable: recoverableError || speech.voicePaused,
    });
    if (voiceMode && active)
      presentation.update({
        reply: result,
        message: statusMessage,
        busy,
        recording,
        turnPending,
        pendingTurn,
        voiceEnabled: speech.voiceEnabled,
        voicePaused: speech.voicePaused,
        phase: checkingAccess || turnPending ? 'pending' : voicePhase,
        progress: checkingAccess ? 'access' : null,
      });
  }
  function status(message) {
    statusMessage = message;
    if (panel) field('status').textContent = message;
    updatePresentation();
  }
  function heard(message) {
    if (!panel) return;
    const text = String(message || '')
      .slice(
        0,
        Math.max(100, Math.min(4000, Number(state.assistantScope?.limits?.maxTextChars) || 2000)),
      )
      .trim();
    field('heard').textContent = text ? 'Вы сказали: «' + text + '»' : '';
    field('heard').hidden = !text;
  }
  function updateControls() {
    if (!panel) return;
    field('send').disabled = busy || recording || Boolean(pendingTurn) || speech.voiceEnabled;
    for (const name of ['text', 'input', 'example'])
      field(name).disabled = busy || recording || Boolean(pendingTurn);
    field('voice').disabled = !speech.voiceEnabled && (busy || recording || Boolean(pendingTurn));
    field('voice').setAttribute('aria-pressed', String(speech.voiceEnabled));
    field('voice').textContent = speech.voiceEnabled ? 'Остановить диалог' : 'Диалог голосом';
    field('mic').disabled =
      (busy && !recording) ||
      speech.voiceEnabled ||
      Boolean(pendingTurn) ||
      Boolean(result?.dialogue && !result.dialogue.input);
    field('mic').setAttribute('aria-pressed', String(recording));
    field('mic').textContent = recording ? 'Остановить запись' : 'Микрофон';
    for (const name of ['speak', 'action', 'new', 'retry'])
      field(name).disabled = busy || recording;
    field('retry').hidden = !pendingTurn;
    field('conversation')
      .querySelectorAll('button')
      .forEach((button) => {
        button.disabled = busy || recording || Boolean(pendingTurn);
      });
    updatePresentation();
  }
  function clearPendingTurn() {
    pendingTurn = null;
    pendingVoiceTurn = false;
  }
  function cancelPendingHandoff() {
    const previous = pendingHandoff;
    pendingHandoff = null;
    endHandoffProgress(previous);
    if (previous && state.assistantGeneration === previous.generation) state.assistantGeneration++;
  }
  function endHandoffProgress(handoff) {
    if (!handoff || handoffProgress?.handoff !== handoff) return;
    handoffProgress = null;
    if (!active) presentation.close();
  }
  function handoffProgressCurrent(handoff, review) {
    return (
      pendingHandoff === handoff &&
      !handoff.feedbackCancelled &&
      !document.hidden &&
      panel?.isConnected &&
      !active &&
      !panel.open &&
      panelSession === handoff.session &&
      sequence === handoff.sequence &&
      state.assistantGeneration === review.generation &&
      accountContext() === review.identity &&
      state.assistantScope?.enabled === true &&
      state.assistantScope.organizationId === state.account?.organizationId &&
      state.assistantScope.policyVersion === review.policyVersion &&
      state.currentView === review.view &&
      state.editorMode === review.editor &&
      state.selectedId === review.selectedId
    );
  }
  function startHandoffProgress(action, handoff, review) {
    const progress = {
      createAppointment: 'create',
      moveAppointment: 'move',
      cancelAppointment: 'cancel',
    }[action.type];
    if (!progress || !handoffProgressCurrent(handoff, review)) return;
    handoffProgress = { handoff, review };
    presentation.start();
    presentation.update({
      reply: null,
      phase: 'pending',
      progress,
      busy: true,
      recording: false,
      voiceEnabled: false,
    });
  }
  function closeAssistantPanel({ preserveAudio = false } = {}) {
    idle.stop();
    checkingAccess = false;
    handoffProgress = null;
    voicePhase = 'idle';
    active = false;
    turnPending = false;
    recoverableError = false;
    presentation.close();
    speech.stopVoice({ preserveAudio });
    sequence++;
    panelSession++;
    controller?.abort();
    controller = null;
    actions.stopAssistantCapture(true);
    actions.stopAssistantAudio();
    if (!preserveAudio) actions.releaseAssistantAudio?.();
    recording = busy = false;
    result = null;
    clearPendingTurn();
    playbackHeaders = new window.WeakMap();
    openedIdentity = '';
    if (panel) {
      heard('');
      field('text').value = '';
      field('answer').textContent = field('draft').textContent = '';
      field('action').hidden = field('speak').hidden = field('retry').hidden = true;
      actions.renderAssistantConversation(panel, null);
      if (panel.open) panel.close();
    }
  }
  function pauseHiddenVoice() {
    if (!document.hidden) {
      updatePresentation();
      return;
    }
    idle.stop();
    if (pendingHandoff) {
      pendingHandoff.feedbackCancelled = true;
      cancelPendingHandoff();
      controller?.abort();
      actions.stopAssistantAudio();
    }
    if (active) {
      // Keep the dialogue/session intact so an interrupted turn retains its exact retry body.
      // Manual recording and manual playback own the same resources as voice dialogue.
      speech.stopVoice();
      controller?.abort();
      status('Помощник приостановлен. Для продолжения вернитесь к текущему шагу.');
    }
  }
  function destroyVoiceAssistant() {
    timing('reset');
    turnTiming = capturedTiming = 0;
    cancelPendingHandoff();
    document.removeEventListener('visibilitychange', pauseHiddenVoice);
    window.removeEventListener('pagehide', closeAssistantPanel);
    actions.destroyAssistantTrigger();
    closeAssistantPanel();
    presentation.destroy();
    panel?.remove();
    panel = null;
    actions.discardAssistantDraft();
  }
  // Local transport descriptor only. Authorization/success is established by the PCM POST,
  // never by constructing this object; the playback owner carries cancellation through EOF.
  function directPcmSpeech(body) {
    const scope = state.assistantScope;
    if (
      body?.stream !== true ||
      body.format !== 'pcm' ||
      scope?.capabilities?.tts?.directPcm !== true
    )
      return null;
    return {
      text: body.text,
      policyVersion: body.policyVersion,
      mimeType: 'audio/pcm',
      sampleRate: 24000,
      channels: 1,
      sampleFormat: 's16le',
      playbackRate: 1,
      streamRequest: {
        text: body.text,
        policyVersion: body.policyVersion,
        format: 'pcm',
        ...(body.taskRequestId ? { taskRequestId: body.taskRequestId } : {}),
        ...(body.speechToken ? { speechToken: body.speechToken } : {}),
      },
      onRefused: (status, code = '') => {
        // A speech proof refusal only stops this audio request; the dialogue remains usable.
        if (status === 403 && code === 'ASSISTANT_SPEECH_PROOF_REQUIRED') return;
        if ([401, 403, 428].includes(status) || (status === 409 && !code.startsWith('TASK_')))
          actions.resetAssistant();
        if (status === 428) {
          state.sessionReady = false;
          document.body?.classList.add('app-loading');
        }
        if (status === 401 && typeof location !== 'undefined')
          location.replace('/' + (location.hash.startsWith('#staff-push=') ? location.hash : ''));
      },
    };
  }
  function prepareVoiceScope() {
    if (active) return null;
    const request = new AbortController();
    const reply = actions.request('/api/assistant/scope', {
      method: 'GET',
      timeoutMs: state.assistantScope?.limits?.requestTimeoutMs || 20000,
      signal: request.signal,
      assistantRequest: true,
    });
    void reply.catch(() => {});
    return { controller: request, reply };
  }
  async function assistantRequest(path, body = null, trace = turnTiming, preparedScope = null) {
    controller?.abort();
    const current = ++sequence,
      generation = state.assistantGeneration;
    const scope = state.assistantScope,
      policyVersion = body?.policyVersion ?? scope?.policyVersion;
    const packageTask =
      scope?.billing?.paid === true && body
        ? path === '/api/assistant/speak'
          ? result?.taskRequestId
          : path === '/api/assistant/transcribe'
            ? result?.dialogue
              ? result.taskRequestId
              : window.crypto.randomUUID()
            : null
        : null;
    const direct =
      path === '/api/assistant/speak'
        ? directPcmSpeech({
            ...body,
            ...(packageTask ? { taskRequestId: packageTask } : {}),
            policyVersion,
          })
        : null;
    if (direct) {
      controller = null;
      return current === sequence && generation === state.assistantGeneration && valid()
        ? direct
        : null;
    }
    controller = preparedScope?.controller || new AbortController();
    const stage = {
      '/api/assistant/transcribe': 'stt',
      '/api/assistant/turn': 'turn',
      '/api/assistant/speak': 'speak',
    }[path];
    if (stage) timing(stage + 'Start', trace);
    try {
      const reply = await (preparedScope?.reply ||
        actions.request(path, {
          method: body ? 'POST' : 'GET',
          ...(path === '/api/assistant/turn' && playbackHeaders.get(body)
            ? { headers: { 'X-Assistant-Audio-Summary': playbackHeaders.get(body) } }
            : {}),
          ...(body
            ? {
                body: JSON.stringify({
                  ...body,
                  ...(packageTask ? { taskRequestId: packageTask } : {}),
                  policyVersion,
                }),
              }
            : {}),
          timeoutMs: scope?.limits?.requestTimeoutMs || 20000,
          signal: controller.signal,
          assistantRequest: true,
          assistantTiming: (header) => timing(stage + 'Server', trace, header),
        }));
      if (current !== sequence || generation !== state.assistantGeneration || !valid()) return null;
      if (body && reply.policyVersion !== policyVersion) {
        actions.resetAssistant();
        throw Error('Настройки помощника изменились. Откройте календарь заново.');
      }
      if (stage) timing(stage + 'Succeeded', trace);
      return reply;
    } catch (error) {
      if (current !== sequence || generation !== state.assistantGeneration || !valid()) return null;
      if (error.outcomeUnknown && path === '/api/assistant/transcribe') {
        error.message =
          error.assistantFailure === 'deadline'
            ? 'Истекло время ожидания голосового запроса. Проверьте экран и нажмите «Продолжить».'
            : 'Ответ на голосовой запрос не получен. Проверьте экран и нажмите «Продолжить».';
      }
      const refusedSpeech =
        path === '/api/assistant/speak' &&
        error.status === 403 &&
        error.code === 'ASSISTANT_SPEECH_PROOF_REQUIRED';
      if (
        !refusedSpeech &&
        ([401, 403].includes(error.status) ||
          (error.status === 409 &&
            !body?.dialogueId &&
            !String(error.code || '').startsWith('TASK_')))
      )
        actions.resetAssistant();
      throw error;
    } finally {
      if (stage) timing(stage + 'End', trace);
      if (current === sequence) controller = null;
    }
  }
  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('dialog');
    panel.className = 'voice-assistant-dialog';
    panel.setAttribute('aria-labelledby', 'voice-assistant-title');
    panel.innerHTML = actions.assistantPanelHtml();
    document.body.append(panel);
    document.addEventListener('visibilitychange', pauseHiddenVoice);
    window.addEventListener('pagehide', closeAssistantPanel);
    panel.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeAssistantPanel();
    });
    panel.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      void send();
    });
    field('close').addEventListener('click', closeAssistantPanel);
    field('new').addEventListener('click', () => {
      heard('');
      void sendCommand({ cancel: true });
    });
    field('retry').addEventListener('click', () => {
      if (pendingTurn) void sendCommand(null, pendingTurn);
    });
    field('conversation').addEventListener('click', (event) => {
      const choice = event.target.closest('[data-assistant-choice]');
      const edit = event.target.closest('[data-assistant-edit]');
      if (choice) void sendCommand({ choice: choice.dataset.assistantChoice });
      else if (edit) void sendCommand({ edit: edit.dataset.assistantEdit });
    });
    field('example').addEventListener('click', () => {
      field('text').value = 'Покажи моё расписание на неделю';
      status('Пример заполнен. Нажмите «Отправить».');
    });
    field('voice').addEventListener('click', () => {
      if (speech.voiceEnabled) {
        speech.stopVoice();
        status('Голосовой диалог остановлен. Выбранные данные сохранены в окне.');
      } else {
        void actions.unlockAssistantAudio?.();
        void startVoiceMode();
      }
    });
    field('mic').addEventListener('click', () => {
      void actions.unlockAssistantAudio?.();
      void speech.capture();
    });
    field('speak').addEventListener('click', () => {
      void actions.unlockAssistantAudio?.();
      void speech.speakReply(result).catch((error) => {
        if (valid()) status(error.message);
      });
    });
    field('action').addEventListener('click', () => {
      void openResult();
    });
  }
  async function startVoiceMode() {
    if (!valid()) return;
    voiceMode = true;
    if (panel.open) panel.close();
    presentation.start();
    updateControls();
    await speech.startVoice();
  }
  async function openPanel({ voice = false, preparedScope = null } = {}) {
    if (
      !state.assistantReady ||
      state.currentView !== 'calendar' ||
      state.busy ||
      state.editorMode
    ) {
      preparedScope?.controller.abort();
      return;
    }
    if (active) {
      preparedScope?.controller.abort();
      if (!voice && !panel.open) {
        speech.stopVoice();
        voiceMode = false;
        presentation.close();
        panel.showModal();
        field(result?.dialogue ? 'input' : 'text').focus();
      } else if (voice && (!speech.voiceEnabled || speech.voicePaused)) await startVoiceMode();
      return;
    }
    cancelPendingHandoff();
    ensurePanel();
    timing('reset');
    turnTiming = capturedTiming = 0;
    openedGeneration = state.assistantGeneration;
    openedIdentity = accountContext();
    const session = ++panelSession;
    active = true;
    voiceMode = voice;
    if (voiceMode) presentation.start();
    else panel.showModal();
    checkingAccess = true;
    status('Проверяем доступ…');
    busy = true;
    updateControls();
    try {
      const scope = await assistantRequest('/api/assistant/scope', null, turnTiming, preparedScope);
      if (!scope) return;
      actions.applyAssistantScope(scope);
      if (!valid()) return;
      field('mode').textContent = scope.demo
        ? 'Демонстрационный разбор команд. Голос зависит от подключённых сервисов.'
        : 'Скажите короткую команду или напишите её.';
      field('text').maxLength = Math.max(
        100,
        Math.min(4000, Number(scope.limits?.maxTextChars) || 2000),
      );
      const speech = scope.capabilities?.stt;
      field('mic').hidden = speech
        ? speech.demo === true || speech.ready !== true
        : scope.demo === true;
      field('voice').hidden = field('mic').hidden;
      const seconds = Math.max(1, Math.min(60, Number(scope.limits?.maxAudioSeconds) || 30));
      field('hint').textContent =
        'Диалог голосом задаёт вопросы и слушает ответы автоматически, до ' +
        seconds +
        (scope.appointmentSavingEnabled
          ? ' секунд на ответ. Готовая запись сохраняется автоматически.'
          : ' секунд на ответ. Запись сохраняется в форме.');
      status(
        speech && !speech.ready && !speech.demo
          ? 'Голосовой сервис пока недоступен. Попробуйте текст.'
          : '',
      );
      if (!voice) field('text').focus();
    } catch (error) {
      if (session === panelSession) status(error.message);
      return;
    } finally {
      if (session === panelSession) {
        checkingAccess = false;
        busy = false;
        updateControls();
      }
    }
    if (voice && session === panelSession && valid()) await speech.startVoice();
  }
  function showResult(reply) {
    recoverableError = false;
    result = reply;
    actions.renderAssistantConversation(panel, reply, { voice: voiceMode || speech.voiceEnabled });
    field('answer').textContent = String(reply.text || '').slice(0, 2000);
    field('draft').textContent = actions.assistantDraftText(reply.action);
    field('action').textContent = actions.assistantActionCaption(reply.action);
    field('action').hidden = !field('action').textContent;
    field('speak').hidden = !reply.text;
    status(reply.demo ? 'Демонстрационный ответ. Проверьте результат.' : '');
  }
  const speech = actions.assistantSpeechController({
    valid,
    status,
    heard: (text) => {
      if (valid()) heard(text);
    },
    request: assistantRequest,
    captureTiming(info) {
      capturedTiming = timing('begin', 0, info?.speechEndedAt);
      turnTiming = capturedTiming;
      timing('captureReady', capturedTiming);
      return capturedTiming;
    },
    get turnTiming() {
      return turnTiming;
    },
    input: () => field(result?.dialogue ? 'input' : 'text'),
    captureAvailabilityMode() {
      if (
        result ||
        pendingTurn ||
        turnPending ||
        state.assistantScope.capabilities?.stt?.availabilityTurn !== true
      )
        return null;
      const tts = state.assistantScope.capabilities.tts;
      return tts?.turnTicket === true &&
        tts.streaming === true &&
        actions.assistantAudioFormat?.() === 'pcm'
        ? 'pcm'
        : 'plain';
    },
    sendText: (text, trace, prepared) => sendCommand({ text }, null, trace, prepared),
    openResult,
    voiceState: () => updateControls(),
    idle: () => {
      if (
        valid() &&
        voiceMode &&
        !busy &&
        !turnPending &&
        !pendingTurn &&
        !pendingHandoff &&
        !result?.dialogue &&
        !recoverableError
      )
        closeAssistantPanel();
    },
    get pendingOperation() {
      return turnPending || Boolean(pendingTurn) || Boolean(pendingHandoff);
    },
    phase(value) {
      voicePhase = value;
      if (value !== 'listening') presentation.setLevel?.(0);
      updatePresentation();
    },
    level(value) {
      if (valid() && voiceMode) presentation.setLevel?.(value);
    },
    get speechContext() {
      const dialogue = result?.dialogue;
      return dialogue
        ? {
            dialogueId: dialogue.id,
            dialogueVersion: dialogue.version,
            step: dialogue.step,
            optionCount: dialogue.options?.length || 0,
            phase: dialogue.phase,
          }
        : null;
    },
    get session() {
      return panelSession;
    },
    get busy() {
      return busy;
    },
    get recording() {
      return recording;
    },
    activity(nextBusy, nextRecording) {
      // Speech cleanup cannot release the lock of an in-flight business turn.
      busy = nextBusy || turnPending;
      recording = nextRecording;
      updateControls();
    },
  });
  async function send() {
    const input = field(result?.dialogue ? 'input' : 'text');
    if (!input || (input.reportValidity && !input.reportValidity())) return;
    const text = input.value.trim();
    if (!text) {
      status('Скажите или напишите ответ.');
      return;
    }
    await sendCommand({ text });
  }
  async function restartAfterStaleCancel() {
    heard('');
    result = null;
    clearPendingTurn();
    actions.renderAssistantConversation(panel, null);
    field('text').value = '';
    field('answer').textContent = field('draft').textContent = '';
    field('action').hidden = field('speak').hidden = true;
    status('Обновляем доступ помощника…');
    try {
      const scope = await assistantRequest('/api/assistant/scope');
      if (!scope) return;
      actions.applyAssistantScope(scope);
      if (valid()) {
        status('Доступ обновлён. Напишите новую команду.');
        if (panel.open) field('text').focus();
      } else actions.toast('Доступ обновлён. Откройте помощника заново.');
    } catch (error) {
      const message =
        'Не удалось обновить доступ. Переоткройте помощника или обновите страницу. ' +
        error.message;
      if (panel?.open) status(message);
      else actions.toast(message);
    }
  }
  async function sendCommand(command, frozen = null, trace = capturedTiming, prepared = null) {
    if (busy || turnPending || recording || !valid()) return;
    const session = panelSession;
    let received = null;
    const dialogue = result?.dialogue,
      voiceTurn = frozen ? pendingVoiceTurn : speech.voiceEnabled;
    if (!frozen && !dialogue && !command?.text) return;
    if (pendingTurn && !frozen && !command?.cancel) {
      status('Сначала повторите незавершённый шаг или начните новую команду.');
      return;
    }
    const body =
      frozen ||
      Object.freeze({
        ...(dialogue ? { dialogueId: dialogue.id, dialogueVersion: dialogue.version } : {}),
        ...command,
        ...(voiceTurn &&
        state.assistantScope.capabilities?.tts?.turnTicket === true &&
        state.assistantScope.capabilities.tts.streaming === true &&
        actions.assistantAudioFormat?.() === 'pcm'
          ? { speech: { format: 'pcm', stream: true, mode: 'answerable' } }
          : {}),
        ...(!prepared && state.assistantScope.billing?.paid === true
          ? { taskRequestId: window.crypto.randomUUID() }
          : {}),
        policyVersion: state.assistantScope.policyVersion,
      });
    if (!frozen && !prepared) freezePlaybackHeader(body);
    turnTiming = trace || timing('begin');
    capturedTiming = 0;
    recoverableError = false;
    busy = turnPending = true;
    field('action').hidden = field('speak').hidden = true;
    status('Обрабатываем запрос…');
    updateControls();
    try {
      const reply = prepared || (await assistantRequest('/api/assistant/turn', body));
      if (reply) {
        clearPendingTurn();
        received = reply;
        showResult(reply);
        if (body.cancel) {
          field('text').value = '';
          if (panel.open) field('text').focus();
        }
      }
    } catch (error) {
      if (session !== panelSession) return;
      if (speech.voiceEnabled && dialogue && error.status === 400) {
        clearPendingTurn();
        received = {
          ...result,
          text: error.message,
          action: null,
          dialogue: { ...dialogue, prompt: error.message },
        };
        showResult(received);
      } else {
        recoverableError = error.outcomeUnknown === true || error.status >= 500;
        if (speech.voiceEnabled) {
          if (recoverableError && typeof speech.pauseForRetry === 'function')
            speech.pauseForRetry();
          else speech.stopVoice();
        }
        if (body.cancel && error.status === 409) {
          await restartAfterStaleCancel();
          return;
        }
        if (
          (error.outcomeUnknown || error.code === 'TASK_IN_PROGRESS') &&
          (dialogue || body.taskRequestId)
        ) {
          pendingTurn = body;
          pendingVoiceTurn = voiceTurn;
          status(
            'Ответ не получен. Нажмите «Повторить шаг»: повтор будет отправлен с теми же данными.',
          );
        } else {
          clearPendingTurn();
          if (error.outcomeUnknown && !dialogue && typeof body.text === 'string') {
            const input = field('text');
            input.value = body.text;
            status(
              (error.assistantFailure === 'deadline'
                ? 'Истекло время ожидания ответа на команду.'
                : 'Ответ на команду не получен.') +
                (panel.open
                  ? ' Текст команды остался в поле. Проверьте его перед отправкой.'
                  : ' Нажмите «Продолжить», чтобы проверить распознанный текст.'),
            );
          } else {
            status(
              error.status === 409 && dialogue
                ? 'Диалог изменился или истёк. Начните новую команду; текущие поля показаны ниже.'
                : error.message,
            );
          }
        }
      }
    } finally {
      if (session === panelSession) {
        busy = turnPending = false;
        updateControls();
      }
    }
    if (!received || session !== panelSession || !valid()) return;
    if (frozen && voiceMode && voiceTurn && !speech.voiceEnabled) await speech.startVoice(received);
    else if (speech.voiceEnabled) await speech.afterReply(received);
    else if (
      !voiceTurn &&
      (dialogue
        ? body.dialogueId === dialogue.id && body.dialogueVersion === dialogue.version
        : [
            'prepareAppointment',
            'moveAppointment',
            'cancelAppointment',
            'editAppointment',
          ].includes(received.intent) &&
          typeof body.text === 'string' &&
          body.dialogueId === undefined &&
          body.dialogueVersion === undefined) &&
      !body.cancel &&
      !body.edit &&
      (typeof body.text === 'string' || typeof body.choice === 'string') &&
      [
        'prepareAppointment',
        'createAppointment',
        'cancelAppointment',
        'moveAppointment',
        'appointmentPreview',
      ].includes(received.action?.type) &&
      !received.dialogue
    )
      await openResult();
  }
  async function confirmHandoff(reply, action, handoff, review) {
    const destination = {
      view: state.currentView,
      editor: state.editorMode,
      selectedId: state.selectedId,
    };
    const current = () =>
      pendingHandoff === handoff &&
      !handoff.feedbackCancelled &&
      !document.hidden &&
      panel?.isConnected &&
      !active &&
      !panel.open &&
      panelSession === handoff.session &&
      sequence === handoff.sequence &&
      state.assistantGeneration === review.generation &&
      accountContext() === review.identity &&
      state.assistantScope?.enabled === true &&
      state.assistantScope.organizationId === state.account?.organizationId &&
      state.assistantScope.policyVersion === review.policyVersion &&
      state.currentView === destination.view &&
      state.editorMode === destination.editor &&
      state.selectedId === destination.selectedId;
    if (!current()) return;
    const text =
      reply.speechPermit?.handoffText ??
      ([
        'prepareAppointment',
        'createAppointment',
        'cancelAppointment',
        'moveAppointment',
        'appointmentPreview',
      ].includes(action.type)
        ? String(
            reply.text ||
              (action.type === 'createAppointment'
                ? 'Запись сохранена.'
                : action.type === 'cancelAppointment'
                  ? 'Запись отменена.'
                  : action.type === 'moveAppointment'
                    ? 'Запись перенесена.'
                    : 'Открыл форму записи. Запись не сохранена.'),
          ).trim()
        : action.type === 'calendar'
          ? 'Открыл расписание.'
          : action.type === 'clientCard'
            ? 'Открыл карточку клиента.'
            : 'Открыл список клиентов.');
    const limit = Math.max(
      100,
      Math.min(1000, Number(state.assistantScope.limits?.maxReplyChars) || 600),
    );
    if (!text || text.length > limit || state.assistantScope.capabilities?.tts?.ready !== true)
      return;
    const ownedController = new AbortController();
    controller = ownedController;
    const form = ['prepareAppointment', 'appointmentPreview'].includes(action.type)
      ? document.querySelector('#form-content')
      : null;
    const changed = () => {
      handoff.feedbackCancelled = true;
      ownedController.abort();
      actions.stopAssistantAudio();
    };
    form?.addEventListener('input', changed);
    form?.addEventListener('change', changed);
    const speechBody = {
      text,
      policyVersion: review.policyVersion,
      ...(state.assistantScope.billing?.paid === true && reply.taskRequestId
        ? { taskRequestId: reply.taskRequestId, speechToken: reply.speechPermit?.token }
        : {}),
      ...(state.assistantScope.capabilities?.tts?.streaming === true
        ? {
            stream: true,
            ...(actions.assistantAudioFormat?.() === 'pcm' ? { format: 'pcm' } : {}),
          }
        : {}),
    };
    const direct = directPcmSpeech(speechBody);
    if (!direct) timing('speakStart', review.timing);
    try {
      const response =
        direct ||
        (await actions.request('/api/assistant/speak', {
          method: 'POST',
          body: JSON.stringify(speechBody),
          timeoutMs: state.assistantScope.limits?.requestTimeoutMs || 20000,
          signal: ownedController.signal,
          assistantRequest: true,
          assistantTiming: (header) => timing('speakServer', review.timing, header),
        }));
      if (!direct) timing('speakEnd', review.timing);
      if (!current() || ownedController.signal.aborted) return;
      if (response?.policyVersion !== review.policyVersion) {
        actions.resetAssistant();
        return;
      }
      if (!direct) timing('speakSucceeded', review.timing);
      const played = await actions.playAssistantAudio({
        ...response,
        text,
        onTiming: (event, value) => timing(event, review.timing, value),
        onStarted: () => {
          if (current()) timing('audioStarted', review.timing);
        },
      });
      if (played === false && current())
        actions.toast('Действие выполнено, но не удалось озвучить результат.');
    } catch {
      if (!direct) timing('speakEnd', review.timing);
      if (current() && !ownedController.signal.aborted)
        actions.toast('Действие выполнено, но не удалось озвучить результат.');
    } finally {
      form?.removeEventListener('input', changed);
      form?.removeEventListener('change', changed);
      if (controller === ownedController) controller = null;
    }
  }
  async function openResult({ voice = false } = {}) {
    if (busy || recording || !valid() || !result?.action || (voice && !speech.voiceEnabled)) return;
    const session = panelSession;
    const action = result.action,
      scopeBefore = state.assistantScope;
    const review = {
      timing: turnTiming,
      reply: result,
      text: field('text').value,
      heard: field('heard').textContent,
      heardHidden: field('heard').hidden,
      generation: state.assistantGeneration,
      identity: accountContext(),
      view: state.currentView,
      editor: state.editorMode,
      selectedId: state.selectedId,
      policyVersion: scopeBefore.policyVersion,
    };
    let handoffSession = null,
      handoff = null,
      recoveryReply = null,
      recoverySession = null;
    busy = true;
    updateControls();
    try {
      if (!['createAppointment', 'cancelAppointment', 'moveAppointment'].includes(action.type)) {
        const scope = await assistantRequest('/api/assistant/scope');
        if (!scope) return;
        if (
          scope.enabled !== true ||
          scope.policyVersion !== scopeBefore.policyVersion ||
          scope.organizationId !== scopeBefore.organizationId
        ) {
          actions.applyAssistantScope(scope);
          status('Доступ или настройки помощника изменились. Повторите запрос.');
          return;
        }
        actions.applyAssistantScope(scope);
      }
      if (!valid() || (voice && !speech.voiceEnabled)) return;
      closeAssistantPanel({ preserveAudio: voice });
      handoffSession = panelSession;
      handoff = { generation: review.generation, session: panelSession, sequence };
      pendingHandoff = handoff;
      startHandoffProgress(action, handoff, review);
      timing('actionStart', review.timing);
      let opened;
      try {
        opened = await actions.runAssistantAction(action);
      } finally {
        timing('actionEnd', review.timing);
      }
      endHandoffProgress(handoff);
      if (
        opened?.saved === false &&
        opened.code === 'ASSISTANT_EXECUTION_REQUIRES_INPUT' &&
        opened.recovery
      )
        throw Object.assign(Error(opened.recovery.text), { assistantRecovery: opened.recovery });
      if (
        ['createAppointment', 'cancelAppointment', 'moveAppointment'].includes(action.type) &&
        opened === false
      )
        return;
      if (opened === false || (voice && opened !== true && opened?.saved !== true))
        throw Error('Не удалось выполнить действие. Повторите открытие.');
      timing('actionSucceeded', review.timing);
      if (voice)
        await confirmHandoff(
          opened?.saved === true ? opened : review.reply,
          action,
          handoff,
          review,
        );
      else if (opened?.saved === true) actions.toast(opened.text);
    } catch (error) {
      endHandoffProgress(handoff);
      if (handoffSession === null) {
        if (session === panelSession && valid()) status(error.message);
      } else if (
        panel?.isConnected &&
        !panel.open &&
        panelSession === handoffSession &&
        state.assistantGeneration === review.generation &&
        accountContext() === review.identity &&
        state.assistantScope?.enabled === true &&
        state.assistantScope.organizationId === state.account?.organizationId &&
        state.currentView === review.view &&
        state.currentView === 'calendar' &&
        state.selectedId === review.selectedId &&
        !document.hidden &&
        !state.busy &&
        !state.editorMode
      ) {
        openedGeneration = review.generation;
        openedIdentity = review.identity;
        panelSession++;
        active = true;
        if (voiceMode) presentation.start();
        else panel.showModal();
        showResult(error.assistantRecovery || review.reply);
        field('text').value = review.text;
        field('heard').textContent = review.heard;
        field('heard').hidden = review.heardHidden;
        busy = false;
        updateControls();
        status(error.message);
        if (error.assistantRecovery) {
          recoveryReply = error.assistantRecovery;
          recoverySession = panelSession;
        }
      } else if (
        panelSession === handoffSession &&
        state.assistantGeneration === review.generation &&
        accountContext() === review.identity
      )
        actions.toast(error.message);
    } finally {
      endHandoffProgress(handoff);
      if (
        voice &&
        handoff &&
        pendingHandoff === handoff &&
        state.assistantGeneration === review.generation &&
        accountContext() === review.identity
      )
        if (!recoveryReply) actions.releaseAssistantAudio?.();
      if (pendingHandoff === handoff) pendingHandoff = null;
      if (session === panelSession) {
        busy = false;
        updateControls();
      }
    }
    if (
      voice &&
      recoveryReply &&
      valid() &&
      !document.hidden &&
      panelSession === recoverySession &&
      state.assistantGeneration === review.generation &&
      accountContext() === review.identity
    )
      await speech.startVoice(recoveryReply);
  }
  function mountVoiceAssistant() {
    if (handoffProgress && !handoffProgressCurrent(handoffProgress.handoff, handoffProgress.review))
      closeAssistantPanel();
    if (
      state.currentView !== 'calendar' ||
      !state.assistantScope?.enabled ||
      !state.assistantReady
    ) {
      actions.destroyAssistantTrigger();
      if (active || handoffProgress) closeAssistantPanel();
      return;
    }
    actions.mountAssistantTrigger(
      (options) => {
        void openPanel(options);
      },
      () => actions.unlockAssistantAudio?.(),
      prepareVoiceScope,
    );
  }
  return { mountVoiceAssistant, destroyVoiceAssistant };
}
