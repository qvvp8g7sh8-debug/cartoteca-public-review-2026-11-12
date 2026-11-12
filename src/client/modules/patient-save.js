/** @param {import('../contracts/domain').SaveState} state
 * @param {import('../contracts/ports').PatientSavePorts} actions */
function createPatientSave(state, actions) {
  /** @param {import('../contracts/domain').FormValues} v */
  function savePatientForm(v) {
    if (/^\+7?$/.test(String(v.phone || '').trim())) v.phone = '';
    Object.assign(v, actions.patientFormValues(v));
    const error = actions.validatePatientValues(v);
    if (error) {
      actions.$('#form-error').textContent = error;
      return;
    }
    return persistPatientForm(v);
  }
  /** @param {import('../contracts/domain').FormValues} v */
  async function persistPatientForm(v) {
    const wasEditing = Boolean(state.editorMode.id);
    if (state.editorMode.id) {
      const patient = state.data.find((x) => x.id === state.editorMode.id);
      if (!patient) throw new Error('Карточка уже удалена или недоступна.');
      Object.assign(patient, v);
    } else {
      const id = 'p' + Date.now();
      state.data.push({ ...v, id, createdBy: actions.accountId(), visits: [], appointments: [] });
      state.selectedId = id;
    }
    await actions.save();
    actions.closeEditor();
    if (wasEditing) {
      actions.renderList();
      actions.renderDetail();
    } else actions.setView('card');
    actions.toast(wasEditing ? 'Карточка обновлена' : 'Клиент добавлен');
    if (!wasEditing) void actions.prepareTelegramInvitation(state.selectedId, { quiet: true });
    return;
  }
  return { savePatientForm };
}
