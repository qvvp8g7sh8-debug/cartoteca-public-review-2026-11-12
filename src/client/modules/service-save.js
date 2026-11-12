/** @param {import('../contracts/domain').SaveState} state
 * @param {import('../contracts/ports').ServiceSavePorts} actions */
function createServiceSave(state, actions) {
  /** @param {import('../contracts/domain').FormValues} v */
  function saveServiceForm(v) {
    const error = actions.validateServiceValues(v);
    if (error) {
      actions.$('#form-error').textContent = error;
      return;
    }
    return persistServiceForm(v);
  }
  /** @param {import('../contracts/domain').FormValues} v */
  async function persistServiceForm(v) {
    const wasEditing = Boolean(state.editorMode.id);
    let savedId = state.editorMode.id;
    const duration = Number(v.duration),
      price = Number(v.price);
    const category = state.SERVICE_CATEGORIES.some((item) => item.id === v.category)
      ? v.category
      : 'other';
    actions.configureServiceView({ category });
    if (state.editorMode.id) {
      if (
        !window.confirm(
          `Сохранить изменения услуги «${v.name}» со стоимостью ${actions.formatPrice(price)}?`,
        )
      )
        return;
      const target = state.services.find((x) => x.id === state.editorMode.id);
      if (target)
        Object.assign(target, {
          name: v.name.trim(),
          category,
          description: (v.description || '').trim(),
          duration: `${duration} минут`,
          price,
        });
    } else {
      savedId = 's' + Date.now();
      state.services.push({
        id: savedId,
        ...(state.editorMode.staffId ? { staffId: state.editorMode.staffId } : {}),
        name: v.name.trim(),
        category,
        description: (v.description || '').trim(),
        duration: `${duration} минут`,
        price,
      });
    }
    await actions.saveServices();
    if (actions.restoreAppointmentEditor(savedId || '')) {
      actions.toast('Услуга создана. Выберите её для записи');
      return;
    }
    actions.closeEditor();
    actions.setView(state.currentView);
    actions.toast(wasEditing ? 'Услуга изменена' : 'Услуга добавлена');
    return;
  }
  return { saveServiceForm };
}
