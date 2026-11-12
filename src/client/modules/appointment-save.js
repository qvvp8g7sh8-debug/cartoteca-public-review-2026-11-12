/** @param {import('../contracts/domain').SaveState} state
 * @param {import('../contracts/ports').AppointmentSavePorts} actions */
function createAppointmentSave(state, actions) {
  /** @param {import('../contracts/domain').FormValues} v */
  async function saveAppointmentForm(v) {
    const wasEditing = Boolean(state.editorMode.id);
    const editMode = state.editorMode,
      point = editMode.pointEdit;
    const pointEdit = point && point.patientId === v.patientId;
    const activeEdit = () =>
      state.editorMode === editMode &&
      (!point ||
        point.account ===
          JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]));
    if (!pointEdit && v.patientId && v.patientId !== '__new__')
      await actions.ensurePatient(v.patientId);
    if (
      state.editorMode.patientId &&
      state.editorMode.patientId !== '__new__' &&
      state.editorMode.patientId !== v.patientId
    )
      await actions.ensurePatient(state.editorMode.patientId, point ? { force: true } : undefined);
    if (point && !pointEdit) actions.assertAppointmentEdit(point);
    // A local editor value, never inserted into the full-patient cache.
    let p = pointEdit
      ? { id: point.patientId, visits: [], appointments: [point.before] }
      : state.data.find((x) => x.id === v.patientId);
    if (v.patientId === '__new__') {
      const names = actions.patientFormValues(v, { appointment: true });
      const identity = { ...names, phone: v.newPhone.trim() };
      const identityError = actions.validatePatientValues({
        name: identity.name,
        designation: identity.designation,
        phone: identity.phone,
      });
      if (identityError) {
        actions.$('#form-error').textContent = identityError;
        return;
      }
      p = {
        id: 'p' + Date.now(),
        ...identity,
        birth: '',
        allergies: '',
        notes: '',
        createdBy: actions.accountId(),
        visits: [],
        appointments: [],
      };
    } else if (!p) {
      actions.$('#form-error').textContent = 'Выберите человека.';
      return;
    }
    const error = actions.validateAppointmentValues(v);
    if (error) {
      actions.$('#form-error').textContent = error;
      return;
    }
    const duration = Number(v.duration);
    const isNewPatient = !state.data.includes(p);
    const old = pointEdit
      ? { patient: p, appointment: point.before }
      : state.editorMode.id
        ? state.data
            .flatMap((x) => (x.appointments || []).map((a) => ({ patient: x, appointment: a })))
            .find((x) => x.appointment.id === state.editorMode.id)
        : null;
    if (old && !actions.isActiveAppointment(old.appointment))
      throw new Error('Закрытую запись нельзя изменять. Создайте новую запись.');
    const previous = old?.appointment;
    // The procedure picker owns the complete set, including preserved historical snapshots.
    const serviceItems = structuredClone(state.editorMode.serviceItems || []);
    /** @type {import('../contracts/domain').Appointment} */
    const obj = {
      ...previous,
      id: state.editorMode.id || 'a' + Date.now(),
      status: 'scheduled',
      serviceItems,
      date: v.date,
      time: v.time,
      service: v.service,
      duration,
      notes: v.notes.trim(),
      staffId: v.staffId || old?.appointment.staffId || actions.accountId(),
    };
    if (v.roomId) obj.roomId = v.roomId;
    else if (
      state.workspace.enabled ||
      state.workspace.staffRules?.some((rule) => rule.preventOverlap) ||
      state.workspace.rooms?.some((room) => room.active && room.preventOverlap)
    )
      throw new Error('Выберите физический кабинет.');
    const needsScheduleCheck =
      !previous ||
      previous.staffId !== obj.staffId ||
      previous.date !== obj.date ||
      previous.time !== obj.time ||
      previous.duration !== obj.duration;
    if (needsScheduleCheck || previous?.roomId !== obj.roomId)
      await actions.assertAppointmentAvailability(obj);
    const scheduleAcknowledgement = needsScheduleCheck
      ? await actions.confirmAppointmentWorkSchedule(obj)
      : '';
    if (scheduleAcknowledgement === false) return;
    if (!activeEdit()) throw new Error('Аккаунт или форма изменились. Откройте запись заново.');
    if (pointEdit) {
      await actions.saveAppointmentChange(point, obj, { scheduleAcknowledgement });
      actions.closeEditor();
      state.calendarAnchorDate = actions.parseDate(v.date);
      if (editMode.source === 'card') state.selectedId = point.patientId;
      await actions.setView(editMode.source === 'card' ? 'card' : 'calendar');
      actions.toast('Запись изменена');
      return;
    }
    if (isNewPatient) {
      state.data.push(p);
      state.selectedId = p.id;
    }
    p.appointments = p.appointments || [];
    if (state.editorMode.id) {
      if (old) {
        old.patient.appointments = old.patient.appointments.filter(
          (x) => x.id !== state.editorMode.id,
        );
        p.appointments.push(obj);
      } else p.appointments.push(obj);
    } else p.appointments.push(obj);
    const createdFromServices = state.appointmentFromServices,
      returnToCard = state.editorMode.source === 'card';
    await actions.save({ scheduleAcknowledgement });
    if (createdFromServices) actions.clearServiceSelection();
    actions.closeEditor();
    state.calendarAnchorDate = actions.parseDate(v.date);
    if (returnToCard) state.selectedId = p.id;
    actions.setView(returnToCard ? 'card' : 'calendar');
    actions.toast(wasEditing ? 'Запись изменена' : 'Запись добавлена');
    if (isNewPatient) void actions.prepareTelegramInvitation(p.id, { quiet: true });
    return;
  }
  return { saveAppointmentForm };
}
