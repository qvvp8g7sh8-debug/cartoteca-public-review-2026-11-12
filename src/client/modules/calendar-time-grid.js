// Hour grid shared by daily employee/room columns and a single entity's rolling week.
function createCalendarTimeGrid(state, actions) {
  const noteIcon =
    '<span class="calendar-event-note" role="img" aria-label="Есть комментарий перед визитом" title="Есть комментарий перед визитом"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4V5a2 2 0 0 1 2-2Z"/><path d="M12 7v5m0 3h.01"/></svg></span>';
  function calendarClientPhone(a) {
    if (a?.busy || a?.personal || a?.kind === 'personal') return '';
    const raw = String(a?.patientPhone || '').trim(),
      digits = raw.replace(/\D/g, ''),
      number =
        digits.length === 10
          ? '7' + digits
          : digits.length === 11 && /^[78]/.test(digits)
            ? '7' + digits.slice(1)
            : '';
    return number
      ? `+7 (${number.slice(1, 4)}) ${number.slice(4, 7)}-${number.slice(7, 9)}-${number.slice(9)}`
      : raw;
  }
  function calendarEventPeople(a) {
    if (!state.multiUser || a.busy) return '';
    return [
      actions.calendarStaffName(a.staffId || actions.accountId()),
      a.personal || a.kind === 'personal' ? '' : actions.roomName(a.roomId),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  function calendarEventCard(a, minute, firstMinute, clock, column) {
    const start = Math.max(a.start, firstMinute),
      end = Math.min(a.end, 1440),
      duration = Math.max(5, Number(a.duration) || 60);
    const position =
      ' data-card-size="' +
      (duration < 15
        ? 'micro'
        : end - start < 30
          ? 'tiny'
          : end - start < 45
            ? 'short'
            : end - start < 60
              ? 'regular'
              : 'roomy') +
      '" data-offset="' +
      (start - minute) +
      '" data-minutes="' +
      (end - start) +
      '" data-lane="' +
      a.lane +
      '" data-lanes="' +
      a.lanes +
      '"';
    const time = a.time + '–' + actions.timeLabel(a.end);
    if (a.personal || a.kind === 'personal')
      return actions.personalCalendarCardHtml(a, position, column);
    const room =
      a.roomId &&
      !column.roomId &&
      (state.workspace?.rooms || []).filter((r) => r.active).length > 1
        ? actions.roomName(a.roomId)
        : '';
    if (a.busy) {
      const label =
        'Время занято · ' + actions.roomName(a.roomId) + ' · ' + time + ' · ' + duration + ' мин';
      return (
        '<div class="calendar-event calendar-event-positioned calendar-busy" role="img" aria-label="' +
        actions.esc(label) +
        '" title="' +
        actions.esc(label) +
        '"' +
        position +
        '><span class="calendar-event-start" aria-hidden="true">' +
        actions.esc(a.time) +
        '</span><small class="calendar-event-time">' +
        actions.esc(time) +
        '<span class="calendar-event-duration">' +
        duration +
        ' мин</span>' +
        '</small><strong>Время занято</strong><span class="calendar-event-short-duration" aria-hidden="true">' +
        duration +
        ' мин</span>' +
        (room ? '<small class="calendar-event-context">' + actions.esc(room) + '</small>' : '') +
        '</div>'
      );
    }
    const phone = calendarClientPhone(a),
      name = a.patientName || phone || 'Имя не указано',
      appearance = actions.calendarAppointmentAppearance(a, clock),
      people = calendarEventPeople(a);
    const staff =
      state.multiUser && !column.staffId
        ? actions.calendarStaffName(a.staffId || actions.accountId())
        : '';
    const context = [staff, room].filter(Boolean).join(' · ');
    const hasNote =
      !a.busy &&
      !a.personal &&
      a.kind !== 'personal' &&
      typeof a.notes === 'string' &&
      a.notes.trim().length > 0;
    const label = [
      time,
      duration + ' мин',
      name,
      a.patientName ? phone : '',
      a.service || 'Запись',
      people,
      a.bookingSource === 'online' ? 'Онлайн-запись' : '',
      appearance.label,
      hasNote ? 'Есть комментарий перед визитом' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return (
      '<button class="calendar-event calendar-event-positioned appointment-state-' +
      appearance.state +
      (hasNote ? ' calendar-event-has-note' : '') +
      '" data-calendar-state="' +
      appearance.state +
      '" data-calendar-note="' +
      (hasNote ? 'true' : 'false') +
      '" data-calendar-source="' +
      (a.bookingSource === 'online' ? 'online' : 'manual') +
      '" data-calendar-patient="' +
      actions.esc(a.patientId) +
      '" data-appointment-id="' +
      actions.esc(a.id) +
      '" aria-label="' +
      actions.esc(label) +
      '" title="' +
      actions.esc(label) +
      '"' +
      position +
      '><span class="calendar-event-start" aria-hidden="true">' +
      actions.esc(a.time) +
      '</span><small class="calendar-event-time">' +
      actions.esc(time) +
      '<span class="calendar-event-duration">' +
      duration +
      ' мин</span>' +
      '</small><strong>' +
      actions.esc(name) +
      '</strong><span class="calendar-event-short-duration" aria-hidden="true">' +
      duration +
      ' мин</span>' +
      (a.patientName && duration >= 30 && /^(?=.*\d)[+\d()\s.-]{6,24}$/.test(phone)
        ? '<small class="calendar-event-phone">' + actions.esc(phone) + '</small>'
        : '') +
      '<small class="calendar-event-service">' +
      actions.esc(a.service || 'Запись') +
      '</small>' +
      (context
        ? '<small class="calendar-event-context">' + actions.esc(context) + '</small>'
        : '') +
      '<small class="calendar-event-status" data-calendar-status hidden>' +
      actions.esc(appearance.label) +
      ' · </small>' +
      (hasNote ? noteIcon : '') +
      '</button>'
    );
  }
  function calendarTimeGridHtml(days, events, firstMinute) {
    const columns = actions.calendarColumns(days),
      clock = actions.cabinetClock();
    const daily = state.multiUser && state.calendarMode === 'day';
    const laidOut = columns.map((column) =>
      actions.layoutAppointments(actions.calendarColumnEvents(events, column)),
    );
    const headings = columns
      .map((column) => {
        const date = actions.parseDate(column.date);
        const label = daily
          ? column.title
          : new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(date);
        const caption = daily
          ? actions.scheduleDayLabel(column.date, column.staffIds) || 'График не задан'
          : date.getDate() +
            ' ' +
            new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(date);
        return (
          '<div class="time-day-heading calendar-day-' +
          actions.scheduleDayKind(column.date, column.staffIds) +
          '"><strong>' +
          actions.esc(label) +
          '</strong><span>' +
          actions.esc(caption) +
          '</span></div>'
        );
      })
      .join('');
    const slots = Array.from({ length: (1440 - firstMinute) / 60 }, (_, i) => firstMinute + i * 60);
    const rows = slots
      .map(
        (minute) =>
          '<div class="time-row">' +
          columns
            .map(
              (column, index) =>
                '<div class="time-slot" data-column-key="' +
                column.key +
                '" data-slot-staff="' +
                actions.esc(column.staffId || '') +
                '" data-slot-room="' +
                actions.esc(column.roomId || '') +
                '" data-slot-date="' +
                column.date +
                '" data-slot-time="' +
                actions.timeLabel(minute) +
                '" data-work-background="' +
                actions.esc(actions.scheduleSlotStyle(column.date, minute, column.staffIds)) +
                '">' +
                laidOut[index]
                  .filter(
                    (a) =>
                      a.end > firstMinute &&
                      Math.floor(Math.max(a.start, firstMinute) / 60) * 60 === minute,
                  )
                  .map((a) => calendarEventCard(a, minute, firstMinute, clock, column))
                  .join('') +
                '</div>',
            )
            .join('') +
          '</div>',
      )
      .join('');
    return (
      '<div class="time-scroll' +
      (state.calendarMode === 'week' ? ' time-scroll-week' : '') +
      '"><div class="time-head"><div class="time-corner"></div><div class="time-columns">' +
      headings +
      '</div></div><div class="time-body"><div class="time-grid calendar-entity-grid" data-column-count="' +
      columns.length +
      '" data-dates="' +
      columns.map((c) => c.date).join(',') +
      '" data-first-minute="' +
      firstMinute +
      '"><div class="time-labels">' +
      slots.map((minute) => '<div>' + actions.timeLabel(minute) + '</div>').join('') +
      '</div><div class="time-columns-body">' +
      rows +
      '</div><div class="current-time" hidden><span></span></div></div></div></div>'
    );
  }
  return { calendarTimeGridHtml, calendarEventPeople, calendarClientPhone };
}
