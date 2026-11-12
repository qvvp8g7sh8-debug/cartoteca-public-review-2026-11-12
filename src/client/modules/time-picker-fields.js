function createTimePickerFields(state, actions) {
  const scopes = new Map();
  function clear(root) {
    for (const [source, item] of scopes.get(root) || []) {
      item.control.destroy();
      item.field.remove();
      source.hidden = item.wasHidden;
      source.removeAttribute('data-time-picker-source');
    }
    scopes.delete(root);
  }
  function mountTimePickerFields(root, context = {}) {
    if (!root) return;
    for (const previous of scopes.keys()) if (!previous.isConnected) clear(previous);
    clear(root);
    if (!state.multiUser) return;
    const mounted = new Map();
    scopes.set(root, mounted);
    const sources = root.querySelectorAll(
      'select[name="time"],input[type="time"],[data-work-time],#calendar-hidden-until',
    );
    for (const source of sources) {
      if (
        source.closest('fieldset:disabled') ||
        source.closest('[hidden]:not([data-time-picker-source])')
      )
        continue;
      const adapter = actions.timePickerSource(source);
      if (!adapter) continue;
      const field = document.createElement('div');
      field.className = 'time-picker-field';
      field.setAttribute('role', 'group');
      field.setAttribute('aria-label', adapter.label);
      field.innerHTML = actions.timePickerFieldHtml(adapter.allowEmpty);
      field.querySelector('[data-time-dropdown]').setAttribute('aria-label', adapter.label);
      if (adapter.allowEmpty) field.dataset.timePickerOptional = '';
      field.addEventListener('click', (event) => event.preventDefault());
      source.before(field);
      mounted.set(source, {
        field,
        control: actions.mountTimePickerField(source, field, context),
        wasHidden: source.hidden,
      });
      source.hidden = true;
      source.dataset.timePickerSource = '';
    }
  }
  function mountAppointmentTimePicker() {
    const root = actions.$('#form-content');
    if (
      !['appointment', 'personalEvent', 'visit', 'workSchedule'].includes(state.editorMode?.kind)
    ) {
      clear(root);
      return;
    }
    mountTimePickerFields(root);
  }
  return { mountAppointmentTimePicker, mountTimePickerFields };
}
