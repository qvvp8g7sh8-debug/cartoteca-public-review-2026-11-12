function createCalendarGaps(state, actions) {
  const minuteOf = (date) => Date.parse(date + 'T00:00:00Z') / 60000;
  function mergeCalendarRanges(ranges) {
    const result = [];
    for (const [start, end] of ranges
      .map(([a, b]) => [Math.max(0, a), Math.min(1440, b)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((a, b) => a[0] - b[0])) {
      const last = result.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else result.push([start, end]);
    }
    return result;
  }
  function eventCalendarRange(date, event) {
    const start = minuteOf(event.date) - minuteOf(date) + actions.appointmentStart(event);
    return [start, start + Math.max(5, Number(event.duration) || 60)];
  }
  function subtractCalendarRanges(bounds, occupied, lower = 0) {
    const gaps = [];
    for (const [start, end] of bounds) {
      let cursor = Math.max(start, lower);
      for (const [a, b] of occupied) {
        if (b <= cursor || a >= end) continue;
        if (a - cursor >= 15) gaps.push({ start: cursor, end: Math.min(a, end) });
        cursor = Math.max(cursor, b);
        if (cursor >= end) break;
      }
      if (end - cursor >= 15) gaps.push({ start: cursor, end });
    }
    return gaps;
  }
  // Civil arithmetic in the organization zone; never derive hours from the device timezone.
  function calendarFreeGaps(date, events, working, clock, firstMinute = 0) {
    if (date < clock.date) return [];
    const occupied = mergeCalendarRanges(
      events
        .filter((a) => a.busy || !['cancelled', 'no_show'].includes(a.status))
        .map((a) => eventCalendarRange(date, a)),
    );
    // An unset day has no invented opening/closing hours: annotate only gaps between records.
    const bounds =
      working === null
        ? occupied.length > 1
          ? [[occupied[0][0], occupied.at(-1)[1]]]
          : []
        : mergeCalendarRanges(working);
    const now = date === clock.date ? Math.ceil((clock.hour * 60 + clock.minute) / 15) * 15 : 0;
    return subtractCalendarRanges(bounds, occupied, Math.max(firstMinute, now));
  }
  function calendarGapDuration(minutes) {
    const hours = Math.floor(minutes / 60),
      rest = minutes % 60;
    return [hours ? hours + ' ч' : '', rest ? rest + ' мин' : ''].filter(Boolean).join(' ');
  }
  function renderCalendarGaps() {
    if (state.currentView !== 'calendar') return;
    const grid = actions.$('.time-grid[data-dates]');
    if (!grid) return;
    const minuteHeight =
      (grid.querySelector('.time-row')?.getBoundingClientRect().height || 72) / 60;
    const events = actions.calendarEvents({ forGaps: true }),
      clock = actions.cabinetClock();
    const slots = new Map(
      [...grid.querySelectorAll('[data-slot-date]:not([data-calendar-gap])')].map((slot) => [
        (slot.dataset.columnKey || slot.dataset.slotDate) + '|' + slot.dataset.slotTime,
        slot,
      ]),
    );
    const existing = new Map(
      [...grid.querySelectorAll('[data-calendar-gap]')].map((label) => [
        label.dataset.calendarGap,
        label,
      ]),
    );
    const keep = new Set();
    const columns = actions.calendarColumns(
      [...new Set(grid.dataset.dates.split(','))].map(actions.parseDate),
    );
    for (const column of columns) {
      const date = column.date;
      const columnEvents = actions.calendarColumnEvents(events, column, true);
      // Cancelled/no-show cards remain visible, but do not occupy bookable time.
      // Keep the annotation out of those cards without changing the gap duration.
      const inactiveCards = mergeCalendarRanges(
        columnEvents
          .filter((a) => !a.busy && ['cancelled', 'no_show'].includes(a.status))
          .map((a) => eventCalendarRange(date, a)),
      );
      const gaps = calendarFreeGaps(
        date,
        columnEvents,
        actions.calendarWorkingRanges(date, column.staffIds),
        clock,
        Number(grid.dataset.firstMinute),
      );
      for (const gap of gaps) {
        const placement = subtractCalendarRanges([[gap.start, gap.end]], inactiveCards)[0];
        if (!placement) continue;
        const marker = placement.start + Math.min(30, (placement.end - placement.start) / 2);
        const hour = Math.floor(marker / 60) * 60;
        const slot = slots.get(column.key + '|' + actions.timeLabel(hour));
        if (!slot) continue;
        const key = column.key + '|' + gap.start + '|' + gap.end;
        keep.add(key);
        const label = existing.get(key) || document.createElement('button');
        label.type = 'button';
        label.className =
          'calendar-gap' + (placement.end - placement.start < 30 ? ' is-short' : '');
        label.dataset.calendarGap = key;
        label.dataset.columnKey = column.key;
        label.dataset.gapStart = String(gap.start);
        label.dataset.gapEnd = String(gap.end);
        label.dataset.slotDate = date;
        label.dataset.slotTime = actions.timeLabel(gap.start);
        label.dataset.slotStaff = column.staffId || '';
        label.dataset.slotRoom = column.roomId || '';
        label.dataset.gapDuration = String(
          Math.min(60, Math.floor((gap.end - gap.start) / 15) * 15),
        );
        const duration = calendarGapDuration(gap.end - gap.start);
        if (!label.querySelector('.calendar-gap-duration')) {
          const prefix = document.createElement('span'),
            value = document.createElement('span');
          prefix.className = 'calendar-gap-label';
          prefix.textContent = 'Свободно · ';
          value.className = 'calendar-gap-duration';
          label.replaceChildren(prefix, value);
        }
        label.querySelector('.calendar-gap-duration').textContent = duration;
        label.title =
          actions.timeLabel(gap.start) + '–' + actions.timeLabel(gap.end) + ' · ' + duration;
        label.setAttribute('aria-label', 'Записать в свободный промежуток: ' + label.title);
        label.style.top = (marker - hour) * minuteHeight + 'px';
        if (label.parentElement !== slot) slot.append(label);
      }
    }
    for (const [key, label] of existing) if (!keep.has(key)) label.remove();
  }
  return { calendarFreeGaps, calendarGapDuration, renderCalendarGaps };
}
