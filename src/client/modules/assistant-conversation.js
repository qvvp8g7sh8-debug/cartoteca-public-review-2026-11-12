function createAssistantConversation() {
  function assistantPanelHtml() {
    return [
      '<div class="voice-assistant-heading"><div><h2 id="voice-assistant-title">Помощник</h2>',
      '<p class="form-hint" data-assistant-mode></p></div>',
      '<button type="button" class="secondary" data-assistant-close aria-label="Закрыть помощника">×</button></div>',
      '<form class="voice-assistant-form"><label class="field" data-assistant-command-label>Ваш запрос',
      '<textarea data-assistant-text maxlength="2000" rows="3" placeholder="Например: покажи моё расписание на неделю"></textarea></label>',
      '<label class="field" data-assistant-input-wrap hidden><span data-assistant-prompt></span>',
      '<input data-assistant-input autocomplete="off" maxlength="2000"></label>',
      '<div class="voice-assistant-controls"><button type="button" class="secondary" data-assistant-voice aria-pressed="false" hidden>Диалог голосом</button><button type="button" class="secondary" data-assistant-mic aria-pressed="false">Микрофон</button>',
      '<button type="submit" class="primary" data-assistant-send>Отправить</button>',
      '<button type="button" class="secondary" data-assistant-example>Пример</button>',
      '<button type="button" class="secondary" data-assistant-new hidden>Новая команда</button><button type="button" class="secondary" data-assistant-retry hidden>Повторить шаг</button></div></form>',
      '<p class="form-hint voice-assistant-status" data-assistant-status role="status" aria-live="polite"></p>',
      '<p class="form-hint" data-assistant-heard hidden aria-live="polite"></p>',
      '<div class="voice-assistant-answer" data-assistant-answer></div>',
      '<section class="voice-assistant-conversation" data-assistant-conversation hidden aria-label="Уточнение записи"></section>',
      '<p class="form-hint" data-assistant-draft></p>',
      '<div class="voice-assistant-result"><button type="button" class="primary" data-assistant-action hidden></button>',
      '<button type="button" class="secondary" data-assistant-speak hidden>Озвучить</button></div>',
      '<p class="form-hint" data-assistant-hint>Запись на приём нужно проверить и сохранить в обычной форме.</p>',
    ].join('');
  }
  function renderAssistantConversation(panel, reply, presentation = {}) {
    const field = (name) => panel.querySelector('[data-assistant-' + name + ']');
    const dialogue = reply?.dialogue;
    const readOnlySlots = Array.isArray(reply?.readOnlySlots)
      ? reply.readOnlySlots.slice(0, 12)
      : [];
    const root = field('conversation');
    root.replaceChildren();
    root.hidden = !dialogue && !readOnlySlots.length;
    field('command-label').hidden = Boolean(dialogue);
    field('input-wrap').hidden = !dialogue;
    field('send').hidden = false;
    field('example').hidden = Boolean(dialogue);
    field('new').hidden = !dialogue;
    const input = field('input');
    input.value = '';
    input.type = 'text';
    input.inputMode = 'text';
    input.min = input.max = input.step = '';
    const placeholders = {
      client: 'Имя или фамилия клиента',
      date: 'Например: завтра, 20 октября или нет, послезавтра',
      time: 'Например: утром, с 10 до 12 или в 14:30',
      duration: 'Например: 45 минут или полчаса',
    };
    input.placeholder = !dialogue
      ? ''
      : placeholders[dialogue.input?.field] || 'Например: второй вариант, на полчаса позже';
    field('prompt').textContent =
      dialogue && !dialogue.input ? 'Ответ или исправление' : String(dialogue?.prompt || 'Ответ');
    if (readOnlySlots.length) {
      const list = document.createElement('ul');
      list.dataset.assistantReadOnlySlots = '';
      for (const slot of readOnlySlots) {
        const item = document.createElement('li');
        item.textContent = [
          slot.date,
          slot.time + '–' + slot.endTime,
          slot.duration + ' мин',
          slot.staffName,
        ]
          .filter(Boolean)
          .join(' · ');
        list.append(item);
      }
      const hint = document.createElement('p');
      hint.className = 'form-hint';
      hint.textContent =
        'Просмотр свободного времени. Подготовка записи помощником недоступна; окно не забронировано.';
      root.append(list, hint);
    }
    if (!dialogue) return;
    const summary = document.createElement('dl');
    summary.className = 'voice-assistant-fields';
    for (const item of (dialogue.fields || []).slice(0, 8)) {
      const name = document.createElement('dt'),
        value = document.createElement('dd');
      name.textContent = String(item.label || 'Поле');
      value.textContent = String(item.value || 'Не указано');
      if (dialogue.canEdit?.includes(item.key)) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'text-btn';
        edit.dataset.assistantEdit = item.key;
        edit.textContent = 'Изменить';
        edit.setAttribute('aria-label', 'Изменить: ' + name.textContent);
        value.append(' ', edit);
      }
      summary.append(name, value);
    }
    root.append(summary);
    const options = document.createElement('div');
    options.className = 'voice-assistant-choices';
    for (const item of (dialogue.options || []).slice(0, 25)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = dialogue.step === 'review' ? 'primary' : 'secondary';
      button.dataset.assistantChoice = item.id;
      button.textContent = String(item.label || 'Выбрать');
      options.append(button);
    }
    root.append(options);
    if (dialogue.controls?.length) {
      const controls = document.createElement('div');
      controls.className = 'voice-assistant-controls';
      for (const item of dialogue.controls.slice(0, 4)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-btn';
        button.dataset.assistantChoice = item.id;
        button.textContent = String(item.label || 'Выбрать');
        controls.append(button);
      }
      root.append(controls);
    }
    if (dialogue.step === 'availability') {
      const hint = document.createElement('p');
      hint.className = 'form-hint';
      hint.textContent = 'Выбор не бронирует время. Занятость проверяется перед записью.';
      root.append(hint);
    }
    if (!presentation.voice) input.focus();
  }
  return { assistantPanelHtml, renderAssistantConversation };
}
