function createNavigation(state, actions) {
  let sequence = 0;
  let deferredCalendar = null;
  const scope = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  function flushCalendarRedraw({ presentationOnly = false } = {}) {
    if (document.visibilityState === 'hidden') return;
    const deferred = deferredCalendar;
    deferredCalendar = null;
    if (
      !deferred ||
      state.sessionReady === false ||
      deferred.account !== state.account ||
      deferred.scope !== scope() ||
      state.currentView !== 'calendar'
    )
      return;
    return setView('calendar', { redraw: true, presentationOnly });
  }
  async function setView(view, { redraw = false, presentationOnly = false } = {}) {
    presentationOnly = presentationOnly && redraw && view === 'calendar';
    if (redraw && view !== state.currentView) return;
    if (redraw && view === 'calendar' && document.visibilityState === 'hidden') {
      deferredCalendar = {
        account: state.account,
        scope: scope(),
      };
      return;
    }
    if (!redraw && state.currentView === 'settings') {
      const account = state.account;
      if (!(await actions.confirmSettingsLeave()) || state.account !== account || state.busy)
        return;
    }
    const requestId = redraw ? sequence : ++sequence;
    if (view === 'settings' && state.settingsReady === false) {
      const account = state.account;
      const status = actions.$('#load-status');
      status.hidden = false;
      status.textContent = 'Загружаем настройки…';
      try {
        await actions.ensureSettings();
      } catch (error) {
        if (requestId === sequence)
          status.textContent =
            error.message + (error.reloadRequired ? '' : ' Нажмите «Настройки», чтобы повторить.');
        return;
      }
      if (requestId !== sequence || state.account !== account) return;
      status.hidden = true;
    } else if (state.sessionReady && !redraw) actions.$('#load-status').hidden = true;
    if (view !== 'services' || !actions.canEditServices())
      actions.configureServiceView({ editing: false });
    state.currentView = view;
    if (view !== 'calendar') deferredCalendar = null;
    if (view !== 'calendar') actions.mountAssistant?.();
    actions.renderBookingInbox();
    if (!presentationOnly) void actions.refreshBookingInbox();
    actions.renderBookingHealth();
    if (!presentationOnly) void actions.refreshBookingHealth();
    actions.invalidatePrint();
    document.body.classList.toggle('calendar-screen', view === 'calendar');
    document.body.classList.toggle('settings-screen', view === 'settings' && state.multiUser);
    actions.$('.app-nav')?.classList.toggle('app-nav-designed', Boolean(state.multiUser));
    document.querySelectorAll('.app-nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const global = actions.$('#global-view'),
      workspace = actions.$('#workspace'),
      search = actions.$('#search');
    workspace.classList.remove('clients-mode', 'card-mode');
    workspace.classList.toggle('workspace-designed', state.multiUser);
    if (view === 'clients') workspace.classList.add('clients-mode');
    if (view === 'card') workspace.classList.add('card-mode');
    search.placeholder =
      view === 'card' ? 'Найти карточку по имени или телефону' : 'Имя или телефон';
    if (view === 'clients') {
      actions.$('#workspace').classList.remove('global-mode');
      global.hidden = true;
      document.body.classList.remove('has-patient');
      actions.renderList({ immediate: !redraw });
      actions.renderDetail();
      document.body.classList.remove('has-patient');
      return;
    }
    if (view === 'card') {
      if (!state.selectedId) state.selectedId = actions.clientRecords()[0]?.id || null;
      if (
        state.selectedId &&
        state.lazyReads &&
        !state.data.some((p) => p.id === state.selectedId)
      ) {
        actions.$('#workspace').classList.remove('global-mode');
        global.hidden = true;
        actions.$('#detail').innerHTML =
          '<div class="empty" role="status">Загрузка карточки…</div>';
        try {
          await actions.ensurePatientView(state.selectedId);
        } catch (error) {
          if (requestId === sequence) actions.$('#detail').textContent = error.message;
          return;
        }
        if (requestId !== sequence) return;
      }
      actions.$('#workspace').classList.remove('global-mode');
      global.hidden = true;
      actions.renderList({ immediate: !redraw });
      actions.renderDetail();
      return;
    }
    actions.$('#workspace').classList.add('global-mode');
    global.hidden = false;
    global.innerHTML =
      view === 'services'
        ? actions.managementHtml()
        : view === 'settings'
          ? actions.settingsHtml()
          : actions.calendarHtml();
    if (view === 'services') actions.mountManagement();
    if (view === 'calendar') {
      deferredCalendar = null;
      actions.positionCalendarEvents();
      actions.updateCurrentTime();
      if (!presentationOnly) actions.mountAssistant?.();
      const strip = actions.$('.mobile-date-strip');
      const selected = strip?.querySelector('[aria-pressed="true"]');
      if (selected)
        strip.scrollLeft = selected.offsetLeft - strip.clientWidth / 2 + selected.clientWidth / 2;
      if (!presentationOnly) {
        void actions.loadRoomAvailability();
        void actions.loadCalendarRecords();
        void actions.loadCalendarSchedule();
      }
    }
    if (view === 'settings') {
      actions.mountSettingsPages();
      actions.renderBookingHealth();
      void actions.checkAppVersion();
      if (state.multiUser) {
        actions.loadAccountProfile();
        void actions.mountIntegrations();
        void actions.loadEarlyAccess();
        actions.loadTeamAccess();
        actions.loadTelegramSettings();
        actions.loadWorkspace({ render: true });
        void actions.loadOnlineBookingSettings();
      } else window.CartotecaSecurity?.mount(document.querySelector('#security-settings'));
    }
  }
  return { setView, flushCalendarRedraw };
}
