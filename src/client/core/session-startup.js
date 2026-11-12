function createSessionStartup(state, actions) {
  let active = null,
    generation = 0,
    departed = false,
    resumeRequested = false,
    terminal = false,
    migrationAttempted = false;
  const current = (value) => value === generation && !departed;
  function showStatus(message, retry = false) {
    const status = actions.$('#load-status');
    if (!status) return;
    status.hidden = false;
    status.setAttribute?.('role', 'status');
    status.setAttribute?.('aria-live', 'polite');
    status.textContent = message + (retry ? ' Повторите загрузку.' : '');
    if (retry && typeof document.createElement === 'function' && status.append) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = 'Повторить';
      button.addEventListener('click', () => {
        void initialize();
      });
      status.append(' ', button);
    }
  }
  function initialize() {
    if (active) return active;
    if (terminal || departed || state.sessionReady) return Promise.resolve();
    const attempt = ++generation;
    const task = runStartup(attempt);
    active = task;
    task.finally(() => {
      if (active === task) active = null;
      if (resumeRequested && !departed && !state.sessionReady) {
        resumeRequested = false;
        void initialize();
      }
    });
    return task;
  }
  function resume() {
    departed = false;
    if (terminal || state.sessionReady || (typeof document !== 'undefined' && document.hidden))
      return;
    if (active) resumeRequested = true;
    else void initialize();
  }
  if (typeof window !== 'undefined') {
    window.addEventListener?.('pagehide', () => {
      departed = true;
      resumeRequested = false;
      generation++;
      if (!state.sessionReady) state.startupStatus = 'interrupted';
    });
    window.addEventListener?.('pageshow', (event) => {
      // Initial navigation also emits pageshow while the first attempt is active.
      // It must not silently queue a second full deadline after that attempt fails.
      if (departed || event.persisted || (!active && state.startupStatus === 'error')) resume();
    });
    window.addEventListener?.('online', resume);
    window.addEventListener?.('focus', resume);
  }
  if (typeof document !== 'undefined')
    document.addEventListener?.('visibilitychange', () => {
      if (!document.hidden) resume();
    });
  async function runStartup(generation) {
    state.sessionReady = false;
    state.startupStatus = 'loading';
    showStatus('Загружаем картотеку…');
    actions.resetAssistant?.();
    if (new URLSearchParams(location.hash.slice(1)).has('invite')) {
      location.replace('/login.html' + location.hash);
      return;
    }
    try {
      const session = await actions.request('/api/auth/session');
      if (!current(generation)) return;
      if (!session.user) {
        location.replace('/' + (location.hash.startsWith('#staff-push=') ? location.hash : ''));
        return;
      }
      if (session.user.globalAdmin) {
        location.replace('/admin.html');
        return;
      }
      if (session.multiUser && !session.user.organizationId) {
        location.replace(
          '/login.html' + (location.hash.startsWith('#staff-push=') ? location.hash : ''),
        );
        return;
      }
      state.account = session.user;
      state.personalEvents = [];
      state.personalRevision = 0;
      state.calendarPersonalOverview = null;
      state.multiUser = Boolean(session.multiUser);
      state.lazyReads = Boolean(session.lazyReads);
      actions.applyAssistantScope?.(session.assistant);
      // These reads depend on the authenticated account, not on each other.
      // Apply their results before the first calendar render.
      const [cabinet] = await Promise.all([
        actions.request(
          state.lazyReads ? '/api/cabinet/bootstrap?paged=1&limit=20' : '/api/cabinet',
        ),
        actions.loadWorkspace({ required: true }),
      ]);
      if (!current(generation)) return;
      if (state.multiUser)
        actions.applyCabinetTimeZone(cabinet.timeZone || 'Europe/Moscow', {
          initial: true,
        });
      if (state.multiUser)
        actions.applyServiceGroups(
          cabinet.serviceGroups || {
            revision: 0,
            groups: [{ id: 'other', title: 'Другое' }],
          },
        );
      state.data = cabinet.patients;
      state.personalEvents = cabinet.personalEvents || [];
      state.personalRevision = cabinet.personalRevision || 0;
      state.serviceCatalogOwnerId = cabinet.serviceCatalog?.ownerId || '';
      state.directory = cabinet.directory || [];
      state.pagedReads = Boolean(cabinet.pagedReads);
      actions.initializeDirectory(cabinet);
      state.services = cabinet.initialized
        ? cabinet.services
        : structuredClone(
            state.serviceSeed.map((s) => (state.multiUser ? { ...s, category: 'other' } : s)),
          );
      state.revision = cabinet.revision;
      actions.rememberCabinet(cabinet);
      if (!cabinet.initialized && !migrationAttempted) {
        try {
          if (actions.legacyData()) {
            migrationAttempted = true;
            await actions.migrateLegacy();
          }
        } catch (error) {
          if (!current(generation)) return;
          actions.rollback();
          window.alert(error.message);
        }
      }
      if (!current(generation)) return;
      await actions.loadCalendarRecords({ required: true, force: true });
      if (!current(generation)) return;
      await actions.setView('calendar');
      if (!current(generation)) return;
      actions.$('#load-status').hidden = true;
      document.body.classList.remove('app-loading');
      state.sessionReady = true;
      state.startupStatus = 'ready';
      const account = state.account;
      if (state.multiUser && actions.canManageTeam())
        void actions
          .request('/api/organization/access', { priority: 'background' })
          .then((access) => {
            if (current(generation) && state.account === account) state.teamAccess = access;
          })
          .catch(() => {});
      actions.openSaveRecovery?.();
      actions.scheduleSettingsLoad();
      actions.scheduleAssistantLoad?.();
      await actions.openStaffPushTarget?.();
      const checkoutId =
        new URLSearchParams(location.search).get('payment') ||
        new URLSearchParams(location.search).get('checkoutId');
      if (
        state.multiUser &&
        state.account?.role === 'owner' &&
        typeof checkoutId === 'string' &&
        /^[a-f0-9-]{36}$/i.test(checkoutId) &&
        !location.hash.startsWith('#staff-push=')
      ) {
        const owner = state.account;
        await actions.setView('settings');
        if (state.account === owner && state.currentView === 'settings') {
          const page = actions.$('#paid-services-settings')?.closest('details.settings-tile');
          if (page) page.open = true;
        }
      }
    } catch (error) {
      if (!current(generation)) return;
      if (state.sessionReady) {
        actions.toast(error.message);
        return;
      }
      actions.cancelReadTasks?.();
      terminal = [401, 428].includes(error.status);
      state.startupStatus = terminal ? 'redirecting' : 'error';
      showStatus(error.message, !terminal);
    }
  }
  return { initialize };
}
