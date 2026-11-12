function createCalendarLoadNavigation(state, actions) {
  function handleCalendarLoadNavigation(target) {
    const nav = target.closest('[data-view="calendar"]');
    if (nav && state.calendarMode === 'load') {
      actions.setCalendarMode(state.mobileScreen?.matches ? 'day' : 'week');
      state.monthPickerOpen = false;
      actions.setView('calendar');
      return true;
    }
    if (state.calendarMode !== 'load') return false;
    const period = target.closest('[data-load-period]');
    if (period) {
      if (['day', 'week', 'month'].includes(period.dataset.loadPeriod)) {
        state.calendarLoadPeriod = period.dataset.loadPeriod;
        state.monthPickerOpen = false;
        actions.setView('calendar');
      }
      return true;
    }
    if (target.closest('[data-calendar-today]')) {
      state.calendarAnchorDate = actions.cabinetTodayDate();
      actions.setCalendarMode('day');
      state.monthPickerOpen = false;
      actions.setView('calendar');
      return true;
    }
    const previous = target.closest('[data-calendar-prev]');
    if (previous || target.closest('[data-calendar-next]')) {
      const direction = previous ? -1 : 1;
      const date = state.calendarAnchorDate;
      if (state.calendarLoadPeriod === 'month')
        state.calendarAnchorDate = new Date(date.getFullYear(), date.getMonth() + direction, 1);
      else {
        state.calendarAnchorDate = new Date(date);
        state.calendarAnchorDate.setDate(
          date.getDate() + direction * (state.calendarLoadPeriod === 'day' ? 1 : 7),
        );
      }
      state.monthPickerOpen = false;
      actions.setView('calendar');
      return true;
    }
    return false;
  }
  return { handleCalendarLoadNavigation };
}
