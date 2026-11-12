function createSettingsGuard(state, actions) {
  const baselines = new window.WeakMap();
  let asking = false;
  function snapshot(form) {
    return JSON.stringify(
      [
        ...form.querySelectorAll(
          'input:not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea',
        ),
      ].map((field) => [field.name, field.value, field.checked]),
    );
  }
  function markSettingsSaved(form) {
    if (form?.isConnected) baselines.set(form, snapshot(form));
  }
  function dirtyForms() {
    return [...(actions.$('#global-view')?.querySelectorAll('.settings-panel form') || [])].filter(
      (form) => baselines.has(form) && baselines.get(form) !== snapshot(form),
    );
  }
  const hasUnsavedSettings = () => dirtyForms().length > 0;
  async function confirmSettingsLeave() {
    if (!dirtyForms().length) return true;
    if (asking || state.busy) return false;
    asking = true;
    try {
      return await actions.confirmAction(
        'Изменения не сохранены',
        'При переходе введённые настройки будут потеряны.',
        'Перейти без сохранения',
        'Продолжить',
        { preferCancel: true },
      );
    } finally {
      asking = false;
    }
  }
  function bindSettingsGuardEvents() {
    const root = actions.$('#global-view');
    const register = () => {
      for (const form of root.querySelectorAll('.settings-panel form'))
        if (!baselines.has(form)) markSettingsSaved(form);
    };
    new window.MutationObserver(register).observe(root, { childList: true, subtree: true });
    root.addEventListener('focusin', register);
    window.addEventListener('beforeunload', (event) => {
      if (!dirtyForms().length) return;
      event.preventDefault();
      event.returnValue = '';
    });
    register();
  }
  return { markSettingsSaved, hasUnsavedSettings, confirmSettingsLeave, bindSettingsGuardEvents };
}
