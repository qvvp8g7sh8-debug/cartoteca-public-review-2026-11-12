// Build an overview from already authorized calendar and schedule responses, ignoring personal filters.
function createCalendarLoadData(state, actions) {
  function calendarLoadModel() {
    const schedule = actions.calendarLoadSchedule();
    const dates = actions
      .calendarLoadDates(state.calendarAnchorDate, state.calendarLoadPeriod)
      .map((day) => actions.isoDate(day));
    const members = actions.calendarScheduleMembers();
    const rooms = state.workspace.rooms.filter((r) => r.active);
    const roomMode =
      rooms.length > 1 &&
      actions.accountRole() !== 'cosmetologist' &&
      (state.calendarLoadGrouping === 'rooms' || members.length <= 1);
    const records = [
      ...(state.lazyReads
        ? state.calendarRecords
        : state.data.flatMap((p) => p.appointments || [])),
      ...(roomMode
        ? []
        : (state.personalEvents || []).map((event) => ({ ...event, personal: true }))),
    ];
    const ownerId = members.find((m) => m.role === 'owner')?.accountId || actions.accountId();
    const byEntity = new Map();
    for (const a of records) {
      if (a.busy || ['cancelled', 'no_show'].includes(a.status)) continue;
      const staffId = a.staffId || ownerId;
      if (!members.some((m) => m.accountId === staffId)) continue;
      const assigned =
        roomMode && !a.roomId ? rooms.filter((r) => r.staffIds?.includes(staffId)) : [];
      const key = roomMode ? a.roomId || (assigned.length === 1 ? assigned[0].id : '') : staffId;
      if (!byEntity.has(key)) byEntity.set(key, []);
      byEntity.get(key).push(a);
    }
    const ready =
      actions.calendarRecordsReady() &&
      schedule &&
      schedule.from <= dates[0] &&
      schedule.to >= dates.at(-1);
    const entities = roomMode ? rooms : members;
    const rows = entities.map((entity) => {
      const id = roomMode ? entity.id : entity.accountId;
      const staffIds = roomMode
        ? (entity.staffIds || []).filter((id) => members.some((m) => m.accountId === id))
        : [id];
      const cells = dates.map((date) => {
        const days = staffIds.map(
          (id) =>
            schedule?.staffDays?.[id]?.[date] ||
            (schedule?.staffId === id ? schedule.days[date] : null),
        );
        const day =
          !days.length || days.some((d) => !d || d.status === 'unset')
            ? null
            : days.some((d) => d.status === 'working')
              ? {
                  status: 'working',
                  intervals: days.flatMap((d) => (d.status === 'working' ? d.intervals : [])),
                }
              : { status: 'closed' };
        const records = byEntity.get(id) || [];
        const cell = actions.calendarLoadDay(
          date,
          day,
          records,
          schedule?.closures?.[date]?.status === 'closed',
        );
        const personal = records.filter((event) => event.personal || event.kind === 'personal');
        if (!personal.length) return { ...cell, personalCount: 0, personalIds: [] };
        const appointments = actions.calendarLoadDay(
          date,
          day,
          records.filter((event) => !event.personal && event.kind !== 'personal'),
          schedule?.closures?.[date]?.status === 'closed',
        );
        const reserved = actions.calendarLoadDay(date, day, personal);
        return {
          ...cell,
          count: appointments.count,
          ids: appointments.ids,
          personalCount: reserved.count,
          personalIds: reserved.ids,
        };
      });
      return {
        id,
        name: roomMode ? entity.name : entity.displayName || 'Сотрудник',
        role: entity.role,
        cells,
      };
    });
    const summarize = (cells) => ({
      capacity: cells.reduce((n, c) => n + (c.capacity || 0), 0),
      booked: cells.reduce((n, c) => n + c.booked, 0),
      free: cells.reduce((n, c) => n + (c.free || 0), 0),
      count: new Set(cells.flatMap((c) => c.ids)).size,
      personalCount: new Set(cells.flatMap((c) => c.personalIds)).size,
      unknown: cells.filter((c) => c.status === 'unset').length,
      outside: cells.reduce((n, c) => n + c.outside, 0),
    });
    return {
      ready,
      dates,
      rows,
      roomMode,
      canGroup: rooms.length > 1 && members.length > 1 && actions.accountRole() !== 'cosmetologist',
      totals: summarize(rows.flatMap((r) => r.cells)),
      daily: dates.map((_, i) => summarize(rows.map((r) => r.cells[i]))),
    };
  }
  return { calendarLoadModel };
}
