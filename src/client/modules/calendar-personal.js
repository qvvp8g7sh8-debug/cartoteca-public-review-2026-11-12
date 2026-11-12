// Personal time belongs to a specialist, without a client, service or physical room.
function createCalendarPersonal(state, actions) {
  function personalCalendarDayEvent(event, date) {
    const start =
      (Date.parse(event.date + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 60000 +
      actions.appointmentStart(event);
    const end = start + Math.min(1440, Math.max(5, Number(event.duration) || 60));
    if (!Number.isFinite(start) || end <= 0 || start >= 1440) return null;
    const first = Math.max(0, start);
    return {
      ...event,
      date,
      time: actions.timeLabel(first),
      duration: Math.min(1440, end) - first,
      personalContinuation: start < 0,
    };
  }
  function personalCalendarLabel(event) {
    const duration = Math.max(5, Number(event.duration) || 60);
    const end = actions.appointmentStart(event) + duration;
    const time =
      event.time +
      '–' +
      actions.timeLabel(end > 1440 ? end % 1440 : end) +
      (end > 1440 ? ' (следующий день)' : '');
    const staff = state.multiUser ? actions.calendarStaffName(event.staffId) : '';
    return [
      time,
      'Личное',
      event.personalContinuation ? 'продолжение' : '',
      event.notes || '',
      duration + ' мин',
      staff,
    ]
      .filter(Boolean)
      .join(', ');
  }
  function personalCalendarCardHtml(event, position, column) {
    const duration = Math.max(5, Number(event.duration) || 60);
    const time = event.time + '–' + actions.timeLabel(event.end);
    const label = actions.esc(personalCalendarLabel(event));
    const staff =
      state.multiUser && !column.staffId ? actions.calendarStaffName(event.staffId) : '';
    return [
      '<button type="button" class="calendar-event calendar-event-positioned calendar-personal" ',
      'data-personal-event-id="',
      actions.esc(event.id),
      '" aria-label="',
      label,
      '" title="',
      label,
      '"',
      position,
      '><span class="calendar-event-start" aria-hidden="true">',
      actions.esc(event.time),
      '</span><small class="calendar-event-time">',
      actions.esc(time),
      '<span class="calendar-event-duration">',
      duration,
      ' мин</span></small><strong>',
      actions.esc(event.notes || 'Личное'),
      '</strong><span class="calendar-event-short-duration" aria-hidden="true">',
      duration,
      ' мин</span>',
      event.notes || event.personalContinuation
        ? '<small class="calendar-event-service">Личное' +
          (event.personalContinuation ? ' · продолжение' : '') +
          '</small>'
        : '',
      staff ? '<small class="calendar-event-context">' + actions.esc(staff) + '</small>' : '',
      '</button>',
    ].join('');
  }
  function personalCalendarAgendaHtml(event) {
    const duration = Math.max(5, Number(event.duration) || 60);
    const end = actions.appointmentStart(event) + duration;
    const label = actions.esc(personalCalendarLabel(event));
    const staff = state.multiUser ? actions.calendarStaffName(event.staffId) : '';
    return [
      '<button type="button" class="agenda-event calendar-personal" data-personal-event-id="',
      actions.esc(event.id),
      '" aria-label="',
      label,
      '" title="',
      label,
      '"><span class="agenda-time">',
      actions.esc(event.time),
      '<small>',
      actions.timeLabel(end > 1440 ? end % 1440 : end),
      '</small></span><span><strong>',
      actions.esc(event.notes || 'Личное'),
      '</strong>',
      event.notes ? '<span>Личное</span>' : '',
      '<small>',
      duration,
      ' мин',
      staff ? ' · ' + actions.esc(staff) : '',
      '</small></span><span class="agenda-chevron" aria-hidden="true">›</span></button>',
    ].join('');
  }
  return { personalCalendarDayEvent, personalCalendarCardHtml, personalCalendarAgendaHtml };
}
