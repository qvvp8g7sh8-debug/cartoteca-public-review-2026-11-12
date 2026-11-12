function createCabinetTime(state, actions) {
  let pending = null,
    checkedAt = 0,
    checkedScope = '',
    generation = 0;
  const scope = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  function cabinetClock() {
    const now = new Date();
    return state.multiUser
      ? actions.zonedClock(now, state.timeZone)
      : { date: actions.isoDate(now), hour: now.getHours(), minute: now.getMinutes() };
  }
  function cabinetToday() {
    return cabinetClock().date;
  }
  function cabinetTodayDate() {
    return actions.parseDate(cabinetToday());
  }
  function cabinetTimeZoneLabel() {
    if (!state.multiUser) return '';
    const city = new Intl.DateTimeFormat('ru-RU', {
      timeZone: state.timeZone,
      timeZoneName: 'long',
    })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;
    return (
      (city ? city.replace(/,.*$/, '') + ' · ' : '') +
      new Intl.DateTimeFormat('ru-RU', {
        timeZone: state.timeZone,
        timeZoneName: 'longOffset',
      })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')
        .value.replace('GMT', 'UTC')
    );
  }
  function applyCabinetTimeZone(timeZone, { initial = false, presentationOnly = false } = {}) {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    generation++;
    const oldToday = cabinetToday(),
      changed = state.timeZone !== timeZone;
    state.timeZone = timeZone;
    checkedAt = Date.now();
    checkedScope = scope();
    if (initial || actions.isoDate(state.calendarAnchorDate) === oldToday)
      state.calendarAnchorDate = cabinetTodayDate();
    if (!initial && changed) {
      actions.invalidateDirectory();
      actions.invalidateCalendarRead();
      if (state.currentView === 'calendar')
        void actions.setView('calendar', { redraw: true, presentationOnly });
      if (['clients', 'card'].includes(state.currentView)) actions.renderList();
    }
  }
  async function refreshCabinetTimeZone({
    force = false,
    required = false,
    priority,
    presentationOnly = false,
  } = {}) {
    const observe = async (task) => {
      try {
        return await task;
      } catch (error) {
        if (required) throw error;
        // Optional callers keep the last confirmed clock; the shared outcome still rejects.
      }
    };
    const requestScope = scope();
    if (
      !state.multiUser ||
      !state.account ||
      document.hidden ||
      (!force && checkedScope === requestScope && Date.now() - checkedAt < 60000)
    )
      return;
    const requestAccount = state.account,
      requestGeneration = generation;
    if (
      pending?.scope === requestScope &&
      pending.account === requestAccount &&
      pending.generation === requestGeneration
    )
      return observe(pending.task);
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 12000);
    checkedAt = Date.now();
    checkedScope = requestScope;
    const task = (async () => {
      try {
        const result = await actions.request('/api/cabinet/time-zone', {
          signal: controller.signal,
          priority,
        });
        if (
          state.account !== requestAccount ||
          scope() !== requestScope ||
          generation !== requestGeneration ||
          pending !== owned
        )
          throw Error('Часовой пояс изменился во время загрузки. Повторите проверку.');
        applyCabinetTimeZone(result.timeZone, { presentationOnly });
      } finally {
        clearTimeout(timeout);
      }
    })();
    const owned = {
      scope: requestScope,
      account: requestAccount,
      generation: requestGeneration,
      task,
    };
    pending = owned;
    try {
      await observe(task);
    } finally {
      if (pending === owned) pending = null;
    }
  }
  return {
    cabinetClock,
    cabinetToday,
    cabinetTodayDate,
    cabinetTimeZoneLabel,
    applyCabinetTimeZone,
    refreshCabinetTimeZone,
  };
}
