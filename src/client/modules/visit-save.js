/** @param {import('../contracts/domain').SaveState} state
 * @param {import('../contracts/ports').VisitSavePorts} actions */
function createVisitSave(state, actions) {
  /** @param {import('../contracts/domain').VisitValues} v */
  function saveVisitForm(v) {
    if (!state.editorMode.appendOnly && !v.procedure.trim()) {
      actions.$('#form-error').textContent = 'Укажите услугу.';
      return;
    }
    return persistVisitForm(v);
  }
  /** @param {import('../contracts/domain').VisitValues} v */
  async function persistVisitForm(v) {
    const wasEditing = Boolean(state.editorMode.id);
    const p = state.data.find((x) => x.id === state.editorMode.patientId);
    if (!p) throw new Error('Карточка уже удалена или недоступна.');
    const prior = state.editorMode.id ? p.visits.find((x) => x.id === state.editorMode.id) : null;
    const appointment = state.editorMode.appointmentId
      ? p.appointments.find((a) => a.id === state.editorMode.appointmentId)
      : null;
    if (state.editorMode.appointmentId && !appointment)
      throw new Error('Исходная запись не найдена.');
    if (appointment?.status === 'completed' && !prior)
      throw new Error('Это посещение уже оформлено. Откройте его из истории.');
    if (appointment && actions.isClosedAppointment(appointment))
      throw new Error('Отменённую запись и неявку нельзя оформить как посещение.');
    if (state.editorMode.appendOnly) {
      if (!prior) throw new Error('Проведённое посещение не найдено.');
      const addition = (v.notes || '').trim(),
        updated = { ...prior, photos: state.uploadItems };
      if (addition) updated.notes = (prior.notes ? prior.notes + '\n\n' : '') + addition;
      p.visits[p.visits.findIndex((x) => x.id === prior.id)] = updated;
      await actions.save();
      actions.closeEditor();
      state.selectedId = p.id;
      state.activeTab = 'visits';
      actions.setView('card');
      actions.toast('Дополнение сохранено');
      return;
    }
    const durationError = actions.validateVisitDuration(v);
    if (durationError) throw new Error(durationError);
    /** @type {import('../contracts/domain').Visit} */
    const obj = {
      ...prior,
      ...v,
      duration: Number(v.duration),
      id: state.editorMode.id || 'v' + Date.now(),
      photos: state.uploadItems,
      staffId: v.staffId || prior?.staffId || actions.accountId(),
    };
    if (state.editorMode.serviceItems?.length || prior?.serviceItems !== undefined || appointment)
      obj.serviceItems = structuredClone(state.editorMode.serviceItems || []);
    if (v.duration) obj.duration = Number(v.duration);
    else delete obj.duration;
    if (appointment) {
      obj.appointmentId = appointment.id;
      obj.staffId = appointment.staffId || obj.staffId;
      appointment.status = 'completed';
      appointment.completedVisitId = obj.id;
      if (obj.date < appointment.date) {
        appointment.date = obj.date;
        if (obj.time) appointment.time = obj.time;
      }
      state.calendarAnchorDate = actions.parseDate(appointment.date);
    }
    if (state.editorMode.id) {
      const i = p.visits.findIndex((x) => x.id === state.editorMode.id);
      p.visits[i] = obj;
    } else p.visits.push(obj);
    await actions.save();
    actions.closeEditor();
    state.selectedId = p.id;
    state.activeTab = 'visits';
    actions.setView('card');
    actions.toast(wasEditing ? 'Посещение обновлено' : 'Посещение сохранено');
  }
  return { saveVisitForm };
}
