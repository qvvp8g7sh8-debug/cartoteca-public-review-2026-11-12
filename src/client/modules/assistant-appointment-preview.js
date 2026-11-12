function createAssistantAppointmentPreview(state, actions) {
  async function runAssistantAppointmentPreview(action) {
    if (
      !action ||
      action.type !== 'appointmentPreview' ||
      !['move', 'edit', 'cancel'].includes(action.operation) ||
      !action.patientId ||
      !action.appointmentId ||
      typeof action.sourceStamp !== 'string'
    )
      throw Error('Уточните существующую запись.');
    if (state.busy || state.editorMode) throw Error('Сначала завершите открытую форму.');
    if (
      (action.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(action.date)) ||
      (action.time !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(action.time))
    )
      throw Error('Уточните дату и время.');
    const generation = state.assistantGeneration,
      view = state.currentView,
      account = state.account;
    const identity = JSON.stringify([
      state.account?.id,
      state.account?.organizationId,
      state.account?.role,
    ]);
    const current = () =>
      state.account === account &&
      generation === state.assistantGeneration &&
      view === state.currentView &&
      identity ===
        JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
    const loadedSource = () =>
      state.data
        .find((item) => item.id === action.patientId)
        ?.appointments?.find((item) => item.id === action.appointmentId);
    const patient = await actions.ensurePatient(action.patientId, { force: true });
    if (!current() || state.editorMode) return false;
    const saved = patient?.appointments?.find((item) => item.id === action.appointmentId);
    if (
      !saved ||
      !actions.isActiveAppointment(saved) ||
      !actions.canEditRecord(saved) ||
      actions.assistantAppointmentStamp(saved) !== action.sourceStamp
    )
      throw Error('Запись изменилась или недоступна. Повторите команду.');
    if (action.operation === 'cancel') {
      const mode = {
        kind: 'appointmentOutcome',
        id: saved.id,
        patientId: patient.id,
        source: 'assistant',
      };
      state.editorMode = state.assistantEditor = mode;
      actions.$('#dialog-title').textContent = 'Отмена записи — просмотр';
      const name =
        patient.name ||
        [patient.firstName, patient.middleName, patient.lastName].filter(Boolean).join(' ');
      actions.$('#form-content').innerHTML =
        '<section class="appointment-action-summary"><strong>' +
        actions.esc(name) +
        '</strong><span>' +
        actions.esc(actions.formatDate(saved.date) + ' · ' + saved.time) +
        '</span><span>' +
        actions.esc(saved.service || '') +
        '</span></section><p class="form-hint">Тестовый режим. Отмена не выполнена.</p>';
      actions.openDialog();
      return current() && state.editorMode === mode;
    }
    await actions.openAppointmentForm({ ...saved, patientId: patient.id }, 'assistant');
    if (!current()) return false;
    const mode = state.editorMode;
    if (mode?.kind !== 'appointment' || mode.id !== saved.id || mode.source !== 'assistant')
      return false;
    const fresh = loadedSource();
    if (!fresh || actions.assistantAppointmentStamp(fresh) !== action.sourceStamp) {
      if (state.assistantEditor === mode) actions.discardAssistantDraft();
      throw Error('Запись изменилась. Повторите команду.');
    }
    const form = actions.$('#form-content');
    for (const key of ['date', 'time'])
      if (action[key] !== undefined) {
        const field = form.querySelector('[name="' + key + '"]');
        if (!field) throw Error('Не удалось подготовить форму записи.');
        field.value = action[key];
      }
    let edited = false;
    const changed = () => {
      edited = true;
    };
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    try {
      await actions.refreshAppointmentSchedule();
      if (!current() || state.editorMode !== mode || edited) return false;
      await actions.refreshAppointmentRooms();
      if (!current() || state.editorMode !== mode || edited) return false;
      if (action.roomId) {
        const room = form.querySelector('[name="roomId"]');
        if (!room || !Array.from(room.options).some((option) => option.value === action.roomId)) {
          actions.discardAssistantDraft();
          throw Error('Кабинет больше недоступен. Повторите команду.');
        }
        room.value = action.roomId;
      }
      const finalSource = loadedSource();
      if (
        !finalSource ||
        !actions.isActiveAppointment(finalSource) ||
        !actions.canEditRecord(finalSource) ||
        actions.assistantAppointmentStamp(finalSource) !== action.sourceStamp
      ) {
        if (state.assistantEditor === mode) actions.discardAssistantDraft();
        throw Error('Запись изменилась. Повторите команду.');
      }
      actions.mountAppointmentTimePicker();
      const hint = document.createElement('p');
      hint.className = 'form-hint voice-assistant-draft-hint';
      hint.textContent =
        action.operation === 'move'
          ? 'Тестовый просмотр переноса. Изменения не сохранены.'
          : 'Тестовый просмотр изменения записи. Изменения не сохранены.';
      form.prepend(hint);
      return true;
    } finally {
      form.removeEventListener('input', changed);
      form.removeEventListener('change', changed);
    }
  }
  return { runAssistantAppointmentPreview };
}
