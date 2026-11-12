function createAppointmentOutcomes(state, actions) {
  function canMarkNoShow(a) {
    const now = actions.cabinetClock();
    return (
      actions.isActiveAppointment(a) &&
      a.date + ' ' + a.time <= now.date + ' ' + actions.timeLabel(now.hour * 60 + now.minute)
    );
  }
  function appointmentOutcomeControls(a, patientId) {
    if (!state.multiUser || !a?.id || !actions.isActiveAppointment(a) || !actions.canEditRecord(a))
      return '';
    const button = (status, label) =>
      '<button type="button" class="text-btn" data-appointment-outcome="' +
      status +
      '" data-outcome-id="' +
      actions.esc(a.id) +
      '" data-outcome-patient="' +
      actions.esc(patientId) +
      '" data-outcome-key="' +
      actions.esc(a.confirmationKey || '') +
      '">' +
      label +
      '</button>';
    return (
      '<div class="appointment-outcome-actions">' +
      (canMarkNoShow(a) ? button('no_show', 'Не пришёл') : '') +
      button('cancelled', 'Отменить запись') +
      '</div>'
    );
  }
  function openAppointmentOutcome(a, patient) {
    state.editorMode = { kind: 'appointmentOutcome', id: a.id, patientId: patient.id };
    actions.$('#dialog-title').textContent = actions.appointmentStatusLabel(a);
    actions.$('#form-content').innerHTML =
      '<p><strong>' +
      actions.esc(actions.formatDate(a.date) + ' · ' + a.time) +
      '</strong></p><p>' +
      actions.esc(a.service || 'Запись') +
      ' · ' +
      actions.formatMinutes(a.duration || 60) +
      '</p><p class="form-hint">Посещение не оформлено. Время свободно для новой записи.</p>' +
      (a.notes ? '<p>' + actions.esc(a.notes) + '</p>' : '') +
      (actions.canEditRecord(a)
        ? '<button type="button" class="secondary" data-book-again="' +
          actions.esc(patient.id) +
          '">Записать снова</button>'
        : '');
    actions.openDialog();
  }
  function bindAppointmentOutcomeEvents() {
    document.addEventListener('click', async (e) => {
      const repeat = e.target.closest('[data-book-again]'),
        button = e.target.closest('[data-appointment-outcome]');
      if ((!repeat && !button) || state.busy) return;
      e.stopImmediatePropagation();
      if (repeat) {
        const p = state.data.find((p) => p.id === repeat.dataset.bookAgain);
        actions.closeEditor();
        if (p)
          actions.openAppointmentForm({ patientId: p.id, date: actions.cabinetToday() }, 'card');
        return;
      }
      const status = button.dataset.appointmentOutcome,
        patientId = button.dataset.outcomePatient,
        id = button.dataset.outcomeId;
      if (!['cancelled', 'no_show'].includes(status)) return;
      const warning =
        actions.$('#editor').open && state.editorMode?.kind === 'appointment'
          ? ' Несохранённые изменения формы не будут применены.'
          : '';
      const account = state.account?.id,
        editorMode = state.editorMode,
        organization = state.account?.organizationId;
      const patient = state.data.find((p) => p.id === patientId),
        appointment = patient?.appointments.find((a) => a.id === id);
      if (
        !(await actions.confirmAction(
          status === 'no_show' ? 'Клиент не пришёл?' : 'Отменить запись?',
          `${patient?.name || 'Клиент'}${appointment ? ' · ' + actions.formatDate(appointment.date) + ' · ' + appointment.time : ''}\n` +
            (status === 'no_show'
              ? 'Отметить, что клиент не пришёл? Запись исчезнет из календаря, посещение создано не будет.'
              : 'Отменить запись? Она исчезнет из активных записей и календаря, но сохранится в истории клиента. Время освободится, напоминания прекратятся.') +
            warning,
          status === 'no_show' ? 'Отметить неявку' : 'Отменить запись',
          'Оставить запись',
        ))
      )
        return;
      if (
        state.busy ||
        !button.isConnected ||
        (button.closest('#editor') &&
          (!actions.$('#editor').open || state.editorMode !== editorMode)) ||
        state.account?.id !== account ||
        state.account?.organizationId !== organization
      )
        return;
      state.busy = true;
      button.disabled = true;
      try {
        // Keep the edited schedule intact: status applies only to the saved appointment.
        await actions.ensurePatient(patientId, { force: true });
        if (state.account?.id !== account || state.account?.organizationId !== organization) return;
        const p = state.data.find((p) => p.id === patientId),
          a = p?.appointments.find((a) => a.id === id);
        if (!a || !actions.isActiveAppointment(a))
          throw new Error('Запись уже изменена. Обновите календарь.');
        if (button.dataset.outcomeKey && button.dataset.outcomeKey !== a.confirmationKey)
          throw new Error('Параметры записи изменились. Откройте её заново.');
        if (!actions.canEditRecord(a)) throw new Error('Недостаточно прав для этой записи.');
        if (status === 'no_show' && !canMarkNoShow(a))
          throw new Error('Отметить неявку можно после времени начала записи.');
        a.status = status;
        await actions.save();
        actions.closeEditor();
        actions.setView(state.currentView);
        actions.toast(actions.appointmentStatusLabel(a));
      } catch (error) {
        actions.rollback();
        actions.toast(error.message);
      } finally {
        state.busy = false;
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  return {
    canMarkNoShow,
    appointmentOutcomeControls,
    openAppointmentOutcome,
    bindAppointmentOutcomeEvents,
  };
}
