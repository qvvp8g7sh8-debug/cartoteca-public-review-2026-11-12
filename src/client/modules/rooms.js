function createRooms(state, actions) {
  let availabilitySequence = 0;
  const blocksRoom = (id) => {
    const room = state.workspace.rooms.find((r) => r.id === id);
    return typeof room?.preventOverlap === 'boolean'
      ? room.preventOverlap
      : state.workspace.enabled;
  };
  const hasProtection = () =>
    state.workspace.enabled ||
    state.workspace.staffRules?.some((r) => r.preventOverlap) ||
    state.workspace.rooms.some((r) => r.active && blocksRoom(r.id));
  const blocksStaff = (staffId) =>
    state.workspace.staffRules?.find((r) => r.staffId === staffId)?.preventOverlap ??
    state.workspace.enabled;
  function appointmentOverlapRules(staffId, roomId) {
    return { staff: Boolean(blocksStaff(staffId)), room: Boolean(blocksRoom(roomId)) };
  }
  function roomsFor(staffId = actions.accountId()) {
    return state.workspace.rooms.filter(
      (r) =>
        r.active && (actions.accountRole() === 'cosmetologist' || r.staffIds?.includes(staffId)),
    );
  }
  function appointmentRoomId(a) {
    if (a.roomId) return a.roomId;
    const rooms = roomsFor(a.staffId || actions.accountId());
    return rooms.length === 1 ? rooms[0].id : '';
  }
  function roomName(id) {
    return state.workspace.rooms.find((r) => r.id === id)?.name || '';
  }
  function roomOptions(staffId, current = '') {
    const rooms = roomsFor(staffId),
      selected = current || (rooms.length === 1 ? rooms[0].id : '');
    return (
      '<option value="">' +
      (rooms.length ? 'Выберите кабинет' : 'Нет назначенных кабинетов') +
      '</option>' +
      rooms
        .map(
          (r) =>
            `<option value="${actions.esc(r.id)}" ${selected === r.id ? 'selected' : ''}>${actions.esc(r.name)}</option>`,
        )
        .join('')
    );
  }
  function appointmentRoomField(a = {}) {
    if (!state.multiUser || !state.workspace.rooms.length) return '';
    if (state.workspace.rooms.filter((r) => r.active).length <= 1)
      return [
        `<input type="hidden" `,
        `name="roomId" `,
        `id="appointment-room" `,
        `value="${actions.esc(appointmentRoomId(a))}">`,
        `<p class="form-hint full" `,
        `id="appointment-room-status" `,
        `aria-live="polite" ${hasProtection() ? '' : 'hidden'}>`,
        `</p>`,
      ].join('');
    return [
      `<label class="field full" `,
      `id="appointment-room-field">Физический кабинет<select name="roomId" `,
      `id="appointment-room" ${hasProtection() ? 'required' : ''}>${roomOptions(a.staffId || actions.accountId(), appointmentRoomId(a))}</select>`,
      `</label>`,
      `<p class="form-hint full" `,
      `id="appointment-room-status" `,
      `aria-live="polite">`,
      `</p>`,
    ].join('');
  }
  function calendarEvents({ forGaps = false, overview = false } = {}) {
    if (!state.workspace.rooms.some((r) => r.active && r.id === state.selectedRoomId))
      state.selectedRoomId = '';
    const records = state.lazyReads
      ? overview && state.calendarOverview
        ? state.calendarOverview
        : state.calendarRecords
      : state.data.flatMap((p) =>
          (p.appointments || []).map((a) => ({
            ...a,
            patientId: p.id,
            patientName: actions.patientNameParts(p).lastFirst,
            patientPhone: p.phone || '',
          })),
        );
    const own = records
      .filter((a) => a.status !== 'cancelled' && a.status !== 'no_show')
      .map((a) => ({ ...a, roomId: appointmentRoomId(a) }));
    const personal = (
      overview && state.calendarPersonalOverview
        ? state.calendarPersonalOverview
        : state.personalEvents || []
    ).map((event) => ({ ...event, kind: 'personal', personal: true }));
    const busy = hasProtection()
      ? state.roomBusy.map((b) => ({ ...b, busy: true, patientName: 'Время занято' }))
      : [];
    return actions
      .filterScheduleCalendarEvents([...own, ...personal, ...busy])
      .filter(
        (a) =>
          !state.selectedRoomId ||
          a.roomId === state.selectedRoomId ||
          ((a.personal || a.kind === 'personal') &&
            state.workspace.rooms
              .find((room) => room.id === state.selectedRoomId)
              ?.staffIds?.includes(a.staffId)) ||
          (forGaps &&
            state.selectedScheduleStaff &&
            !a.busy &&
            (a.staffId || actions.accountId()) === state.selectedScheduleStaff),
      );
  }
  function roomFilterHtml() {
    if (state.workspace.rooms.filter((r) => r.active).length < 2) {
      state.selectedRoomId = '';
      return '';
    }
    return [
      `<div class="calendar-room-filter">`,
      `<label>Физический кабинет<select id="calendar-room-filter">`,
      `<option value="">Все доступные кабинеты</option>${state.workspace.rooms
        .filter((r) => r.active)
        .map(
          (r) =>
            `<option value="${actions.esc(r.id)}" ${r.id === state.selectedRoomId ? 'selected' : ''}>${actions.esc(r.name)}</option>`,
        )
        .join('')}</select>`,
      `</label>${hasProtection() ? '<small>Чужие приёмы — только занятость. Правила пересечений проверяются при сохранении.</small>' : '<small>Защита от пересечений выключена.</small>'}</div>`,
    ].join('');
  }
  function calendarRange() {
    let from = new Date(state.calendarAnchorDate),
      to = new Date(from);
    if (state.calendarMode === 'load') {
      const dates = actions.calendarLoadDates(state.calendarAnchorDate, state.calendarLoadPeriod);
      from = dates[0];
      to = dates.at(-1);
    }
    if (state.calendarMode === 'week') {
      to.setDate(to.getDate() + 6);
    }
    if (state.calendarMode === 'month') {
      from = actions.weekStart(new Date(from.getFullYear(), from.getMonth(), 1));
      to = new Date(from);
      to.setDate(to.getDate() + 41);
    }
    return { from: actions.isoDate(from), to: actions.isoDate(to) };
  }
  async function loadRoomAvailability({ force = false } = {}) {
    if (!state.multiUser || !hasProtection() || state.currentView !== 'calendar') return;
    const period = calendarRange(),
      account = state.account,
      requestScope = JSON.stringify([account?.id, account?.organizationId]),
      key = [
        state.account?.id,
        state.account?.organizationId,
        state.workspace.revision,
        state.revision,
        period.from,
        period.to,
      ].join('|');
    if (!force && state.roomCacheKey === key) return;
    state.roomCacheKey = key;
    const sequence = ++availabilitySequence;
    try {
      const result = await actions.readBackground(
        '/api/workspace/availability?from=' + period.from + '&to=' + period.to,
      );
      if (
        sequence !== availabilitySequence ||
        state.account !== account ||
        state.currentView !== 'calendar' ||
        key !==
          [
            state.account?.id,
            state.account?.organizationId,
            state.workspace.revision,
            state.revision,
            ...Object.values(calendarRange()),
          ].join('|')
      ) {
        if (state.roomCacheKey === key) state.roomCacheKey = '';
        return;
      }
      if (result.revision !== state.workspace.revision) {
        await actions.loadWorkspace();
        if (
          sequence !== availabilitySequence ||
          state.account !== account ||
          requestScope !== JSON.stringify([state.account?.id, state.account?.organizationId]) ||
          state.currentView !== 'calendar' ||
          JSON.stringify(calendarRange()) !== JSON.stringify(period)
        )
          return;
        actions.setView('calendar', { redraw: true });
        return;
      }
      const changed = JSON.stringify(result.busy) !== JSON.stringify(state.roomBusy);
      state.roomBusy = result.busy;
      if (changed) {
        const scroll = actions.$('.time-scroll')?.scrollTop || 0;
        actions.setView('calendar', { redraw: true });
        const grid = actions.$('.time-scroll');
        if (grid) grid.scrollTop = scroll;
      }
    } catch (error) {
      if (sequence === availabilitySequence) {
        state.roomCacheKey = '';
        actions.toast('Не удалось обновить занятость: ' + error.message);
      }
    }
  }
  function bindRoomEvents() {
    document.addEventListener('change', (e) => {
      if (e.target.id === 'calendar-room-filter') {
        state.selectedRoomId = e.target.value;
        actions.setView('calendar');
        return;
      }
      if (e.target.id === 'calendar-grouping') {
        actions.changeCalendarGrouping(e.target.value);
        return;
      }
      if (
        e.target.closest('#editor') &&
        state.editorMode?.kind === 'appointment' &&
        ['staffId', 'roomId', 'date', 'time', 'duration', 'service'].includes(e.target.name)
      )
        void actions.refreshAppointmentRooms({ staffChanged: e.target.name === 'staffId' });
    });
    document.addEventListener(
      'click',
      (e) => {
        if (e.target.closest('.calendar-busy')) {
          e.preventDefault();
          e.stopPropagation();
          actions.toast('Кабинет занят в это время');
        }
      },
      true,
    );
    window.addEventListener('pagehide', () => {
      availabilitySequence++;
    });
  }
  return {
    calendarRange,
    roomsFor,
    roomOptions,
    appointmentOverlapRules,
    appointmentRoomId,
    roomName,
    appointmentRoomField,
    calendarEvents,
    roomFilterHtml,
    loadRoomAvailability,
    bindRoomEvents,
  };
}
