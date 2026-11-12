// Calendar grouping and selection only; permissions and schedule data remain server-owned.
function createCalendarColumns(state, actions) {
  function calendarStaffName(id) {
    const member =
      actions.calendarScheduleMembers().find((m) => m.accountId === id) ||
      state.workspace?.members?.find((m) => m.accountId === id);
    return (
      member?.displayName ||
      (id === actions.accountId() ? state.account?.displayName : '') ||
      'Сотрудник'
    );
  }
  function normalizeCalendarSelection() {
    if (!state.multiUser || state.calendarMode === 'load') return;
    const members = actions.calendarScheduleMembers();
    const rooms = state.workspace.rooms.filter((r) => r.active);
    if (rooms.length <= 1) state.calendarGrouping = 'staff';
    else if (members.length <= 1) state.calendarGrouping = 'rooms';
    if (actions.accountRole() === 'cosmetologist')
      state.selectedScheduleStaff = actions.accountId();
    if (state.calendarGrouping === 'rooms') {
      state.selectedScheduleStaff = '';
      if (state.selectedRoomId && !rooms.some((r) => r.id === state.selectedRoomId))
        state.selectedRoomId = '';
      if (state.calendarMode === 'week' && !state.selectedRoomId)
        state.selectedRoomId = rooms[0]?.id || '';
    } else {
      state.selectedRoomId = '';
      if (
        state.selectedScheduleStaff &&
        members.length &&
        !members.some((m) => m.accountId === state.selectedScheduleStaff)
      )
        state.selectedScheduleStaff = '';
      if (state.calendarMode === 'week' && !state.selectedScheduleStaff)
        state.selectedScheduleStaff =
          members.find((m) => m.accountId === actions.accountId())?.accountId ||
          members[0]?.accountId ||
          actions.accountId();
    }
  }
  function calendarColumns(days) {
    if (!state.multiUser)
      return days.map((date) => ({
        date: actions.isoDate(date),
        key: actions.isoDate(date),
        staffIds: null,
      }));
    const roomMode = state.calendarGrouping === 'rooms';
    const members = actions.calendarScheduleMembers();
    const visibleIds = new Set(members.map((m) => m.accountId));
    const entities = roomMode
      ? state.workspace.rooms
          .filter((r) => r.active && (!state.selectedRoomId || r.id === state.selectedRoomId))
          .map((r) => ({
            roomId: r.id,
            title: r.name,
            staffIds:
              actions.accountRole() === 'cosmetologist'
                ? [actions.accountId()]
                : (r.staffIds || []).filter((id) => visibleIds.has(id)),
          }))
      : members
          .filter(
            (m) => !state.selectedScheduleStaff || m.accountId === state.selectedScheduleStaff,
          )
          .map((m) => ({
            staffId: m.accountId,
            title: m.displayName || 'Сотрудник',
            staffIds: [m.accountId],
          }));
    if (!roomMode && !state.selectedScheduleStaff && state.calendarMode === 'day') {
      for (const record of actions.calendarEvents()) {
        const id = record.staffId || actions.accountId();
        if (
          !record.busy &&
          (record.personal || record.kind === 'personal'
            ? actions.personalCalendarDayEvent(record, actions.isoDate(days[0]))
            : record.date === actions.isoDate(days[0])) &&
          !entities.some((entity) => entity.staffId === id)
        )
          entities.push({ staffId: id, title: calendarStaffName(id), staffIds: [id] });
      }
    }
    if (!entities.length)
      entities.push({
        staffId: actions.accountId(),
        title: calendarStaffName(actions.accountId()),
        staffIds: [actions.accountId()],
      });
    return state.calendarMode === 'day'
      ? entities.map((entity, index) => ({
          ...entity,
          date: actions.isoDate(days[0]),
          key: 'column-' + index,
        }))
      : days.map((date, index) => ({
          ...entities[0],
          date: actions.isoDate(date),
          key: 'column-' + index,
        }));
  }
  function calendarColumnEvents(records, column, includeOtherDates = false) {
    return records.flatMap((a) => {
      const personal = a.personal || a.kind === 'personal';
      const matchesColumn = column.roomId
        ? personal
          ? column.staffIds?.includes(a.staffId) &&
            (!includeOtherDates || column.staffIds.length === 1)
          : a.roomId === column.roomId
        : !column.staffId ||
          (a.busy
            ? a.staffId
              ? a.staffId === column.staffId
              : actions.accountRole() === 'cosmetologist'
            : (a.staffId || actions.accountId()) === column.staffId);
      if (!matchesColumn) return [];
      if (includeOtherDates) return [a];
      if (personal) {
        const projected = actions.personalCalendarDayEvent(a, column.date);
        return projected ? [projected] : [];
      }
      return a.date === column.date ? [a] : [];
    });
  }
  function calendarSelectionHtml() {
    if (!state.multiUser || state.calendarMode === 'load') return '';
    normalizeCalendarSelection();
    const roomMode = state.calendarGrouping === 'rooms';
    const rooms = state.workspace.rooms.filter((r) => r.active);
    const members = actions.calendarScheduleMembers();
    const own = actions.accountRole() === 'cosmetologist';
    const week = state.calendarMode === 'week';
    const group =
      rooms.length > 1 && members.length > 1
        ? '<label><span class="calendar-filter-label">Расписание</span><select id="calendar-grouping"><option value="staff" ' +
          (!roomMode ? 'selected' : '') +
          '>Сотрудники</option><option value="rooms" ' +
          (roomMode ? 'selected' : '') +
          '>Кабинеты</option></select></label>'
        : '';
    const picker =
      roomMode && rooms.length > 1
        ? '<label><span class="calendar-filter-label">Кабинет</span><select id="calendar-room-filter">' +
          (!week ? '<option value="">Все кабинеты</option>' : '') +
          rooms
            .map(
              (r) =>
                '<option value="' +
                actions.esc(r.id) +
                '" ' +
                (r.id === state.selectedRoomId ? 'selected' : '') +
                '>' +
                actions.esc(r.name) +
                '</option>',
            )
            .join('') +
          '</select></label>'
        : !roomMode && !own && members.length > 1
          ? '<label><span class="calendar-filter-label">Сотрудник</span><select id="calendar-schedule-staff">' +
            (!week ? '<option value="">Все сотрудники</option>' : '') +
            members
              .map(
                (m) =>
                  '<option value="' +
                  actions.esc(m.accountId) +
                  '" ' +
                  (m.accountId === state.selectedScheduleStaff ? 'selected' : '') +
                  '>' +
                  actions.esc(m.displayName || 'Сотрудник') +
                  '</option>',
              )
              .join('') +
            '</select></label>'
          : '';
    if (!group && !picker) return '';
    const selected = roomMode
      ? actions.roomName(state.selectedRoomId)
      : state.selectedScheduleStaff
        ? calendarStaffName(state.selectedScheduleStaff)
        : '';
    return (
      '<div class="calendar-selection">' +
      group +
      picker +
      (week ? '<small>Неделя · ' + actions.esc(selected) + '</small>' : '') +
      '</div>'
    );
  }
  function calendarNewAppointment(slot = null, click = null) {
    let time = slot?.dataset.slotTime,
      gapDuration = Number(slot?.dataset.gapDuration) || 0;
    if (slot && !gapDuration && Number.isFinite(click?.clientY)) {
      const rect = slot.getBoundingClientRect();
      if (rect.height > 0) {
        const [hour, minute] = String(time).split(':').map(Number);
        const start = hour * 60 + minute;
        const point =
          start +
          Math.min(
            55,
            Math.max(0, Math.floor(((click.clientY - rect.top) / rect.height) * 12) * 5),
          );
        const columnKey = slot.dataset.columnKey || slot.dataset.slotDate;
        const gap = [
          ...(slot.closest('.time-grid')?.querySelectorAll('[data-calendar-gap]') || []),
        ].find(
          (label) =>
            label.dataset.columnKey === columnKey &&
            Number(label.dataset.gapStart) <= point &&
            point < Number(label.dataset.gapEnd),
        );
        if (gap) {
          const begin = Math.max(start, Number(gap.dataset.gapStart));
          const available = Math.min(60, Number(gap.dataset.gapEnd) - begin);
          time = actions.timeLabel(begin);
          gapDuration =
            available < 15 ? Math.floor(available / 5) * 5 : Math.floor(available / 15) * 15;
        }
      }
    }
    const roomId = slot?.dataset.slotRoom || state.selectedRoomId;
    const room = state.workspace.rooms.find((r) => r.id === roomId);
    const staffId =
      slot?.dataset.slotStaff ||
      state.selectedScheduleStaff ||
      (actions.accountRole() === 'cosmetologist' ? actions.accountId() : '') ||
      (room?.staffIds?.length === 1 ? room.staffIds[0] : '');
    return {
      date: slot?.dataset.slotDate || actions.isoDate(state.calendarAnchorDate),
      ...(slot ? { time, timeHour: time?.slice(0, 2) } : {}),
      ...(staffId ? { staffId } : {}),
      ...(roomId ? { roomId } : {}),
      ...(gapDuration
        ? {
            duration: gapDuration,
            gapDuration,
          }
        : {}),
    };
  }
  function changeCalendarGrouping(value) {
    state.calendarGrouping = value === 'rooms' ? 'rooms' : 'staff';
    state.selectedRoomId = '';
    state.selectedScheduleStaff =
      actions.accountRole() === 'cosmetologist' ? actions.accountId() : '';
    normalizeCalendarSelection();
    actions.setView('calendar');
  }
  function setCalendarMode(mode) {
    const closingLoad = mode === 'load' && state.calendarMode === 'load';
    if (mode === 'load') {
      if (closingLoad)
        mode = state.calendarLoadReturnMode || (state.mobileScreen?.matches ? 'day' : 'week');
      else {
        state.calendarLoadReturnMode = state.calendarMode;
        state.calendarLoadPeriod = ['day', 'week', 'month'].includes(state.calendarMode)
          ? state.calendarMode
          : 'week';
      }
      state.monthPickerOpen = false;
    }
    if (mode === 'day' && state.calendarMode !== 'day' && !closingLoad) {
      state.selectedRoomId = '';
      state.selectedScheduleStaff =
        actions.accountRole() === 'cosmetologist' ? actions.accountId() : '';
    }
    state.calendarMode = mode;
    normalizeCalendarSelection();
  }
  return {
    calendarStaffName,
    normalizeCalendarSelection,
    calendarColumns,
    calendarColumnEvents,
    calendarSelectionHtml,
    calendarNewAppointment,
    changeCalendarGrouping,
    setCalendarMode,
  };
}
