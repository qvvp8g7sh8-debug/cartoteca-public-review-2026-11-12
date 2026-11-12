function createAssistantPresentation() {
  function assistantPresentation(ui) {
    let active = false,
      indicator = null,
      shown = null,
      shownKey = '',
      shownServiceGroup = '',
      previousFocus = null;
    const dialogs = new Map();
    const titles = {
      client: 'Выбор клиента',
      service: 'Выбор услуги',
      staff: 'Выберите сотрудника',
      appointment: 'Выберите запись',
      availability: 'Выберите время',
      time: 'Выберите время',
    };
    const phases = {
      starting: 'Подключаю микрофон',
      listening: 'Слушаю',
      pending: 'Обрабатываю',
      speaking: 'Говорю',
      idle: 'Диалог приостановлен',
    };
    const progressLabels = {
      access: 'Проверяю доступ',
      create: 'Сохраняю запись',
      move: 'Переношу запись',
      cancel: 'Отменяю запись',
    };
    const button = (text, label, handler) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'secondary';
      node.textContent = text;
      if (label) node.setAttribute('aria-label', label);
      node.addEventListener('click', handler);
      return node;
    };
    function setLevel(value) {
      if (!active || !indicator || document.hidden) return;
      const level = Number(value);
      const bounded = String(Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0);
      if (indicator.style.getPropertyValue('--assistant-level') !== bounded)
        indicator.style.setProperty('--assistant-level', bounded);
    }
    function hideChoice() {
      const hadFocus = shown?.contains(document.activeElement);
      if (indicator && shown?.contains(indicator)) document.body.append(indicator);
      if (shown?.open) shown.close();
      shown = null;
      shownKey = '';
      shownServiceGroup = '';
      if (!document.hidden && hadFocus && previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
      previousFocus = null;
    }
    function ensureIndicator() {
      if (indicator) return;
      indicator = document.createElement('section');
      indicator.className = 'voice-assistant-session';
      indicator.setAttribute('aria-label', 'Голосовой помощник');
      indicator.hidden = true;
      const microphone = button('', 'Остановить голосового помощника', () => {
        if (active) ui.close();
      });
      microphone.className = 'voice-assistant-microphone';
      microphone.dataset.assistantSessionStop = '';
      microphone.innerHTML =
        '<span class="voice-assistant-microphone-ring" aria-hidden="true"></span>' +
        '<svg class="voice-assistant-microphone-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
        '<rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"></path></svg>' +
        '<span class="voice-assistant-speaking-bars" aria-hidden="true"><i></i><i></i><i></i></span>';
      const message = document.createElement('span');
      message.className = 'voice-assistant-sr-only';
      message.dataset.assistantSessionStatus = '';
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      const resume = button('Продолжить', '', () => {
        if (active) ui.resume();
      });
      resume.className = 'secondary voice-assistant-session-resume';
      resume.dataset.assistantSessionResume = '';
      const detail = document.createElement('p');
      detail.className = 'voice-assistant-session-message';
      detail.dataset.assistantSessionMessage = '';
      detail.hidden = true;
      detail.setAttribute('role', 'status');
      detail.setAttribute('aria-live', 'polite');
      indicator.append(microphone, message, detail, resume);
      document.body.append(indicator);
    }
    function choiceDialog(kind) {
      if (dialogs.has(kind)) return dialogs.get(kind);
      const dialog = document.createElement('dialog');
      dialog.className = 'voice-assistant-dialog voice-assistant-picker';
      dialog.dataset.assistantPicker = kind;
      dialog.setAttribute('aria-label', titles[kind]);
      if (!['client', 'service'].includes(kind)) {
        const heading = document.createElement('div');
        heading.className = 'voice-assistant-heading';
        const title = document.createElement('h2');
        title.textContent = titles[kind];
        heading.append(
          title,
          button('×', 'Закрыть выбор и остановить помощника', () => ui.close()),
        );
        const prompt = document.createElement('p');
        prompt.dataset.assistantPickerPrompt = '';
        dialog.append(heading, prompt);
      }
      if (kind === 'service') {
        const title = document.createElement('h2');
        title.dataset.assistantServiceGroup = '';
        title.hidden = true;
        const prompt = document.createElement('p');
        prompt.dataset.assistantPickerPrompt = '';
        prompt.setAttribute('role', 'status');
        prompt.hidden = true;
        dialog.append(title, prompt);
      }
      const choices = document.createElement('div');
      choices.className = 'voice-assistant-choices';
      choices.dataset.assistantPickerChoices = '';
      const controls = document.createElement('div');
      controls.className = 'voice-assistant-picker-controls';
      controls.dataset.assistantPickerControls = '';
      dialog.append(choices, controls);
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        ui.close();
      });
      let backdropPointer = null;
      const outside = (event) => {
        const bounds = dialog.getBoundingClientRect();
        return (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        );
      };
      dialog.addEventListener('pointerdown', (event) => {
        backdropPointer =
          event.target === dialog &&
          event.button === 0 &&
          event.isPrimary !== false &&
          outside(event)
            ? { id: event.pointerId, key: shownKey }
            : null;
      });
      dialog.addEventListener('pointercancel', () => {
        backdropPointer = null;
      });
      dialog.addEventListener('close', () => {
        backdropPointer = null;
      });
      dialog.addEventListener('click', (event) => {
        const pointer = backdropPointer;
        backdropPointer = null;
        if (
          pointer === null ||
          shown !== dialog ||
          pointer.key !== shownKey ||
          (event.pointerId !== undefined && event.pointerId !== pointer.id) ||
          event.target !== dialog
        )
          return;
        if (outside(event)) ui.close();
      });
      document.body.append(dialog);
      dialogs.set(kind, dialog);
      return dialog;
    }
    function update(value) {
      if (!active) return;
      ensureIndicator();
      const dialogue = value.reply?.dialogue;
      const kind = dialogue?.step;
      const limit = kind === 'client' ? 12 : 25;
      const options = Array.isArray(dialogue?.options) ? dialogue.options.slice(0, limit) : [];
      const selectable = Boolean(titles[kind] && options.length && dialogue.phase !== 'closedDay');
      const pending = Boolean(value.turnPending || value.pendingTurn);
      const keepPendingGroup = pending && shown?.open && shownServiceGroup;
      if (document.hidden || (!keepPendingGroup && (pending || !selectable))) hideChoice();
      else {
        const key = keepPendingGroup
          ? shownKey
          : JSON.stringify([dialogue.id, dialogue.version, kind]);
        if (key !== shownKey) {
          const group = kind === 'service' ? dialogue.serviceGroupTitle || '' : '';
          const keepGroup = group && group === shownServiceGroup && shown?.open;
          if (!keepGroup) {
            hideChoice();
            previousFocus = document.activeElement;
            shown = choiceDialog(kind);
          }
          shownServiceGroup = group;
          if (kind === 'appointment') {
            const title =
              dialogue.phase === 'cancelConfirmation' ? 'Подтверждение отмены' : titles[kind];
            shown.setAttribute('aria-label', title);
            shown.querySelector('h2').textContent = title;
          }
          shownKey = key;
          const prompt = shown.querySelector('[data-assistant-picker-prompt]');
          if (prompt) prompt.textContent = String(dialogue.prompt || '').slice(0, 300);
          if (kind === 'service') {
            const title = shown.querySelector('[data-assistant-service-group]');
            title.textContent = group;
            title.hidden = !group;
            prompt.hidden = !group;
          }
          const choices = shown.querySelector('[data-assistant-picker-choices]');
          const controls = shown.querySelector('[data-assistant-picker-controls]');
          const owner = shown;
          const scrollTop =
            keepGroup && choices.firstElementChild?.textContent === options[0]?.label
              ? shown.scrollTop
              : 0;
          choices.replaceChildren();
          controls.replaceChildren();
          const append = (item, target) => {
            const selection = Object.freeze({
              choice: item.id,
              dialogueId: dialogue.id,
              dialogueVersion: dialogue.version,
            });
            const option = button('', '', () => ui.choose(selection));
            option.dataset.assistantChoice = item.id;
            if (item.suggested) option.dataset.assistantSuggested = '';
            const label = document.createElement('span');
            label.className = 'voice-assistant-choice-label';
            label.textContent = String(item.label || 'Выбрать');
            option.append(label);
            target.append(option);
            return option;
          };
          const firstPage = kind === 'client' ? options.slice(0, 3) : options;
          for (const item of firstPage) append(item, choices);
          for (const item of (dialogue.controls || []).slice(0, 4)) append(item, controls);
          if (kind === 'client' && options.length > firstPage.length) {
            const more = button(
              'Ещё ' + (options.length - firstPage.length),
              'Показать остальных клиентов',
              () => {
                if (
                  !active ||
                  document.hidden ||
                  shown !== owner ||
                  !owner.open ||
                  shownKey !== key ||
                  more.parentNode !== controls ||
                  more.disabled
                )
                  return;
                let first;
                for (const item of options.slice(firstPage.length)) {
                  const option = append(item, choices);
                  first ||= option;
                }
                more.remove();
                controls.hidden = !controls.childElementCount;
                first?.focus({ preventScroll: true });
              },
            );
            more.dataset.assistantClientsMore = '';
            controls.append(more);
          }
          controls.hidden = !controls.childElementCount;
          if (!shown.open) shown.showModal();
          shown.querySelector('[data-assistant-choice]')?.focus({ preventScroll: true });
          shown.scrollTop = scrollTop;
        }
        shown
          .querySelectorAll('[data-assistant-choice], [data-assistant-clients-more]')
          .forEach((node) => {
            node.disabled = Boolean(
              value.turnPending ||
              value.pendingTurn ||
              (value.busy && !value.recording && !value.voiceEnabled),
            );
          });
      }
      const parent = shown?.open ? shown : document.body;
      if (indicator.parentNode !== parent) parent.append(indicator);
      indicator.hidden = document.hidden;
      const progress = Object.hasOwn(progressLabels, value.progress) ? value.progress : null;
      const phase = progress
        ? 'pending'
        : Object.hasOwn(phases, value.phase)
          ? value.phase
          : value.recording
            ? 'listening'
            : value.busy || value.turnPending
              ? 'pending'
              : value.voiceEnabled
                ? 'starting'
                : 'idle';
      indicator.dataset.assistantPhase = phase;
      setLevel(value.level);
      const label = progress ? progressLabels[progress] : phases[phase];
      indicator.querySelector('[data-assistant-session-status]').textContent = label;
      indicator
        .querySelector('[data-assistant-session-stop]')
        .setAttribute(
          'aria-label',
          progress && progress !== 'access'
            ? 'Скрыть состояние выполнения. Запрос продолжит выполняться'
            : label + '. Остановить голосового помощника',
        );
      const detail = indicator.querySelector('[data-assistant-session-message]');
      const paused =
        (value.voiceEnabled === false || value.voicePaused === true) &&
        !value.busy &&
        !value.recording &&
        !value.turnPending;
      const message = progress
        ? label + '…'
        : paused && typeof value.message === 'string'
          ? value.message.trim().slice(0, 600)
          : '';
      detail.textContent = message;
      detail.hidden = !message;
      const resume = indicator.querySelector('[data-assistant-session-resume]');
      resume.hidden =
        Boolean(progress) ||
        (value.voiceEnabled && !value.voicePaused) ||
        value.busy ||
        value.recording;
      resume.textContent = value.pendingTurn ? 'Повторить' : 'Продолжить';
    }
    function start() {
      active = true;
    }
    function close() {
      active = false;
      hideChoice();
      for (const dialog of dialogs.values()) dialog.remove();
      dialogs.clear();
      if (indicator) {
        indicator.hidden = true;
        indicator.querySelector('[data-assistant-session-status]').textContent = '';
        const detail = indicator.querySelector('[data-assistant-session-message]');
        detail.textContent = '';
        detail.hidden = true;
      }
    }
    function destroy() {
      close();
      indicator?.remove();
      indicator = null;
    }
    return { start, update, setLevel, close, destroy };
  }
  return { assistantPresentation };
}
