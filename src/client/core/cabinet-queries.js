function createCabinetQueries(state, actions) {
  const loading = new Map(),
    generations = new Map();
  let calendarLoadedKey = '';
  let calendarVersion = '',
    calendarValidUntil = 0;
  let calendarKey = '',
    calendarSequence = 0;
  function clientRecords() {
    return state.lazyReads ? state.directory : state.data;
  }
  function rememberPatient(cabinet) {
    const patient = cabinet.patients[0];
    if (!patient) return;
    state.data = state.data.filter((p) => p.id !== patient.id);
    state.data.push(patient);
    state.revision = cabinet.revision;
    actions.rememberLoadedPatient(patient);
  }
  function invalidatePatientRead(ids) {
    const removed = new Set(ids);
    state.data = state.data.filter((p) => !removed.has(p.id));
    for (const id of removed) generations.set(id, (generations.get(id) || 0) + 1);
    for (const key of loading.keys())
      if (removed.has(key.slice(key.lastIndexOf('|') + 1))) loading.delete(key);
  }
  async function ensurePatient(id, { force = false } = {}) {
    if (!state.lazyReads) return state.data.find((p) => p.id === id);
    const cached = state.data.find((p) => p.id === id);
    if (cached && !force) return cached;
    const account = state.account,
      scope = JSON.stringify([account?.id, account?.organizationId, account?.role]),
      key = scope + '|' + id,
      generation = generations.get(id) || 0;
    if (loading.has(key)) return loading.get(key);
    const task = (async () => {
      const cabinet = await actions.request('/api/cabinet/patient?id=' + encodeURIComponent(id));
      if (
        generation !== (generations.get(id) || 0) ||
        state.account !== account ||
        JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]) !==
          scope
      )
        return;
      rememberPatient(cabinet);
      return cabinet.patients[0];
    })();
    loading.set(key, task);
    try {
      return await task;
    } finally {
      if (loading.get(key) === task) loading.delete(key);
    }
  }
  async function readAppointmentEditor(patientId, id, { details = false, signal } = {}) {
    const account = state.account,
      identity = JSON.stringify([account?.id, account?.organizationId, account?.role]);
    const result = await actions.request(
      '/api/cabinet/patient?id=' +
        encodeURIComponent(patientId) +
        '&view=appointment&appointmentId=' +
        encodeURIComponent(id) +
        (details ? '&details=1' : ''),
      { signal },
    );
    if (
      state.account !== account ||
      identity !==
        JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role])
    )
      return;
    return {
      ...result,
      account: JSON.stringify([account?.id, account?.organizationId, account?.role]),
    };
  }
  function calendarReadRange() {
    let from = new Date(state.calendarAnchorDate),
      to = new Date(from);
    const mode =
      state.calendarMode === 'load' ? state.calendarLoadPeriod || 'week' : state.calendarMode;
    if (mode === 'week') to.setDate(to.getDate() + 6);
    if (mode === 'month') {
      if (state.calendarMode !== 'load') return calendarMonthRange();
      from = new Date(from.getFullYear(), from.getMonth(), 1);
      to = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    }
    if (state.calendarMode === 'load') from.setDate(from.getDate() - 1);
    return { from: actions.isoDate(from), to: actions.isoDate(to) };
  }
  function calendarMonthRange() {
    const from = actions.weekStart(
      new Date(state.calendarAnchorDate.getFullYear(), state.calendarAnchorDate.getMonth(), 1),
    );
    const to = new Date(from);
    to.setDate(to.getDate() + 41);
    return { from: actions.isoDate(from), to: actions.isoDate(to) };
  }
  function calendarScopeKey() {
    return JSON.stringify([
      state.account?.id,
      state.account?.organizationId,
      state.account?.role,
      state.calendarMode,
      state.calendarLoadPeriod,
      calendarReadRange(),
      calendarMonthRange(),
    ]);
  }
  function calendarRecordsReady() {
    return !state.lazyReads || calendarLoadedKey === calendarScopeKey();
  }
  function invalidateCalendarRead() {
    calendarLoadedKey = '';
    calendarKey = '';
    calendarVersion = '';
    calendarValidUntil = 0;
    state.calendarOverview = null;
    state.calendarPersonalOverview = null;
    calendarSequence++;
  }
  async function loadCalendarRecords({ force = false, required = false } = {}) {
    if (!state.lazyReads) return;
    const range = calendarReadRange(),
      month = calendarMonthRange(),
      key = calendarScopeKey();
    if (!force && key === calendarKey) return;
    calendarKey = key;
    const sequence = ++calendarSequence;
    try {
      const result = await actions.readBackground(
        '/api/cabinet/calendar?from=' +
          range.from +
          '&to=' +
          range.to +
          '&compact=1&monthFrom=' +
          month.from +
          '&monthTo=' +
          month.to +
          '&projection=' +
          (state.calendarMode === 'month'
            ? 'overview'
            : state.calendarMode === 'load'
              ? 'occupancy'
              : 'details') +
          (calendarLoadedKey === key && calendarVersion
            ? '&version=' + encodeURIComponent(calendarVersion) + '&until=' + calendarValidUntil
            : ''),
      );
      if (
        sequence !== calendarSequence ||
        key !== calendarScopeKey() ||
        typeof document === 'undefined' ||
        !document
      )
        return;
      if (result.unchanged) return;
      const changed =
        calendarLoadedKey !== key ||
        JSON.stringify(state.calendarRecords) !== JSON.stringify(result.appointments) ||
        JSON.stringify(state.calendarOverview) !== JSON.stringify(result.overview || null) ||
        JSON.stringify(state.personalEvents) !== JSON.stringify(result.personalEvents || []) ||
        JSON.stringify(state.calendarPersonalOverview) !==
          JSON.stringify(result.personalOverview || null);
      calendarLoadedKey = key;
      calendarVersion = result.version || '';
      calendarValidUntil = result.validUntil || 0;
      state.calendarRecords = result.appointments;
      state.calendarOverview = result.overview || null;
      state.personalEvents = result.personalEvents || [];
      state.personalRevision = result.personalRevision || 0;
      state.calendarPersonalOverview = result.personalOverview || null;
      if (state.sessionReady === false) return;
      if (changed && state.currentView === 'calendar' && !actions.$('#editor')?.open) {
        const previous = actions.$('.time-scroll');
        const top = previous?.scrollTop || 0;
        const weekLeft = previous?.classList.contains('time-scroll-week')
          ? Number(previous.dataset.weekScrollTarget ?? previous.scrollLeft)
          : 0;
        actions.setView('calendar', { redraw: true });
        const grid = actions.$('.time-scroll');
        if (grid) {
          grid.scrollTop = top;
          if (weekLeft && grid.classList.contains('time-scroll-week')) grid.scrollLeft = weekLeft;
        }
      } else if (changed && state.currentView === 'calendar') actions.updateCurrentTime();
    } catch (error) {
      if (sequence === calendarSequence && typeof document !== 'undefined' && document) {
        calendarKey = '';
        if (!required) actions.toast('Не удалось загрузить записи: ' + error.message);
      }
      if (required) throw error;
    }
  }
  return {
    clientRecords,
    rememberPatient,
    ensurePatient,
    readAppointmentEditor,
    invalidatePatientRead,
    calendarReadRange,
    calendarRecordsReady,
    invalidateCalendarRead,
    loadCalendarRecords,
  };
}
