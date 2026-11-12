function createAssistantCommands(state, actions) {
  const accountContext = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  function assistantActionCaption(action) {
    if (action?.type === 'createAppointment') return 'Повторить сохранение';
    if (action?.type === 'cancelAppointment') return 'Проверить отмену';
    if (action?.type === 'moveAppointment') return 'Проверить перенос';
    if (action?.type === 'appointmentPreview') return 'Проверить выбранную запись';
    if (action?.type === 'calendar') return 'Показать в календаре';
    if (action?.type === 'clients') return 'Открыть список клиентов';
    if (action?.type === 'clientCard') return 'Открыть карточку клиента';
    if (action?.type === 'prepareAppointment') return 'Проверить запись в форме';
    return '';
  }
  function assistantDraftText(action) {
    if (!action || action.type !== 'prepareAppointment') return '';
    const patient = actions.clientRecords().find((item) => item.id === action.patientId);
    const services = actions
      .servicesForStaff(action.staffId || actions.accountId())
      .filter((item) => Array.isArray(action.serviceIds) && action.serviceIds.includes(item.id));
    return [
      'Черновик записи',
      patient?.name || (action.patientId ? 'Выбранный клиент' : 'Клиент не выбран'),
      action.date ? actions.formatDate(action.date) : 'Дата не указана',
      action.time || 'Время не указано',
      action.duration ? action.duration + ' мин' : '',
      services.map((item) => item.name).join(', '),
      'Проверьте данные и сохраните запись.',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  async function runAssistantAction(action) {
    if (!action || state.busy || state.editorMode) throw Error('Сначала завершите открытую форму.');
    const actionGeneration = state.assistantGeneration,
      actionIdentity = accountContext();
    const currentAction = (view) =>
      actionGeneration === state.assistantGeneration &&
      actionIdentity === accountContext() &&
      state.currentView === view &&
      !state.editorMode;
    if (action.type === 'appointmentPreview') return actions.runAssistantAppointmentPreview(action);
    if (['createAppointment', 'cancelAppointment', 'moveAppointment'].includes(action.type)) {
      const account = state.account,
        policyVersion = state.assistantScope?.policyVersion;
      const currentSave = () =>
        currentAction('calendar') &&
        state.account === account &&
        !document.hidden &&
        state.assistantScope?.enabled === true &&
        state.assistantScope.appointmentSavingEnabled === true &&
        state.assistantScope.policyVersion === policyVersion;
      const saved = await actions.saveAssistantAppointment(action);
      if (saved === false) return false;
      if (!currentSave()) return false;
      if (saved?.saved === false && saved.code === 'ASSISTANT_EXECUTION_REQUIRES_INPUT')
        return saved;
      actions.invalidateCalendarRead();
      try {
        if (saved.action) await runAssistantAction(saved.action);
        else await actions.setView('calendar');
      } catch {
        if (currentSave())
          actions.toast(
            saved.operation === 'cancel'
              ? 'Запись отменена. Обновите календарь.'
              : saved.operation === 'move'
                ? 'Запись перенесена. Обновите календарь.'
                : 'Запись сохранена. Обновите календарь.',
          );
      }
      return currentSave() ? saved : false;
    }
    if (action.type === 'calendar') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(action.date || '')) throw Error('Уточните дату.');
      state.calendarAnchorDate = actions.parseDate(action.date);
      const mode = ['day', 'week', 'month'].includes(action.mode) ? action.mode : 'day';
      if (mode === 'week') state.calendarAnchorDate = actions.weekStart(state.calendarAnchorDate);
      actions.setCalendarMode(mode);
      if (action.staffId) {
        state.calendarGrouping = 'staff';
        state.selectedRoomId = '';
        state.selectedScheduleStaff = action.staffId;
      }
      await actions.setView('calendar');
      return currentAction('calendar');
    }
    if (action.type === 'clientCard') {
      const generation = state.assistantGeneration,
        account = state.account,
        identity = accountContext(),
        view = state.currentView,
        editor = state.editorMode,
        selectedId = state.selectedId;
      const patient = await actions.ensurePatient(action.patientId, { force: true });
      if (
        generation !== state.assistantGeneration ||
        account !== state.account ||
        identity !== accountContext() ||
        view !== state.currentView ||
        editor !== state.editorMode ||
        selectedId !== state.selectedId
      )
        return false;
      if (!patient?.id) throw Error('Карточка клиента недоступна. Повторите поиск.');
      state.selectedId = patient.id;
      state.activeTab = 'visits';
      actions.$('#search').value = '';
      await actions.setView('card');
      return currentAction('card') && state.selectedId === patient.id;
    }
    if (action.type === 'clients') {
      state.clientFilter = 'all';
      actions.$('#search').value = String(action.query || '').slice(0, 200);
      await actions.setView('clients');
      if (!currentAction('clients')) return false;
      actions.renderList();
      return true;
    }
    if (action.type !== 'prepareAppointment') throw Error('Эта команда недоступна.');
    const staffId = action.staffId || actions.accountId();
    const serviceItems = actions
      .servicesForStaff(staffId)
      .filter((item) => Array.isArray(action.serviceIds) && action.serviceIds.includes(item.id))
      .map((item) => actions.serviceSnapshot(item));
    const draft = { patientId: action.patientId || '', staffId, serviceItems };
    if (action.roomId) draft.roomId = action.roomId;
    if (/^\d{4}-\d{2}-\d{2}$/.test(action.date || '')) draft.date = action.date;
    if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(action.time || '')) draft.time = action.time;
    if (
      Number.isInteger(action.duration) &&
      action.duration >= 5 &&
      action.duration <= 1440 &&
      action.duration % 5 === 0
    )
      draft.duration = action.duration;
    const generation = state.assistantGeneration,
      account = state.account,
      identity = accountContext(),
      view = state.currentView;
    await actions.openAppointmentForm(draft, 'assistant');
    if (
      generation !== state.assistantGeneration ||
      account !== state.account ||
      identity !== accountContext() ||
      view !== state.currentView
    ) {
      return false;
    }
    if (
      state.editorMode?.kind !== 'appointment' ||
      state.editorMode.id ||
      state.editorMode.source !== 'assistant'
    )
      return false;
    state.assistantEditor = state.editorMode;
    const form = actions.$('#form-content');
    if (!draft.date) form.querySelector('[name="date"]').value = '';
    if (!draft.time) form.querySelector('[name="time"]').value = '';
    actions.mountAppointmentTimePicker();
    const hint = document.createElement('p');
    hint.className = 'form-hint voice-assistant-draft-hint';
    hint.textContent = 'Проверьте данные и сохраните запись.';
    form.prepend(hint);
    return true;
  }
  return { assistantActionCaption, assistantDraftText, runAssistantAction };
}
