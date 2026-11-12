function createTimePicker(state, actions) {
  const fields = new Set();
  let bound = false,
    sequence = 0;
  function mountTimePickerField(source, field, context = {}) {
    const adapter = actions.timePickerSource(source);
    const mode = state.editorMode,
      account = state.account;
    const trigger = field.querySelector('[data-time-dropdown]');
    const popup = field.querySelector('[data-time-popup]');
    const options = field.querySelector('[data-time-options]');
    const clear = field.querySelector('[data-time-picker-clear]');
    popup.id = 'time-picker-popup-' + ++sequence;
    trigger.setAttribute('aria-controls', popup.id);
    popup.setAttribute('aria-label', adapter.label);
    // Calendar-cell creation keeps every minute equally prominent.
    popup.dataset.workTimeEmphasis = String(source.matches('[data-work-time]'));
    popup.dataset.timeEmphasis = String(
      context.editor !== false &&
        mode?.kind === 'appointment' &&
        !mode.id &&
        source.matches('select[name="time"]') &&
        !source.hasAttribute('data-calendar-slot-time'),
    );
    options.id = popup.id + '-options';
    // The auxiliary list stays outside form-content/editorSnapshot.
    (source.closest('dialog') || document.body).append(popup);
    let destroyed = false,
      opened = false,
      signature = '',
      active = 0;
    const available = () =>
      !destroyed &&
      adapter.connected() &&
      field.isConnected &&
      (context.editor === false || state.editorMode === mode) &&
      state.account === account &&
      (context.editor === false || actions.$('#editor').open) &&
      !state.busy &&
      adapter.enabled() &&
      !field.closest('[hidden], [inert]') &&
      (!context.guard || context.guard());
    function close(restoreFocus = false) {
      if (!opened) return;
      opened = false;
      if (popup.hidePopover && popup.matches(':popover-open')) popup.hidePopover();
      popup.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      options.removeAttribute('aria-activedescendant');
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }
    function position() {
      if (!opened) return;
      if (!field.isConnected) return close();
      const rect = field.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 230), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 8,
        above = rect.top - 8;
      const upward = below < 360 && above > below;
      Object.assign(popup.style, {
        position: 'fixed',
        width: width + 'px',
        maxHeight: Math.max(88, Math.min(376, upward ? above : below)) + 'px',
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px',
        top: upward ? 'auto' : rect.bottom + 4 + 'px',
        bottom: upward ? window.innerHeight - rect.top + 4 + 'px' : 'auto',
      });
    }
    function highlight(reveal = false) {
      const buttons = [...options.querySelectorAll('[data-time-choice]')];
      active = Math.max(0, Math.min(buttons.length - 1, active));
      for (const [index, button] of buttons.entries())
        button.dataset.active = String(index === active);
      const button = buttons[active];
      if (!button) return options.removeAttribute('aria-activedescendant');
      options.setAttribute('aria-activedescendant', button.id);
      if (!reveal) return;
      const top = button.offsetTop;
      if (top < options.scrollTop) options.scrollTop = top;
      else if (top + button.offsetHeight > options.scrollTop + options.clientHeight)
        options.scrollTop = top + button.offsetHeight - options.clientHeight;
    }
    function render() {
      const values = adapter.values();
      const choices = values;
      const fragment = document.createDocumentFragment();
      for (const [index, value] of choices.entries()) {
        const button = document.createElement('div');
        button.id = options.id + '-' + index;
        button.setAttribute('role', 'option');
        button.dataset.timeChoice = value;
        button.dataset.timeMajor = String(value.endsWith(':00') || value.endsWith(':30'));
        button.dataset.timeMinute = value.slice(3);
        button.textContent = value;
        button.setAttribute('aria-selected', String(value === adapter.value()));
        fragment.append(button);
      }
      options.replaceChildren(fragment);
      const message = popup.querySelector('[data-time-empty]');
      message.hidden = Boolean(choices.length);
      active = Math.max(0, choices.indexOf(adapter.value()));
      position();
      highlight(true);
    }
    function sync() {
      if (destroyed) return;
      const disabled = !adapter.enabled() || !adapter.values().length;
      trigger.disabled = disabled;
      field.setAttribute('aria-disabled', String(disabled));
      field.querySelector('[data-time-value]').textContent = adapter.value() || '—';
      trigger.setAttribute('aria-label', adapter.label + ': ' + (adapter.value() || 'не указано'));
      if (clear) clear.disabled = disabled || !adapter.value();
      const next = adapter.value() + '|' + adapter.values().join(',');
      if (opened && disabled) close();
      else if (opened && next !== signature) render();
      signature = next;
    }
    function open(event) {
      event.preventDefault();
      if (opened) return close(true);
      if (!available()) return sync();
      for (const control of fields) control.close();
      opened = true;
      popup.hidden = false;
      if (popup.showPopover) popup.showPopover();
      trigger.setAttribute('aria-expanded', 'true');
      render();
      options.focus({ preventScroll: true });
      window.addEventListener('resize', position);
      document.addEventListener('scroll', position, true);
    }
    function triggerKey(event) {
      if (['ArrowUp', 'ArrowDown'].includes(event.key) && !opened) open(event);
    }
    function commit(value) {
      if (!available()) {
        close();
        return sync();
      }
      if (!adapter.values().includes(value)) return render();
      const previous = adapter.value();
      if (previous !== value) adapter.set(value);
      sync();
      close(true);
      field.removeAttribute('aria-invalid');
      field.removeAttribute('title');
      if (previous !== value) adapter.notify(previous);
    }
    function keepListFocus(event) {
      const choice = event.target.closest('[data-time-choice]');
      // A nonfocusable option otherwise focuses the dialog and closes the popup before click.
      if (choice?.parentElement === options) event.preventDefault();
    }
    function choose(event) {
      const button = event.target.closest('[data-time-choice]');
      if (!button || button.parentElement !== options) return;
      event.preventDefault();
      commit(button.dataset.timeChoice);
    }
    function keydown(event) {
      if (!opened) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === 'Tab') return close(true);
      const buttons = [...options.querySelectorAll('[data-time-choice]')];
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (buttons[active]) commit(buttons[active].dataset.timeChoice);
        return;
      }
      if (
        !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key) ||
        !buttons.length
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home') active = 0;
      else if (event.key === 'End') active = buttons.length - 1;
      else active += { ArrowUp: -1, ArrowDown: 1, PageUp: -7, PageDown: 7 }[event.key];
      highlight(true);
    }
    function invalid(event) {
      event.preventDefault();
      field.setAttribute('aria-invalid', 'true');
      field.title = 'Выберите время.';
      trigger.focus({ preventScroll: true });
    }
    function clearValue(event) {
      event.preventDefault();
      if (!available() || !adapter.allowEmpty || !adapter.value()) return;
      const previous = adapter.value();
      adapter.set('');
      sync();
      close();
      adapter.notify(previous);
    }
    const observer = new window.MutationObserver(sync);
    for (const node of adapter.nodes) {
      node.addEventListener('change', sync);
      node.addEventListener('invalid', invalid);
    }
    observer.observe(source, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'selected', 'value', 'min', 'max', 'step', 'required'],
    });
    trigger.addEventListener('click', open);
    trigger.addEventListener('keydown', triggerKey);
    options.addEventListener('mousedown', keepListFocus);
    options.addEventListener('click', choose);
    popup.addEventListener('keydown', keydown);
    clear?.addEventListener('click', clearValue);
    sync();
    const control = {
      field,
      popup,
      close,
      flush() {},
      editor: context.editor !== false,
      destroy() {
        if (destroyed) return;
        close();
        destroyed = true;
        observer.disconnect();
        for (const node of adapter.nodes) {
          node.removeEventListener('change', sync);
          node.removeEventListener('invalid', invalid);
        }
        trigger.removeEventListener('click', open);
        trigger.removeEventListener('keydown', triggerKey);
        options.removeEventListener('mousedown', keepListFocus);
        options.removeEventListener('click', choose);
        popup.removeEventListener('keydown', keydown);
        clear?.removeEventListener('click', clearValue);
        popup.remove();
        fields.delete(control);
      },
    };
    fields.add(control);
    return control;
  }
  function bindTimePickerEvents() {
    if (bound) return;
    bound = true;
    const closeOutside = (event) => {
      for (const control of fields)
        if (!control.field.contains(event.target) && !control.popup.contains(event.target))
          control.close();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('focusin', closeOutside);
    const editor = actions.$('#editor');
    editor.addEventListener(
      'submit',
      () => {
        for (const control of fields) control.close();
      },
      true,
    );
    editor.addEventListener('close', () => {
      if (!editor.open) for (const control of fields) if (control.editor) control.destroy();
    });
  }
  return { mountTimePickerField, bindTimePickerEvents };
}
