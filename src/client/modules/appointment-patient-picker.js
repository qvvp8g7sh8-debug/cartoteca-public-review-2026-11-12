function createAppointmentPatientPicker(state, actions) {
  let sequence = 0,
    timer,
    timeout,
    controller,
    selected = null,
    items = [],
    active = -1,
    editor = null,
    account = null,
    suppressFocus = false;
  const root = () => actions.$('#appointment-patient-picker'),
    search = () => actions.$('#appointment-patient-search'),
    value = () => actions.$('#appointment-patient');
  function cancel() {
    sequence++;
    clearTimeout(timer);
    clearTimeout(timeout);
    controller?.abort();
    controller = null;
  }
  function closeResults() {
    cancel();
    const list = actions.$('#appointment-patient-results');
    if (list) list.hidden = true;
    search()?.setAttribute('aria-expanded', 'false');
    search()?.removeAttribute('aria-activedescendant');
    items = [];
    active = -1;
  }
  function appointmentPatientPickerHtml(patient = null) {
    return [
      `<div class="field full appointment-patient-picker" `,
      `id="appointment-patient-picker">`,
      `<label for="appointment-patient-search">Клиент</label>`,
      `<input type="hidden" `,
      `id="appointment-patient" `,
      `name="patientId" `,
      `value="${actions.esc(patient?.id || '')}">`,
      `<div class="appointment-patient-search-row">`,
      `<input type="search" `,
      `id="appointment-patient-search" `,
      `value="${actions.esc(patient ? patient.name || actions.formatPhone(patient.phone) || 'Имя не указано' : '')}" `,
      `placeholder="ФИО, телефон, обозначение" `,
      `autocomplete="off" `,
      `role="combobox" `,
      `aria-autocomplete="list" `,
      `aria-expanded="false" `,
      `aria-controls="appointment-patient-results">`,
      `<button type="button" `,
      `class="secondary appointment-patient-add" `,
      `id="appointment-patient-add" `,
      `aria-label="Создать нового клиента" `,
      `title="Создать нового клиента" `,
      `aria-pressed="false">+</button>`,
      `</div>`,
      `<div id="appointment-patient-results" `,
      `class="appointment-patient-results" `,
      `role="listbox" `,
      `aria-label="Найденные клиенты" hidden>`,
      `</div>`,
      `<p id="appointment-patient-status" `,
      `class="appointment-patient-status" `,
      `role="status" `,
      `aria-live="polite">`,
      `</p>`,
      `</div>`,
    ].join('');
  }
  function syncChoice() {
    if (!root()) return;
    const isNew = value().value === '__new__',
      button = actions.$('#appointment-patient-add');
    document.querySelectorAll('.appointment-new-field').forEach((field) => {
      field.hidden = !isNew;
      const first = field.querySelector('[name="newFirstName"]');
      if (first) first.required = false;
    });
    search().disabled = isNew;
    search().placeholder = isNew ? 'Новый клиент' : 'ФИО, телефон, обозначение';
    button.textContent = isNew ? '×' : '+';
    button.setAttribute('aria-pressed', String(isNew));
    const label = isNew ? 'Выбрать существующего клиента' : 'Создать нового клиента';
    button.setAttribute('aria-label', label);
    button.title = label;
    const details =
      selected?.id === value().value
        ? [
            selected.designation,
            selected.phone ? 'Телефон: ' + actions.formatPhone(selected.phone) : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
    actions.$('#appointment-patient-status').textContent = isNew
      ? 'Заполните данные нового клиента ниже.'
      : value().value
        ? details || 'Клиент выбран.'
        : '';
  }
  function mountAppointmentPatientPicker(patient = null) {
    closeResults();
    selected = patient;
    editor = state.editorMode;
    account = state.account?.id;
    syncChoice();
    if (value().value === '__new__') search().value = '';
  }
  function query() {
    return actions.normalizePatientSearchQuery(search().value);
  }
  function showMessage(message) {
    const list = actions.$('#appointment-patient-results');
    list.innerHTML = '<p class="appointment-patient-message">' + actions.esc(message) + '</p>';
    list.hidden = false;
    search().setAttribute('aria-expanded', 'true');
  }
  async function lookup() {
    cancel();
    items = [];
    active = -1;
    search().removeAttribute('aria-activedescendant');
    const text = query();
    if (!text) {
      showMessage('Введите ФИО, телефон или обозначение.');
      return;
    }
    showMessage('Ищем клиентов…');
    const requestId = sequence;
    timer = setTimeout(async () => {
      controller = new AbortController();
      const currentController = controller;
      timeout = setTimeout(() => currentController.abort(), 12000);
      const valid = () =>
        requestId === sequence &&
        typeof document !== 'undefined' &&
        document &&
        state.editorMode === editor &&
        state.account?.id === account &&
        root()?.isConnected &&
        actions.$('#editor').open;
      try {
        const result = await actions.loadAppointmentDirectory(text, {
          signal: currentController.signal,
        });
        if (!valid()) return;
        items = result.patients;
        active = -1;
        if (!items.length) {
          showMessage('Клиент не найден. Нажмите «+», чтобы создать нового.');
          return;
        }
        const list = actions.$('#appointment-patient-results');
        list.innerHTML = items
          .map((p, i) =>
            [
              `<button type="button" `,
              `role="option" `,
              `aria-selected="false" `,
              `id="appointment-patient-option-${i}" `,
              `data-appointment-patient-index="${i}">`,
              `<strong>${actions.esc(p.name || actions.formatPhone(p.phone) || 'Имя не указано')}</strong>${actions.patientDesignationHtml(p)}${p.name && p.phone ? `<small>${actions.esc(actions.formatPhone(p.phone))}</small>` : ''}</button>`,
            ].join(''),
          )
          .join('');
        actions.$('#appointment-patient-status').textContent =
          result.matched > items.length
            ? `Найдено: ${result.matched}. Показаны первые ${items.length} — уточните поиск.`
            : `Найдено: ${result.matched}. Выберите клиента.`;
      } catch (error) {
        if (valid())
          showMessage(
            currentController.signal.aborted
              ? 'Поиск занял слишком много времени. Попробуйте ещё раз.'
              : 'Не удалось найти клиентов. Повторите поиск.',
          );
      } finally {
        if (requestId === sequence) {
          clearTimeout(timeout);
          controller = null;
        }
      }
    }, 160);
  }
  function focusSearch() {
    suppressFocus = true;
    search().focus();
    suppressFocus = false;
  }
  function choose(index) {
    const p = items[index];
    if (!p) return;
    selected = p;
    value().value = p.id;
    search().value = p.name || actions.formatPhone(p.phone) || 'Имя не указано';
    closeResults();
    value().dispatchEvent(new window.Event('change', { bubbles: true }));
    focusSearch();
  }
  function bindAppointmentPatientPickerEvents() {
    document.addEventListener('input', (e) => {
      if (e.target.id !== 'appointment-patient-search' || state.busy) return;
      value().value = '';
      selected = null;
      syncChoice();
      void lookup();
    });
    document.addEventListener('focusin', (e) => {
      if (e.target.id === 'appointment-patient-search' && !e.target.disabled && !suppressFocus)
        void lookup();
    });
    document.addEventListener('change', (e) => {
      if (e.target.id === 'appointment-patient') syncChoice();
    });
    document.addEventListener('click', (e) => {
      if (!root()) return;
      const option = e.target.closest('[data-appointment-patient-index]');
      if (option && !state.busy) {
        choose(Number(option.dataset.appointmentPatientIndex));
        return;
      }
      if (e.target.closest('#appointment-patient-add') && !state.busy) {
        const isNew = value().value === '__new__';
        closeResults();
        value().value = isNew ? selected?.id || '' : '__new__';
        search().value = isNew
          ? selected
            ? selected.name || actions.formatPhone(selected.phone) || 'Имя не указано'
            : ''
          : '';
        value().dispatchEvent(new window.Event('change', { bubbles: true }));
        if (isNew) focusSearch();
        else actions.$('[name="newFirstName"]').focus();
        return;
      }
      if (!e.target.closest('#appointment-patient-picker')) closeResults();
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.id !== 'appointment-patient-search') return;
      if (e.key === 'Escape' && !actions.$('#appointment-patient-results').hidden) {
        e.preventDefault();
        e.stopPropagation();
        closeResults();
        return;
      }
      if (
        e.key === 'Enter' &&
        ((active >= 0 && !actions.$('#appointment-patient-results').hidden) || !value().value)
      ) {
        e.preventDefault();
        if (active >= 0) choose(active);
        return;
      }
      if (
        !['ArrowDown', 'ArrowUp'].includes(e.key) ||
        !items.length ||
        actions.$('#appointment-patient-results').hidden
      )
        return;
      e.preventDefault();
      active =
        active < 0
          ? e.key === 'ArrowDown'
            ? 0
            : items.length - 1
          : (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      const options = [
        ...actions.$('#appointment-patient-results').querySelectorAll('[role="option"]'),
      ];
      options.forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
      search().setAttribute('aria-activedescendant', options[active].id);
      options[active].scrollIntoView?.({ block: 'nearest' });
    });
    actions.$('#editor').addEventListener('close', closeResults);
    window.addEventListener('pagehide', closeResults);
  }
  return {
    appointmentPatientPickerHtml,
    mountAppointmentPatientPicker,
    bindAppointmentPatientPickerEvents,
  };
}
