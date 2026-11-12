function bindEvents(state, actions) {
  actions.bindPatientViewEvents();
  const logoutScopeMatches = (intent) =>
    intent.accountId === (state.account?.id || '') &&
    intent.organizationId === (state.account?.organizationId || '');
  actions.bindDialogInteractionEvents();
  actions.bindTimePickerEvents();
  actions.bindManagementEvents();
  actions.bindBookingHealthEvents();
  actions.bindClientContactEvents();
  actions.bindPatientPhoneEvents();
  actions.bindWorkScheduleEvents();
  actions.bindWorkScheduleEditorEvents();
  actions.bindSaveRecoveryEvents();
  actions.bindBackgroundEvents();
  actions.bindAssistantLifecycle();
  actions.bindVideoConsentEvents();
  actions.bindPatientMarkEvents();
  actions.bindServiceGroupEvents();
  actions.bindTelegramSharingEvents();
  actions.bindManualConfirmationEvents();
  actions.bindTelegramEvents();
  actions.bindMaxClientEvents();
  actions.bindMaxInvitationEvents();
  actions.bindSettingsHelpEvents();
  actions.bindAppointmentPatientPickerEvents();
  actions.bindAppointmentWorkflowEvents();
  actions.bindCalendarCreationTabEvents();
  actions.bindPersonalEventEvents();
  actions.bindAppointmentActionEvents();
  actions.bindNotificationHistoryEvents();
  actions.bindAppointmentOutcomeEvents();
  actions.bindVisitProcedureEvents();
  actions.bindAppointmentProcedureEvents();
  actions.bindRoomEvents();
  actions.bindServiceEvents();
  document.addEventListener('click', async (e) => {
    if (state.busy) return;
    let logoutIntent = null;
    try {
      if (actions.handleCalendarLoadNavigation(e.target)) return;
      if (e.target.closest('#print-patient')) {
        e.target.closest('.patient-more')?.removeAttribute('open');
        await actions.printPatient();
        return;
      }
      if (e.target.closest('#logout-account')) {
        logoutIntent = {
          accountId: state.account?.id || '',
          organizationId: state.account?.organizationId || '',
        };
        if (
          !(await actions.confirmSettingsLeave()) ||
          state.busy ||
          !logoutScopeMatches(logoutIntent)
        )
          return;
        actions.resetAssistant();
        await actions.disconnectPushOnLogout?.();
        if (!logoutScopeMatches(logoutIntent)) return;
        await actions.request('/api/auth/logout', { method: 'POST', body: '{}' });
        if (!logoutScopeMatches(logoutIntent)) return;
        if (logoutIntent.accountId) {
          try {
            localStorage.setItem(
              'cartoteca-logout-v2',
              JSON.stringify({ ...logoutIntent, at: Date.now() }),
            );
          } catch {
            // The server revoked this session; unavailable storage must not block leaving it.
          }
        }
        location.replace('/');
        return;
      }
      if (e.target.closest('#migrate-legacy')) {
        state.busy = true;
        await actions.migrateLegacy();
        actions.setView('settings');
        return;
      }
      if (e.target.closest('[data-toggle-month]')) {
        state.monthPickerOpen = !state.monthPickerOpen;
        actions.setView('calendar');
        return;
      }
      const overviewDate = e.target.closest('[data-overview-date]');
      if (overviewDate) {
        state.calendarAnchorDate = actions.parseDate(overviewDate.dataset.overviewDate);
        state.calendarMode = 'day';
        state.monthPickerOpen = false;
        actions.setView('calendar');
        return;
      }
      const calendarDate = e.target.closest('[data-calendar-date]');
      if (calendarDate) {
        state.calendarAnchorDate = actions.parseDate(calendarDate.dataset.calendarDate);
        state.monthPickerOpen = false;
        actions.setView('calendar');
        return;
      }
      if (e.target.closest('[data-toggle-early-hours]')) {
        state.showEarlyHours = !state.showEarlyHours;
        actions.setView('calendar');
        return;
      }
      if (e.target.closest('[data-calendar-today]')) {
        state.calendarAnchorDate = actions.cabinetTodayDate();
        actions.setCalendarMode('day');
        state.monthPickerOpen = false;
        actions.setView('calendar');
        return;
      }
      if (e.target.closest('[data-month-prev]')) {
        state.calendarAnchorDate = new Date(
          state.calendarAnchorDate.getFullYear(),
          state.calendarAnchorDate.getMonth() - 1,
          1,
        );
        actions.setView('calendar');
        return;
      }
      if (e.target.closest('[data-month-next]')) {
        state.calendarAnchorDate = new Date(
          state.calendarAnchorDate.getFullYear(),
          state.calendarAnchorDate.getMonth() + 1,
          1,
        );
        actions.setView('calendar');
        return;
      }
      if (e.target.closest('[data-calendar-prev]')) {
        const step = ['week', 'load'].includes(state.calendarMode) ? 7 : 1;
        state.calendarAnchorDate = new Date(state.calendarAnchorDate);
        state.calendarAnchorDate.setDate(state.calendarAnchorDate.getDate() - step);
        actions.setView('calendar');
        return;
      }
      if (e.target.closest('[data-calendar-next]')) {
        const step = ['week', 'load'].includes(state.calendarMode) ? 7 : 1;
        state.calendarAnchorDate = new Date(state.calendarAnchorDate);
        state.calendarAnchorDate.setDate(state.calendarAnchorDate.getDate() + step);
        actions.setView('calendar');
        return;
      }
      const mode = e.target.closest('[data-calendar-mode]');
      if (mode) {
        actions.setCalendarMode(mode.dataset.calendarMode);
        actions.setView('calendar');
        return;
      }
      if (actions.handleCalendarLoadClick(e.target)) return;
      const personal = e.target.closest('[data-personal-event-id]');
      if (personal) {
        const found = state.personalEvents.find(
          (event) => event.id === personal.dataset.personalEventId,
        );
        if (found) return actions.openPersonalEventForm(found);
        return;
      }
      const appointment = e.target.closest('[data-appointment-id]');
      if (appointment) {
        const found = (
          state.lazyReads
            ? state.calendarRecords
            : state.data.flatMap((p) =>
                (p.appointments || []).map((a) => ({ ...a, patientId: p.id })),
              )
        ).find((a) => a.id === appointment.dataset.appointmentId);
        if (found) return actions.openAppointmentActions(found);
      }
      const slot = e.target.closest('[data-slot-date]');
      if (slot) return actions.openAppointmentForm(actions.calendarNewAppointment(slot, e));
      const nav = e.target.closest('[data-view]');
      if (nav) {
        actions.setView(nav.dataset.view);
        return;
      }
      const p = e.target.closest('[data-patient]');
      if (p) {
        state.selectedId = p.dataset.patient;
        state.activeTab = 'visits';
        actions.$('#search').value = '';
        actions.setView('card');
        return;
      }
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        state.activeTab = tab.dataset.tab;
        actions.renderDetail();
        return;
      }
      if (e.target.closest('#more-visits')) return await actions.showMoreVisits();
      if (e.target.closest('#more-patient-appointments'))
        return await actions.showMorePatientAppointments();
      if (e.target.closest('#calendar-new'))
        return actions.openAppointmentForm(actions.calendarNewAppointment());
      if (e.target.closest('#add-patient')) return actions.openPatientForm();
      if (e.target.closest('#new-service')) return actions.openServiceForm();
      const editService = e.target.closest('[data-edit-service]');
      if (editService)
        return actions.openServiceForm(
          state.services.find((s) => s.id === editService.dataset.editService),
        );
      const deleteService = e.target.closest('[data-delete-service]');
      if (deleteService) {
        const service = state.services.find((s) => s.id === deleteService.dataset.deleteService);
        if (service && window.confirm(`Удалить услугу «${service.name}»?`)) {
          state.busy = true;
          state.services = state.services.filter((s) => s.id !== service.id);
          await actions.saveServices();
          actions.setView(state.currentView);
          actions.toast('Услуга удалена');
        }
        return;
      }
      if (e.target.closest('#new-visit') || e.target.closest('#empty-new'))
        return actions.openVisitForm();
      if (e.target.closest('#edit-patient') || e.target.closest('#edit-profile'))
        return actions.openPatientForm(actions.patient());
      const ev = e.target.closest('[data-edit-visit]');
      if (ev)
        return actions.openVisitForm(
          actions.patient().visits.find((v) => v.id === ev.dataset.editVisit),
        );
      const ph = e.target.closest('[data-photo]');
      if (ph) return actions.showPhoto(ph);
      if (e.target.closest('#back')) {
        state.selectedId = null;
        actions.renderList();
        actions.renderDetail();
      }
      if (e.target.closest('#close-editor') || e.target.closest('#cancel-editor'))
        await actions.requestEditorClose();
      if (e.target.closest('#close-photo')) actions.$('#photo-view').close();
      const rm = e.target.closest('[data-remove-photo]');
      if (rm) {
        const index = Number(rm.dataset.removePhoto);
        if (!state.editorMode?.appendOnly || index >= state.editorMode.savedPhotoCount) {
          state.uploadItems.splice(index, 1);
          actions.renderUploads();
        }
      }
    } catch (error) {
      if (logoutIntent && !logoutScopeMatches(logoutIntent)) return;
      actions.rollback();
      actions.toast(error.message);
    } finally {
      if (!logoutIntent || logoutScopeMatches(logoutIntent)) state.busy = false;
    }
  });
  actions.$('#search').addEventListener('input', actions.renderList);
  actions.$('#editor-form').addEventListener('submit', actions.submit);
  actions.$('#form-content').addEventListener('change', (e) => {
    if (e.target.id === 'photo-input') actions.processFiles(e.target.files);
    if (e.target.matches('[data-photo-caption], #photo-batch-caption'))
      actions.changePhotoCaption(e.target);
    if (e.target.id === 'appointment-patient') {
      document.querySelectorAll('.appointment-new-field').forEach((field) => {
        field.hidden = e.target.value !== '__new__';
      });
    }
  });
  actions.$('#client-filters').addEventListener('click', (e) => {
    const button = e.target.closest('[data-client-filter]');
    if (!button) return;
    state.clientFilter = button.dataset.clientFilter;
    actions.renderList();
  });
  document.querySelector('.name-sort').addEventListener('click', (e) => {
    const button = e.target.closest('[data-patient-sort]');
    if (!button) return;
    state.patientSort = button.dataset.patientSort;
    actions.renderList();
  });
  actions.bindEditorCloseEvents();
  actions.bindSettingsGuardEvents();
  actions.bindPhoneLandscapeEvents();
  state.mobileScreen?.addEventListener('change', (e) => {
    if (actions.preservePhoneCalendarOnResize()) return;
    if (state.calendarMode !== 'load') state.calendarMode = e.matches ? 'day' : 'week';
    if (state.currentView === 'calendar') actions.setView('calendar', { redraw: true });
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      document.body.classList.add('app-loading');
      location.reload();
    }
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== 'cartoteca-logout-v2') return;
    let marker;
    try {
      marker = JSON.parse(e.newValue);
    } catch {
      return;
    }
    if (
      !marker ||
      typeof marker.accountId !== 'string' ||
      !marker.accountId ||
      typeof marker.organizationId !== 'string' ||
      typeof marker.at !== 'number' ||
      !Number.isFinite(marker.at) ||
      marker.at <= 0 ||
      !logoutScopeMatches(marker)
    )
      return;
    actions.resetAssistant();
    location.replace('/');
  });
  window.addEventListener('beforeprint', () => {
    if (!actions.printablePatient()) actions.invalidatePrint();
  });
}
