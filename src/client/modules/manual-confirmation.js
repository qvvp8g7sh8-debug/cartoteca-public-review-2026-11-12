function createManualConfirmation(state, actions) {
  function appointmentConfirmationStatus(a) {
    if (!actions.isActiveAppointment(a)) return actions.appointmentStatusLabel(a);
    return a.confirmedAt || a.telegramConfirmedAt || a.notificationConfirmedAt
      ? '✓ Подтверждена клиентом'
      : a.manualConfirmedAt
        ? '✓ Подтверждена вручную'
        : '';
  }
  function appointmentConfirmationControls(a, patientId, { allowUndo = false } = {}) {
    if (
      !state.multiUser ||
      !a.confirmationKey ||
      !actions.isActiveAppointment(a) ||
      !actions.canEditRecord(a) ||
      a.upcoming === false ||
      a.date < actions.cabinetToday()
    )
      return '';
    if (a.confirmedAt || a.telegramConfirmedAt || a.notificationConfirmedAt) return '';
    const undo = Boolean(a.manualConfirmedAt);
    if (undo && !allowUndo) return '';
    return (
      '<button type="button" class="' +
      (undo ? 'secondary' : 'primary') +
      '" data-manual-confirm="' +
      actions.esc(a.appointmentId || a.id) +
      '" data-confirm-patient="' +
      actions.esc(patientId) +
      '" data-confirm-key="' +
      actions.esc(a.confirmationKey) +
      '" data-confirm-value="' +
      !undo +
      '">' +
      (undo ? 'Снять ручное подтверждение' : 'Подтвердить вручную') +
      '</button>'
    );
  }
  const formFields = ['patientId', 'date', 'time', 'duration', 'staffId', 'roomId', 'service'];
  function formSnapshot(form) {
    return JSON.stringify(formFields.map((name) => form.elements.namedItem(name)?.value || ''));
  }
  function mountAppointmentConfirmation(a, patientId) {
    const content = actions.$('#form-content');
    if (!content || !state.multiUser || !a?.id) return;
    const box = document.createElement('div');
    box.className = 'appointment-confirmation-controls';
    box.dataset.formSnapshot = formSnapshot(content.closest('form'));
    box.setAttribute('aria-live', 'polite');
    box.innerHTML =
      (actions.appointmentConfirmationStatus(a)
        ? '<p class="form-hint">' +
          actions.esc(actions.appointmentConfirmationStatus(a)) +
          (a.manualConfirmedAt &&
          !a.telegramConfirmedAt &&
          !a.notificationConfirmedAt &&
          a.manualConfirmedBy
            ? ' · ' + actions.esc(a.manualConfirmedBy)
            : '') +
          '</p>'
        : '') + actions.appointmentConfirmationControls(a, patientId, { allowUndo: true });
    content.querySelector('.appointment-workflow-actions')?.before(box);
  }
  function bindManualConfirmationEvents() {
    document.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-manual-confirm]');
      if (!button) return;
      e.stopImmediatePropagation();
      if (state.busy || button.disabled) return;
      const box = button.closest('.appointment-confirmation-controls'),
        form = box?.closest('form');
      if (form && box.dataset.formSnapshot !== formSnapshot(form)) {
        actions.toast('Сначала сохраните изменения записи, затем подтвердите её');
        return;
      }
      const confirmed = button.dataset.confirmValue === 'true';
      const patientId = button.dataset.confirmPatient,
        id = button.dataset.manualConfirm,
        editorMode = state.editorMode,
        key = [state.account?.id, state.account?.organizationId].join(':');
      const patient =
          (editorMode?.kind === 'appointmentActions' && editorMode.patientId === patientId
            ? editorMode.inspectorPatient
            : null) || state.data.find((p) => p.id === patientId),
        appointment = patient?.appointments.find((a) => a.id === id);
      if (
        !(await actions.confirmAction(
          confirmed ? 'Подтвердить запись вручную?' : 'Снять ручное подтверждение?',
          `${patient?.name || 'Клиент'}${appointment ? ' · ' + actions.formatDate(appointment.date) + ' · ' + appointment.time : ''}\n` +
            (confirmed
              ? 'Клиент подтвердил запись лично или по телефону? Отметить её подтверждённой вручную?'
              : 'Запись снова будет ожидать подтверждения.'),
          confirmed ? 'Подтвердить вручную' : 'Снять подтверждение',
        ))
      )
        return;
      if (
        state.busy ||
        !button.isConnected ||
        (button.closest('#editor') &&
          (!actions.$('#editor').open || state.editorMode !== editorMode)) ||
        key !== [state.account?.id, state.account?.organizationId].join(':') ||
        (form && box.dataset.formSnapshot !== formSnapshot(form))
      )
        return;
      state.busy = true;
      button.disabled = true;
      try {
        const receipt = await actions.request('/api/appointments/confirmation', {
          method: 'POST',
          body: JSON.stringify({
            patientId,
            appointmentId: id,
            confirmed,
            expectedFingerprint: button.dataset.confirmKey,
          }),
        });
        if (key !== [state.account?.id, state.account?.organizationId].join(':')) return;
        const { appointmentId, ...fields } = receipt;
        for (const p of state.data)
          if (p.id === patientId)
            for (const a of p.appointments || []) if (a.id === id) Object.assign(a, fields);
        if (state.editorMode === editorMode && editorMode?.inspectorPatient?.id === patientId)
          for (const a of editorMode.inspectorPatient.appointments)
            if (a.id === id) Object.assign(a, fields);
        for (const a of state.calendarRecords || [])
          if (a.id === id && a.patientId === patientId) Object.assign(a, fields);
        actions.invalidateCalendarRead();
        if (state.currentView === 'card' && state.selectedId === patientId)
          await actions.loadPatientTelegram(patientId);
        if (state.editorMode?.kind === 'appointmentActions' && state.editorMode === editorMode) {
          if (state.currentView === 'calendar') actions.setView('calendar');
          actions.refreshAppointmentActions();
        } else if (form?.isConnected) {
          const a = state.data
            .find((p) => p.id === patientId)
            ?.appointments.find((a) => a.id === id);
          box.remove();
          if (a) actions.mountAppointmentConfirmation(a, patientId);
        } else if (state.currentView === 'calendar') actions.setView('calendar');
        actions.toast(confirmed ? 'Запись подтверждена вручную' : 'Ручное подтверждение снято');
      } catch (error) {
        actions.toast(error.message);
        if (state.currentView === 'card' && state.selectedId === patientId)
          await actions.loadPatientTelegram(patientId);
      } finally {
        state.busy = false;
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  return {
    appointmentConfirmationStatus,
    appointmentConfirmationControls,
    mountAppointmentConfirmation,
    bindManualConfirmationEvents,
  };
}
