// Keep both drafts mounted; switching never discards a chosen client or service.
function createCalendarCreationTabs(state, actions) {
  let appointmentMode = null,
    personalMode = null,
    personalStarted = false;
  function resetCalendarCreationTabs() {
    actions.$('#calendar-creation-tabs')?.remove();
    const title = actions.$('#dialog-title');
    title.hidden = false;
    actions.$('#editor').setAttribute('aria-labelledby', 'dialog-title');
    actions.$('#close-editor').hidden = false;
    actions.$('#save-editor').textContent = 'Сохранить';
    appointmentMode = personalMode = null;
    personalStarted = false;
  }
  function toggleCreationPanel(panel, active, prefix) {
    for (const field of panel.querySelectorAll('[name], [data-creation-field]')) {
      const name = field.dataset.creationField || field.name;
      field.dataset.creationField = name;
      field.name = active ? name : prefix + name;
    }
    panel.hidden = panel.disabled = !active;
  }
  function setCalendarCreationTab(kind, focus = false) {
    if (state.busy || !appointmentMode || !personalMode) return;
    const appointment = actions.$('#appointment-creation-panel'),
      personal = actions.$('#personal-creation-panel'),
      isPersonal = kind === 'personalEvent';
    if (isPersonal && !personalStarted) {
      for (const name of ['date', 'time', 'duration', 'staffId']) {
        const from = appointment.querySelector(`[name="${name}"]`),
          to = personal.querySelector(`[data-creation-field="${name}"], [name="${name}"]`);
        if (from && to) {
          if (name === 'duration') to.innerHTML = actions.durationOptions(Number(from.value));
          to.value = from.value;
        }
      }
      personalStarted = true;
    }
    toggleCreationPanel(appointment, !isPersonal, '__appointment_');
    toggleCreationPanel(personal, isPersonal, '__personal_');
    personalMode.serviceItems = appointmentMode.serviceItems;
    state.editorMode = isPersonal ? personalMode : appointmentMode;
    const editor = actions.$('#editor');
    editor.dataset.editorKind = state.editorMode.kind;
    editor.setAttribute(
      'aria-labelledby',
      isPersonal ? 'personal-creation-tab' : 'appointment-creation-tab',
    );
    for (const tab of actions.$('#calendar-creation-tabs').querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.creationKind === kind;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    actions.$('#save-editor').textContent = isPersonal ? 'Зарезервировать' : 'Сохранить';
    actions.$('#form-error').textContent = '';
    actions.mountAppointmentTimePicker?.();
  }
  function mountCalendarCreationTabs() {
    resetCalendarCreationTabs();
    const mode = state.editorMode;
    if (mode?.kind === 'personalEvent') {
      actions.$('#close-editor').hidden = true;
      return;
    }
    if (!state.multiUser || mode?.kind !== 'appointment' || mode.id) return;
    appointmentMode = mode;
    personalMode = {
      kind: 'personalEvent',
      id: null,
      source: 'calendar',
      serviceItems: mode.serviceItems,
    };
    const content = actions.$('#form-content'),
      seed = Object.fromEntries(new FormData(actions.$('#editor-form')).entries()),
      appointment = document.createElement('fieldset');
    appointment.id = 'appointment-creation-panel';
    appointment.className = 'calendar-creation-panel';
    appointment.setAttribute('role', 'tabpanel');
    appointment.setAttribute('aria-labelledby', 'appointment-creation-tab');
    while (content.firstChild) appointment.append(content.firstChild);
    content.append(appointment);
    content.insertAdjacentHTML(
      'beforeend',
      '<fieldset id="personal-creation-panel" class="calendar-creation-panel" ' +
        'role="tabpanel" aria-labelledby="personal-creation-tab" hidden disabled>' +
        actions.personalEventFields(seed) +
        '</fieldset>',
    );
    toggleCreationPanel(actions.$('#personal-creation-panel'), false, '__personal_');
    const title = actions.$('#dialog-title');
    title.hidden = true;
    title.insertAdjacentHTML(
      'afterend',
      '<div id="calendar-creation-tabs" class="calendar-creation-tabs" role="tablist" aria-label="Вид записи">' +
        '<button type="button" role="tab" id="appointment-creation-tab" class="calendar-creation-tab" ' +
        'aria-controls="appointment-creation-panel" aria-selected="true" data-creation-kind="appointment">Новая запись</button>' +
        '<button type="button" role="tab" id="personal-creation-tab" class="calendar-creation-tab" ' +
        'aria-controls="personal-creation-panel" aria-selected="false" tabindex="-1" data-creation-kind="personalEvent">Личное</button></div>',
    );
    actions.$('#close-editor').hidden = true;
    actions.$('#editor').setAttribute('aria-labelledby', 'appointment-creation-tab');
  }
  function bindCalendarCreationTabEvents() {
    actions.$('#editor').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-creation-kind]');
      if (tab) setCalendarCreationTab(tab.dataset.creationKind);
    });
    actions.$('#editor').addEventListener('keydown', (event) => {
      if (
        !event.target.matches('[data-creation-kind]') ||
        !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
      )
        return;
      event.preventDefault();
      const kind =
        event.key === 'Home'
          ? 'appointment'
          : event.key === 'End'
            ? 'personalEvent'
            : state.editorMode.kind === 'appointment'
              ? 'personalEvent'
              : 'appointment';
      setCalendarCreationTab(kind, true);
    });
  }
  return { mountCalendarCreationTabs, resetCalendarCreationTabs, bindCalendarCreationTabEvents };
}
