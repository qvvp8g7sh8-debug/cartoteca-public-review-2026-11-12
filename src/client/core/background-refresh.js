function createBackgroundRefresh(state, actions) {
  const reads = new Map();
  let timer = null;
  let bound = false;
  let stopped = false;
  let lastResume = -Infinity,
    resumeNeedsProbe = false,
    probeFailures = 0,
    probeAfter = 0;
  const scope = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const calendarReady = () =>
    state.currentView === 'calendar' && !state.busy && !actions.$('#editor')?.open;
  const jobs = [
    {
      id: 'early-access',
      interval: 60000,
      ready: () =>
        state.multiUser &&
        state.settingsReady !== false &&
        state.currentView === 'settings' &&
        !state.busy &&
        actions.earlyAccessVisible(),
      run: () => actions.loadEarlyAccess({ quiet: true }),
    },
    {
      id: 'improvements',
      interval: 60000,
      ready: () => state.settingsReady !== false && !state.busy && actions.improvementsVisible(),
      run: () => actions.loadImprovements({ quiet: true }),
    },
    {
      id: 'booking-health',
      interval: () => actions.bookingHealthInterval(),
      nextAt: () => actions.bookingHealthDeadline(),
      ready: () =>
        state.multiUser && Boolean(state.account?.organizationId) && actions.canManageTeam(),
      run: (force) => actions.refreshBookingHealth({ force }),
    },
    {
      id: 'booking-inbox',
      interval: () => actions.bookingInboxInterval(),
      nextAt: () => actions.bookingInboxDeadline(),
      ready: () => state.multiUser && Boolean(state.account?.organizationId),
      run: (force) => actions.refreshBookingInbox({ force }),
    },
    {
      id: 'team-invitations',
      interval: 15000,
      ready: () =>
        state.settingsReady !== false &&
        state.currentView === 'settings' &&
        !state.busy &&
        actions.$('#team-settings')?.closest?.('details')?.open &&
        state.teamAccess?.invitations?.some((invitation) =>
          ['pending', 'sent'].includes(invitation.status),
        ),
      run: () => actions.refreshTeamInvitations(),
    },
    {
      id: 'work-schedules',
      interval: 30000,
      ready: calendarReady,
      run: () => actions.loadCalendarSchedule({ force: true }),
    },
    { id: 'clock', interval: 30000, ready: () => true, run: () => actions.updateCurrentTime() },
    {
      id: 'zone',
      interval: 60000,
      ready: () => !state.busy,
      run: (force) => actions.refreshCabinetTimeZone({ force }),
    },
    {
      id: 'calendar',
      interval: 15000,
      ready: calendarReady,
      run: () => actions.loadCalendarRecords({ force: true }),
    },
    {
      id: 'rooms',
      interval: 15000,
      ready: () =>
        calendarReady() &&
        (state.workspace.enabled ||
          state.workspace.staffRules?.some((rule) => rule.preventOverlap) ||
          state.workspace.rooms?.some((room) => room.active && room.preventOverlap)),
      run: () => actions.loadRoomAvailability({ force: true }),
    },
    {
      id: 'telegram',
      interval: 4000,
      ready: () => !state.busy,
      run: (force) => actions.syncVisibleTelegram({ force }),
    },
  ];

  // Navigation, forms and polling share one in-flight read for an exact scope/URL.
  function readBackground(url) {
    const key = scope() + '|' + url;
    if (reads.has(key)) return reads.get(key);
    const priority =
      url === '/api/auth/session'
        ? 'user'
        : url.startsWith('/api/cabinet/calendar?')
          ? 'calendar'
          : 'background';
    const task = Promise.resolve().then(() => actions.request(url, { priority }));
    reads.set(key, task);
    task
      .finally(() => {
        if (reads.get(key) === task) reads.delete(key);
      })
      .catch(() => {});
    return task;
  }

  function runJob(job, force) {
    if (job.pending) return job.pending;
    if (!job.ready()) return Promise.resolve();
    const now = Date.now();
    const deadline = job.nextAt
      ? job.nextAt()
      : job.checkedScope === scope()
        ? (job.checkedAt ?? 0) + interval(job)
        : -Infinity;
    if (!force && now < deadline) return Promise.resolve();
    job.checkedAt = now;
    job.checkedScope = scope();
    const task = Promise.resolve()
      .then(() => job.run(force))
      .catch(() => {});
    job.pending = task;
    task.finally(() => {
      if (job.pending === task) job.pending = null;
    });
    return task;
  }

  const interval = (job) => (typeof job.interval === 'function' ? job.interval() : job.interval);

  function schedule() {
    clearTimeout(timer);
    if (stopped || document.hidden) return;
    const now = Date.now();
    const delays = jobs
      .filter((job) => !job.pending && job.ready())
      .map((job) =>
        Math.max(
          250,
          job.nextAt
            ? job.nextAt() - now
            : job.checkedScope === scope()
              ? interval(job) - (now - job.checkedAt)
              : 4000,
        ),
      );
    timer = setTimeout(
      () => {
        void refreshBackground();
      },
      Math.min(4000, ...delays),
    );
  }

  async function refreshBackground({ reason = 'tick' } = {}) {
    if (stopped || document.hidden || !state.account || state.sessionReady === false) {
      schedule();
      return;
    }
    // Reconcile already validated cached presentation without starting reads or mounting voice.
    // A quick visibility return must preserve the live clock even inside the resume coalescer.
    try {
      const presentation = actions.flushCalendarRedraw?.({ presentationOnly: true });
      presentation?.catch?.(() => {});
    } catch {}
    const force = reason === 'resume';
    if (force && Date.now() - lastResume < 500) {
      schedule();
      return;
    }
    if (force) {
      lastResume = Date.now();
      resumeNeedsProbe = true;
    }
    if (resumeNeedsProbe) {
      if (!force && Date.now() < probeAfter) {
        schedule();
        return;
      }
      const account = state.account;
      try {
        const session = await readBackground('/api/auth/session');
        if (stopped || document.hidden || state.account !== account) return;
        if (
          !session.user ||
          session.user.id !== account.id ||
          session.user.organizationId !== account.organizationId ||
          session.user.role !== account.role
        ) {
          actions.resetAssistant?.();
          location.replace('/');
          return;
        }
        actions.applyAssistantScope?.(session.assistant);
        await actions.refreshCabinetTimeZone({
          force: true,
          required: true,
          priority: 'calendar',
          presentationOnly: true,
        });
        if (stopped || document.hidden || state.account !== account) return;
        resumeNeedsProbe = false;
        probeFailures = 0;
        probeAfter = 0;
      } catch {
        probeFailures = Math.min(5, probeFailures + 1);
        probeAfter = Date.now() + Math.min(60000, 1000 * 2 ** probeFailures);
        schedule();
        return;
      }
    }
    const flushed = [];
    for (const flush of [
      actions.flushCalendarRedraw,
      actions.flushClientList,
      actions.flushDirectoryReads,
    ]) {
      try {
        const task = flush?.();
        if (task && typeof task.then === 'function') flushed.push(task.catch(() => {}));
      } catch {
        /* Passive presentation failure must not disable refresh. */
      }
    }
    // The mandatory fresh zone is already applied before the current-range calendar read.
    // Other work keeps its due time and budget.
    const tasks = [...flushed, ...jobs.map((job) => runJob(job, force && job.id === 'calendar'))];
    schedule();
    await Promise.all(tasks);
  }

  function bindBackgroundEvents() {
    if (bound) return;
    bound = true;
    const resume = () => {
      stopped = false;
      void refreshBackground({ reason: 'resume' });
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(timer);
      else resume();
    });
    window.addEventListener('pagehide', () => {
      stopped = true;
      clearTimeout(timer);
    });
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', resume);
    schedule();
  }

  return { readBackground, refreshBackground, bindBackgroundEvents };
}
