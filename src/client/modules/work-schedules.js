function createWorkSchedules(state, actions) {
  let snapshot = null,
    calendar = null,
    selected = new Set(),
    month = '',
    staff = '',
    sequence = 0;
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  let activeScope = '';
  function resetScope() {
    if (activeScope === scope()) return;
    activeScope = scope();
    snapshot = calendar = null;
    selected.clear();
    staff = '';
    month = '';
    state.selectedScheduleStaff = '';
    state.calendarGrouping = 'staff';
    state.selectedRoomId = '';
  }
  const monthRange = () => {
    const [year, number] = month.split('-').map(Number);
    return { from: month + '-01', to: actions.isoDate(new Date(year, number, 0)) };
  };
  function defaultScheduleStaff() {
    if (actions.accountRole() !== 'salon_admin') return actions.accountId();
    return (
      state.workspace.members.find(
        (m) => m.status === 'active' && ['owner', 'cosmetologist'].includes(m.role),
      )?.accountId || 'organization'
    );
  }
  function workScheduleSettingsHtml() {
    resetScope();
    return '<section id="work-schedules-settings" class="work-schedule-panel" aria-label="Рабочее время"><p class="settings-loading" role="status">Загрузка графика…</p></section>';
  }
  function renderWorkSchedules() {
    const root = actions.$('#work-schedules-settings');
    if (!root || !snapshot || snapshot.staffId !== staff) return;
    root.innerHTML = actions.workScheduleMonthHtml(snapshot, month, [...selected]);
    actions.$('#work-schedule-staff').value = staff;
    actions.mountTimePickerFields?.(root, {
      editor: false,
      guard: () => state.currentView === 'services' && root.isConnected,
    });
  }
  async function loadWorkSchedules() {
    const root = actions.$('#work-schedules-settings');
    if (!state.multiUser || state.currentView !== 'services' || !root) return;
    resetScope();
    month ||= actions.cabinetToday().slice(0, 7);
    staff ||= defaultScheduleStaff();
    const id = ++sequence,
      key = scope(),
      target = staff,
      period = monthRange();
    root.innerHTML = '<p class="settings-loading" role="status">Загрузка графика…</p>';
    try {
      const result = await actions.readBackground(
        '/api/work-schedules?staffId=' +
          encodeURIComponent(target) +
          '&from=' +
          period.from +
          '&to=' +
          period.to,
      );
      if (
        id !== sequence ||
        key !== scope() ||
        state.currentView !== 'services' ||
        !root.isConnected
      )
        return;
      snapshot = result;
      calendar = null;
      renderWorkSchedules();
    } catch (error) {
      if (id === sequence && key === scope() && root.isConnected) {
        root.innerHTML =
          '<p role="status">' +
          actions.esc(error.message) +
          '</p><button type="button" class="secondary" data-work-retry>Повторить загрузку</button>';
      }
    }
  }
  function scheduleEditorContext() {
    if (!snapshot || !selected.size || !snapshot.canEdit) return null;
    return {
      scope: scope(),
      staffId: staff,
      dates: [...selected].sort(),
      revision: snapshot.revision,
      expectedTimeZone: snapshot.timeZone,
      day: selected.size === 1 ? snapshot.days[[...selected][0]] : null,
    };
  }
  async function changeWorkScheduleMonth(offset) {
    const [year, number] = month.split('-').map(Number);
    month = actions.isoDate(new Date(year, number - 1 + offset, 1)).slice(0, 7);
    selected.clear();
    await loadWorkSchedules();
  }
  async function loadCalendarSchedule({ force = false } = {}) {
    if (!state.multiUser || state.currentView !== 'calendar') return;
    resetScope();
    const period = actions.calendarRange(),
      key = scope(),
      target = state.selectedScheduleStaff || defaultScheduleStaff();
    const cacheKey = JSON.stringify([key, target, period]);
    if (!force && calendar?.cacheKey === cacheKey) return;
    try {
      const result = await actions.readBackground(
        '/api/work-schedules?staffId=' +
          encodeURIComponent(target) +
          '&from=' +
          period.from +
          '&to=' +
          period.to,
      );
      if (
        key !== scope() ||
        state.currentView !== 'calendar' ||
        target !== (state.selectedScheduleStaff || defaultScheduleStaff()) ||
        JSON.stringify(actions.calendarRange()) !== JSON.stringify(period)
      )
        return;
      const prior = calendar;
      calendar = { ...result, cacheKey };
      if (
        !state.selectedScheduleStaff &&
        (actions.accountRole() === 'cosmetologist' || result.members.length === 1)
      )
        state.selectedScheduleStaff = result.staffId;
      if (
        JSON.stringify(prior) !== JSON.stringify(calendar) &&
        !actions.$('#editor')?.open &&
        !state.busy
      ) {
        const top = actions.$('.time-scroll')?.scrollTop;
        actions.setView('calendar', { redraw: true });
        if (top !== undefined && actions.$('.time-scroll'))
          actions.$('.time-scroll').scrollTop = top;
      }
    } catch {
      /* Schedule refresh must not replace a loaded calendar with an error. */
    }
  }
  function calendarLoadSchedule() {
    resetScope();
    return calendar;
  }
  function calendarWorkScheduleHtml() {
    resetScope();
    if (!state.multiUser) return '';
    const date = actions.isoDate(state.calendarAnchorDate),
      day = calendar?.days?.[date],
      closed = calendar?.closures?.[date]?.status === 'closed' || day?.status === 'closed',
      hours = closed
        ? 'Выходной'
        : day?.status === 'working'
          ? actions.workDayLabel(calendar, date)
          : '';
    const label =
      state.selectedScheduleStaff && hours
        ? '<small class="calendar-work-hours">' + '<span>' + actions.esc(hours) + '</span></small>'
        : '';
    return label ? '<div class="calendar-work-schedule">' + label + '</div>' : '';
  }
  function calendarScheduleMembers() {
    resetScope();
    const members = calendar?.members || state.workspace?.members || [];
    return members.filter(
      (m) =>
        (!m.status || m.status === 'active') &&
        ['owner', 'cosmetologist'].includes(m.role) &&
        (actions.accountRole() !== 'cosmetologist' || m.accountId === actions.accountId()),
    );
  }
  function filterScheduleCalendarEvents(records) {
    resetScope();
    return !state.selectedScheduleStaff
      ? records
      : records.filter(
          (a) => a.busy || (a.staffId || actions.accountId()) === state.selectedScheduleStaff,
        );
  }
  function scheduleDayLabel(date, staffIds = null) {
    resetScope();
    if (!calendar || date < calendar.from || date > calendar.to) return '';
    if (calendar.closures[date]?.status === 'closed') return 'Общий нерабочий день';
    if (staffIds) {
      const day = calendarScheduleDay(date, staffIds);
      return day?.status === 'closed'
        ? 'Выходной'
        : day?.status === 'working'
          ? day.intervals.map((pair) => pair.join('–')).join(', ')
          : '';
    }
    return state.selectedScheduleStaff && calendar.days[date]
      ? actions.workDayLabel(calendar, date)
      : '';
  }
  function calendarScheduleDay(date, staffIds = null) {
    resetScope();
    if (!calendar || date < calendar.from || date > calendar.to) return null;
    if (calendar.closures[date]?.status === 'closed') return { status: 'closed' };
    if (staffIds === null && state.calendarGrouping === 'rooms' && state.selectedRoomId) {
      const visible = new Set(calendar.members.map((m) => m.accountId));
      staffIds =
        actions.accountRole() === 'cosmetologist'
          ? [actions.accountId()]
          : (
              state.workspace.rooms.find((r) => r.id === state.selectedRoomId)?.staffIds || []
            ).filter((id) => visible.has(id));
    }
    if (staffIds) {
      const days = staffIds.map(
        (id) =>
          calendar.staffDays?.[id]?.[date] ||
          (calendar.staffId === id ? calendar.days[date] : null),
      );
      const pairs = days.flatMap((day) => (day?.status === 'working' ? day.intervals : []));
      const merged = [];
      for (const pair of pairs.sort((a, b) => a[0].localeCompare(b[0]))) {
        const last = merged.at(-1);
        if (last && pair[0] <= last[1]) last[1] = pair[1] > last[1] ? pair[1] : last[1];
        else merged.push([...pair]);
      }
      return merged.length
        ? { status: 'working', intervals: merged }
        : days.length && days.every((day) => day?.status === 'closed')
          ? { status: 'closed' }
          : null;
    }
    const intervals = calendar.workingIntervals?.[date];
    return state.selectedScheduleStaff
      ? calendar.days[date]
      : intervals?.length
        ? { status: 'working', intervals }
        : null;
  }
  function scheduleDayKind(date, staffIds = null) {
    return calendarScheduleDay(date, staffIds)?.status || 'unset';
  }
  function calendarWorkingRanges(date, staffIds = null) {
    const day = calendarScheduleDay(date, staffIds);
    if (!day || day.status === 'unset') return null;
    if (day.status !== 'working') return [];
    const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    return day.intervals.map(([from, to]) => [minutes(from), minutes(to)]);
  }
  function scheduleSlotStyle(date, start, staffIds = null) {
    const day = calendarScheduleDay(date, staffIds);
    if (day?.status === 'closed') return '#e4e7eb';
    if (day?.status !== 'working') return '';
    const time = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
    const stops = [];
    let cursor = 0;
    for (const [from, to] of day.intervals) {
      const a = Math.max(0, Math.min(60, time(from) - start)),
        b = Math.max(0, Math.min(60, time(to) - start));
      if (b <= a) continue;
      if (a > cursor) stops.push(`#e8f3ec ${cursor / 0.6}% ${a / 0.6}%`);
      stops.push(`transparent ${a / 0.6}% ${b / 0.6}%`);
      cursor = b;
    }
    if (cursor < 60) stops.push(`#e8f3ec ${cursor / 0.6}% 100%`);
    // A gradient needs two color stops. Full hours do not need an interval mask.
    if (stops.length === 1) return cursor === 60 ? 'var(--calendar-work-grid),#fafbfc' : '#e8f3ec';
    return `linear-gradient(to bottom,${stops.join(',')}),var(--calendar-work-grid),#fafbfc`;
  }
  function calendarHiddenUntil() {
    const value = calendar?.calendarHiddenUntil || '07:00';
    return Number(value.slice(0, 2)) * 60;
  }
  async function openWorkScheduleSettings() {
    resetScope();
    month = actions.isoDate(state.calendarAnchorDate).slice(0, 7);
    staff = state.selectedScheduleStaff || defaultScheduleStaff();
    selected.clear();
    await actions.openManagement('schedule');
    const root = actions.$('#work-schedules-settings');
    if (root) {
      root.scrollIntoView?.({ block: 'start' });
    }
  }
  function bindWorkScheduleEvents() {
    document.addEventListener('click', async (e) => {
      const button = e.target.closest(
        '[data-work-date],[data-work-month],[data-work-weekday],[data-work-clear],[data-work-edit],[data-open-work-schedule],[data-work-retry],[data-work-scope]',
      );
      if (!button || state.busy) return;
      e.stopImmediatePropagation();
      try {
        if (button.hasAttribute('data-open-work-schedule')) {
          await openWorkScheduleSettings();
          return;
        }
        if (button.hasAttribute('data-work-retry')) {
          await loadWorkSchedules();
          return;
        }
        if (button.hasAttribute('data-work-scope')) {
          staff = button.dataset.workScope;
          selected.clear();
          snapshot = null;
          await loadWorkSchedules();
          return;
        }
        if (button.hasAttribute('data-work-month')) {
          await changeWorkScheduleMonth(Number(button.dataset.workMonth));
          return;
        }
        if (button.hasAttribute('data-work-date')) {
          const date = button.dataset.workDate;
          selected.has(date) ? selected.delete(date) : selected.add(date);
        }
        if (button.hasAttribute('data-work-clear')) selected.clear();
        if (button.hasAttribute('data-work-weekday')) {
          const period = monthRange(),
            dates = [];
          for (
            let d = actions.parseDate(period.from);
            actions.isoDate(d) <= period.to;
            d.setDate(d.getDate() + 1)
          )
            if ((d.getDay() + 6) % 7 === Number(button.dataset.workWeekday))
              dates.push(actions.isoDate(d));
          const remove = dates.every((d) => selected.has(d));
          for (const d of dates) remove ? selected.delete(d) : selected.add(d);
        }
        if (button.hasAttribute('data-work-edit')) {
          actions.openWorkScheduleEditor();
          return;
        }
        renderWorkSchedules();
      } catch (error) {
        actions.toast(error.message);
      }
    });
    document.addEventListener('change', async (e) => {
      if (state.busy) return;
      try {
        if (e.target.id === 'work-schedule-staff') {
          staff = e.target.value;
          selected.clear();
          snapshot = null;
          await loadWorkSchedules();
        }
        if (e.target.id === 'calendar-schedule-staff') {
          state.selectedScheduleStaff = e.target.value;
          calendar = null;
          await loadCalendarSchedule({ force: true });
          actions.setView('calendar');
        }
        if (e.target.id === 'work-schedule-permission' && snapshot) {
          state.busy = true;
          try {
            await actions.request('/api/work-schedules/permission', {
              method: 'POST',
              body: JSON.stringify({
                staffId: staff,
                revision: snapshot.revision,
                allowSelfEdit: e.target.checked,
              }),
            });
          } finally {
            state.busy = false;
            await loadWorkSchedules();
          }
        }
        if (e.target.id === 'calendar-hidden-until' && snapshot) {
          state.busy = true;
          try {
            await actions.request('/api/work-schedules/calendar-settings', {
              method: 'POST',
              body: JSON.stringify({
                revision: snapshot.calendarRevision,
                hiddenUntil: e.target.value,
              }),
            });
            state.showEarlyHours = false;
            calendar = null;
            actions.toast('Видимое время календаря сохранено');
          } finally {
            state.busy = false;
            await loadWorkSchedules();
          }
        }
      } catch (error) {
        actions.toast(error.message);
      }
    });
  }
  return {
    workScheduleSettingsHtml,
    loadWorkSchedules,
    scheduleEditorContext,
    loadCalendarSchedule,
    calendarWorkScheduleHtml,
    calendarLoadSchedule,
    calendarScheduleMembers,
    filterScheduleCalendarEvents,
    scheduleDayLabel,
    scheduleDayKind,
    calendarWorkingRanges,
    scheduleSlotStyle,
    calendarHiddenUntil,
    bindWorkScheduleEvents,
  };
}
