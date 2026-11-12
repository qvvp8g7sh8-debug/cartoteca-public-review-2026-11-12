function createCalendar(state, actions) {
  const noteIcon =
    '<span class="calendar-event-note" role="img" aria-label="Есть комментарий перед визитом" title="Есть комментарий перед визитом"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4V5a2 2 0 0 1 2-2Z"/><path d="M12 7v5m0 3h.01"/></svg></span>';
  const hasPreVisitNote = (a) =>
    !a.busy &&
    !a.personal &&
    a.kind !== 'personal' &&
    typeof a.notes === 'string' &&
    a.notes.trim().length > 0;
  const calendarMinuteHeight = (grid) =>
    (grid?.querySelector('.time-row')?.getBoundingClientRect().height || 72) / 60;
  function calendarAppointmentAppearance(a, clock = actions.cabinetClock()) {
    if (a.personal || a.kind === 'personal') return { state: 'personal', label: 'Личное' };
    if (a.busy) return { state: 'busy', label: 'Время занято' };
    if (a.status === 'completed') return { state: 'completed', label: '✓ Проведено' };
    if (a.status === 'cancelled') return { state: 'cancelled', label: 'Отменена' };
    if (a.status === 'no_show') return { state: 'no-show', label: 'Не пришёл' };
    // Civil dates/minutes in the cabinet zone, including visits crossing midnight.
    // UTC is only a date arithmetic scale here, never the device's timezone.
    const end =
      Date.parse(a.date + 'T00:00:00Z') +
      (actions.appointmentStart(a) + Math.max(5, Number(a.duration) || 60)) * 60000;
    const now = Date.parse(clock.date + 'T00:00:00Z') + (clock.hour * 60 + clock.minute) * 60000;
    if (Number.isFinite(end) && end <= now)
      return { state: 'unfiled', label: 'Посещение не оформлено' };
    const confirmation = actions.appointmentConfirmationStatus(a);
    return confirmation
      ? { state: 'confirmed', label: confirmation }
      : { state: 'scheduled', label: 'Ждём подтверждения клиента' };
  }
  function calendarEventLabel(a, label) {
    const room = actions.calendarEventPeople(a),
      phone = actions.calendarClientPhone(a);
    return (
      a.time +
      '–' +
      actions.timeLabel(actions.appointmentStart(a) + Math.max(5, Number(a.duration) || 60)) +
      ' ' +
      (a.patientName || phone || 'Имя не указано') +
      ', ' +
      (a.patientName && phone ? phone + ', ' : '') +
      (a.service || 'Запись') +
      ', ' +
      Math.max(5, Number(a.duration) || 60) +
      ' мин' +
      (room ? ', ' + room : '') +
      (a.bookingSource === 'online' ? ', Онлайн-запись' : '') +
      (hasPreVisitNote(a) ? ', Есть комментарий перед визитом' : '') +
      ', ' +
      label
    );
  }
  function calendarDateCaptionHtml() {
    const date = state.calendarAnchorDate;
    const today = actions.cabinetToday() === actions.isoDate(date);
    let full = (today ? 'Сегодня, ' : '') + actions.formatDate(actions.isoDate(date));
    let short =
      (today ? 'Сегодня · ' : '') +
      new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
    if (state.calendarMode === 'load' && state.calendarLoadPeriod !== 'day') {
      const dates = actions.calendarLoadDates(date, state.calendarLoadPeriod);
      full =
        actions.formatDate(actions.isoDate(dates[0])) +
        ' — ' +
        actions.formatDate(actions.isoDate(dates.at(-1)));
      short =
        state.calendarLoadPeriod === 'month'
          ? new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(date)
          : [dates[0], dates.at(-1)]
              .map((day) =>
                new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(day),
              )
              .join(' — ');
    }
    return (
      '<div class="mobile-date-caption calendar-period-caption" aria-label="' +
      actions.esc(full) +
      '"><span class="calendar-caption-full">' +
      actions.esc(full) +
      '</span><span class="calendar-caption-short" aria-hidden="true">' +
      actions.esc(short) +
      '</span></div>'
    );
  }
  function monthCalendarHtml() {
    const year = state.calendarAnchorDate.getFullYear(),
      month = state.calendarAnchorDate.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - offset);
    const events = actions.calendarEvents({ overview: true });
    const cells = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = actions.isoDate(d);
      return [
        `<button class="month-day calendar-day-${actions.scheduleDayKind(iso)} ${d.getMonth() !== month ? 'outside ' : ''}${iso === actions.isoDate(state.calendarAnchorDate) ? 'selected ' : ''}${iso === actions.cabinetToday() ? 'today' : ''}" `,
        `aria-label="${actions.formatDate(iso)}" `,
        `data-calendar-date="${iso}">${d.getDate()}${events.some((a) => a.date === iso) ? '<i></i>' : ''}</button>`,
      ].join('');
    });
    return [
      `<aside id="month-picker" `,
      `class="month-picker ${state.monthPickerOpen ? 'is-open' : ''}">`,
      `<div class="month-heading">`,
      `<button class="calendar-icon-btn" data-month-prev aria-label="Предыдущий месяц">‹</button>`,
      `<strong>${actions.monthTitle(first)}</strong>`,
      `<button class="calendar-icon-btn" data-month-next aria-label="Следующий месяц">›</button>`,
      `</div>`,
      `<div class="month-weekdays">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((x) => `<span>${x}</span>`).join('')}</div>`,
      `<div class="month-grid">${cells.join('')}</div>`,
      `<button class="secondary month-today" data-calendar-today>Сегодня</button>`,
      `</aside>`,
    ].join('');
  }
  function calendarHtml() {
    actions.normalizeCalendarSelection();
    if (state.multiUser && state.calendarMode === 'load') return actions.calendarLoadHtml();
    if (state.calendarMode === 'month' || state.calendarMode === 'list')
      return actions.calendarOverviewHtml();
    const days =
      state.calendarMode === 'day'
        ? [state.calendarAnchorDate]
        : Array.from({ length: 7 }, (_, i) => {
            const date = new Date(state.calendarAnchorDate);
            date.setDate(date.getDate() + i);
            return date;
          });
    const events = actions.calendarEvents();
    const hiddenUntil = actions.calendarHiddenUntil(),
      firstMinute = state.showEarlyHours ? 0 : hiddenUntil;
    const label =
      (state.calendarMode === 'day'
        ? actions.formatDate(actions.isoDate(days[0]))
        : actions.formatDate(actions.isoDate(days[0])) +
          ' — ' +
          actions.formatDate(actions.isoDate(days.at(-1)))) +
      (state.multiUser ? ' · ' + actions.cabinetTimeZoneLabel() : '');
    const earlyCount = events.filter((a) =>
      days.some((d) => {
        const projected =
          a.personal || a.kind === 'personal'
            ? actions.personalCalendarDayEvent(a, actions.isoDate(d))
            : actions.isoDate(d) === a.date
              ? a
              : null;
        return projected && actions.appointmentStart(projected) < hiddenUntil;
      }),
    ).length;
    const earlyLabel =
      (state.showEarlyHours ? 'Свернуть время до ' : 'Показать время до ') +
      actions.timeLabel(hiddenUntil) +
      (!state.showEarlyHours && earlyCount
        ? ' · ' + earlyCount + ' ' + actions.plural(earlyCount, 'запись', 'записи', 'записей')
        : '');
    const early = hiddenUntil
      ? '<div class="early-hours-control"><button type="button" class="secondary" data-toggle-early-hours aria-pressed="' +
        state.showEarlyHours +
        '" aria-label="' +
        actions.esc(earlyLabel) +
        '" title="' +
        actions.esc(earlyLabel) +
        '">' +
        '<span class="early-hours-full">' +
        actions.esc(earlyLabel) +
        '</span>' +
        '<span class="early-hours-short" aria-hidden="true">' +
        (state.showEarlyHours ? 'Скрыть до ' : 'Показать до ') +
        actions.timeLabel(hiddenUntil) +
        (state.showEarlyHours ? ' ↑' : ' ↓') +
        (!state.showEarlyHours && earlyCount ? ' · ' + earlyCount : '') +
        '</span>' +
        '</button></div>'
      : '';
    return (
      '<section class="global-panel calendar-panel">' +
      actions.calendarControlsHtml(label, true) +
      '<div class="calendar-layout"><div class="calendar-sidebar">' +
      actions.monthCalendarHtml() +
      '</div><section class="time-board calendar-entity-board"><div class="calendar-day-tools">' +
      calendarDateCaptionHtml() +
      (state.calendarMode === 'day' ? '' : actions.calendarWorkScheduleHtml()) +
      early +
      '</div>' +
      actions.calendarTimeGridHtml(days, events, firstMinute) +
      '<p class="calendar-hint">Нажмите на свободную клетку: в форме будет выбранный час с шагом 5 минут.</p></section></div></section>'
    );
  }
  function workScheduleButtonHtml() {
    if (!state.multiUser) return '';
    return [
      '<button type="button" class="secondary calendar-work-days" ',
      'data-open-work-schedule aria-label="Рабочие дни и время">',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ',
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '<rect x="3" y="4" width="18" height="17" rx="3"/>',
      '<path d="M7 2v4m10-4v4M3 9h18m-11 6 2 2 4-4"/>',
      '</svg><span>Рабочие дни</span></button>',
    ].join('');
  }
  function calendarControlsHtml(label, captionInGrid = false) {
    const load = state.multiUser && state.calendarMode === 'load';
    const activeMode = load ? state.calendarLoadPeriod || 'week' : state.calendarMode;
    const modes = [
      ['day', 'День'],
      ['week', 'Неделя'],
      ['month', 'Месяц'],
      ['list', 'Список'],
    ].filter(([mode]) => !load || mode !== 'list');
    const date = actions.isoDate(state.calendarAnchorDate);
    const calendarIcon = [
      '<svg viewBox="0 0 24 24" ',
      'fill="none" ',
      'stroke="currentColor" ',
      'stroke-width="1.7" ',
      'stroke-linecap="round" ',
      'stroke-linejoin="round" ',
      'aria-hidden="true">',
      '<rect x="3" ',
      'y="4" ',
      'width="18" ',
      'height="17" ',
      'rx="3"/>',
      '<path d="M7 2v4m10-4v4M3 9h18M7 13h2m3 0h2m3 0h0M7 17h2m3 0h2"/>',
      '</svg>',
    ].join('');
    const strip = Array.from({ length: 15 }, (_, i) => {
      const d = new Date(state.calendarAnchorDate);
      d.setDate(d.getDate() + i - 7);
      const value = actions.isoDate(d),
        weekend = [0, 6].includes(d.getDay());
      return (
        '<button class="date-chip ' +
        'calendar-day-' +
        actions.scheduleDayKind(value) +
        ' ' +
        (weekend ? 'weekend ' : '') +
        (value === date ? 'selected' : '') +
        '" data-calendar-date="' +
        value +
        '" aria-label="' +
        actions.formatDate(value) +
        '" aria-pressed="' +
        (value === date) +
        '"><strong>' +
        d.getDate() +
        ' ' +
        new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(d) +
        '</strong><span>' +
        new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(d) +
        '</span></button>'
      );
    }).join('');
    return (
      [
        '<div class="mobile-calendar-heading">',
        '<button class="mobile-today" data-calendar-today>Сегодня</button>',
        actions.calendarLoadButtonHtml(),
        workScheduleButtonHtml() || '<strong>Записи</strong>',
        '</div>',
      ].join('') +
      '<div class="calendar-toolbar"><div class="calendar-title"><h2>' +
      (load ? 'Загрузка' : 'Календарь') +
      '</h2><p class="global-subtitle">' +
      label +
      [
        '</p>',
        '</div>',
        '<div class="calendar-actions">',
        actions.calendarLoadButtonHtml(),
        '<button class="secondary" data-calendar-prev aria-label="Предыдущий период">‹</button>',
        '<button class="secondary" data-calendar-next aria-label="Следующий период">›</button>',
        '<div class="calendar-mode" ',
        'aria-label="' + (load ? 'Период загрузки' : 'Вид календаря') + '">',
      ].join('') +
      modes
        .map(
          ([value, title]) =>
            '<button class="' +
            (activeMode === value ? 'active ' : '') +
            (!load && ['month', 'list'].includes(value) ? 'mobile-mode' : '') +
            '" ' +
            (load ? 'data-load-period' : 'data-calendar-mode') +
            '="' +
            value +
            '" aria-pressed="' +
            (activeMode === value) +
            '">' +
            title +
            '</button>',
        )
        .join('') +
      [
        '</div>',
        '<div class="calendar-booking-tools">',
        workScheduleButtonHtml(),
        '<button class="primary" ',
        'id="calendar-new" ',
        'aria-label="Новая запись">',
        '<span class="new-record-plus" ',
        'aria-hidden="true">+</span>',
        '<span class="new-record-label"> Новая запись</span>',
        '</button>',
        '</div>',
        '</div>',
        '</div>',
      ].join('') +
      [
        '<div class="mobile-date-navigation">',
        '<button class="date-picker-toggle" data-toggle-month aria-label="Выбрать дату и месяц" ',
        'aria-controls="month-picker" ',
        'aria-expanded="',
      ].join('') +
      state.monthPickerOpen +
      '">' +
      calendarIcon +
      '</button><div class="mobile-date-strip">' +
      strip +
      '</div></div>' +
      actions.calendarSelectionHtml() +
      (captionInGrid ? '' : calendarDateCaptionHtml()) +
      (['day', 'week', 'load'].includes(state.calendarMode)
        ? ''
        : actions.calendarWorkScheduleHtml())
    );
  }
  function agendaEventHtml(a, clock) {
    if (a.personal || a.kind === 'personal') return actions.personalCalendarAgendaHtml(a);
    const room =
      (state.workspace?.rooms || []).filter((r) => r.active).length > 1
        ? actions.roomName(a.roomId)
        : '';
    if (a.busy)
      return (
        '<div class="agenda-event calendar-busy" role="img" aria-label="' +
        actions.esc('Время занято · ' + actions.roomName(a.roomId) + ' · ' + a.time) +
        '"><span class="agenda-time">' +
        actions.esc(a.time) +
        '<small>' +
        actions.timeLabel(actions.appointmentStart(a) + a.duration) +
        '</small></span><span><strong>Время занято</strong>' +
        (room ? '<small>' + actions.esc(room) + '</small>' : '') +
        '</span></div>'
      );
    const phone = actions.calendarClientPhone(a),
      appearance = calendarAppointmentAppearance(a, clock),
      label = calendarEventLabel(a, appearance.label);
    return (
      '<button class="agenda-event appointment-state-' +
      appearance.state +
      '" data-calendar-state="' +
      appearance.state +
      '" data-calendar-note="' +
      (hasPreVisitNote(a) ? 'true' : 'false') +
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
      '"><span class="agenda-time">' +
      actions.esc(a.time) +
      '<small>' +
      actions.timeLabel(actions.appointmentStart(a) + (Number(a.duration) || 60)) +
      '</small></span><span><strong>' +
      actions.esc(a.patientName || phone || 'Имя не указано') +
      '</strong>' +
      (a.patientName && phone
        ? '<small class="agenda-client-phone">' + actions.esc(phone) + '</small>'
        : '') +
      '<span><span data-calendar-status>' +
      actions.esc(appearance.label) +
      ' · </span>' +
      actions.esc(a.service || 'Запись') +
      '</span><small>' +
      (Number(a.duration) || 60) +
      ' мин</small></span>' +
      (hasPreVisitNote(a)
        ? '<span class="agenda-indicators">' +
          noteIcon +
          '<span class="agenda-chevron" aria-hidden="true">›</span></span>'
        : '<span class="agenda-chevron" aria-hidden="true">›</span>') +
      '</button>'
    );
  }
  function calendarOverviewHtml() {
    let content = '';
    const clock = actions.cabinetClock();
    if (state.calendarMode === 'month') {
      const first = new Date(
          state.calendarAnchorDate.getFullYear(),
          state.calendarAnchorDate.getMonth(),
          1,
        ),
        start = actions.weekStart(first);
      const events = actions.calendarEvents({ overview: true });
      const cells = Array.from({ length: 42 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const date = actions.isoDate(d),
          day = events.filter((a) => a.date === date),
          count = day
            .filter((a) => !a.busy && !a.personal && a.kind !== 'personal')
            .reduce((sum, a) => sum + (a.count ?? 1), 0),
          personal = day
            .filter((a) => a.personal || a.kind === 'personal')
            .reduce((sum, a) => sum + (a.count ?? 1), 0),
          busy = day.some((a) => a.busy);
        return (
          '<button class="overview-day ' +
          'calendar-day-' +
          actions.scheduleDayKind(date) +
          ' ' +
          (d.getMonth() !== first.getMonth() ? 'outside ' : '') +
          (date === actions.isoDate(state.calendarAnchorDate) ? 'selected' : '') +
          '" data-overview-date="' +
          date +
          '" aria-label="' +
          actions.formatDate(date) +
          ', записей: ' +
          count +
          (personal ? ', личных событий: ' + personal : '') +
          (busy ? ', есть занятое время' : '') +
          '"><strong>' +
          d.getDate() +
          '</strong>' +
          (count
            ? '<span>' +
              count +
              ' ' +
              actions.plural(count, 'запись', 'записи', 'записей') +
              '</span>'
            : '') +
          (personal
            ? '<small class="month-personal-count">' +
              personal +
              ' ' +
              actions.plural(personal, 'личное', 'личных', 'личных') +
              '</small>'
            : '') +
          (busy ? '<small>Есть занятое время</small>' : '') +
          (actions.scheduleDayLabel(date)
            ? '<small class="calendar-day-work">' +
              actions.esc(actions.scheduleDayLabel(date)) +
              '</small>'
            : '') +
          '</button>'
        );
      }).join('');
      content =
        '<section class="month-overview"><div class="overview-heading"><button class="calendar-icon-btn" data-month-prev aria-label="Предыдущий месяц">‹</button><h3>' +
        actions.monthTitle(first) +
        '</h3><button class="calendar-icon-btn" data-month-next aria-label="Следующий месяц">›</button></div><div class="month-weekdays">' +
        ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => '<span>' + d + '</span>').join('') +
        '</div><div class="overview-grid">' +
        cells +
        '</div></section>';
    } else {
      const date = actions.isoDate(state.calendarAnchorDate);
      const events = actions
        .calendarEvents()
        .filter((a) => a.date === date)
        .sort((a, b) => a.time.localeCompare(b.time));
      content =
        '<section class="appointment-agenda" aria-label="Записи на выбранный день">' +
        (events.length
          ? events.map((a) => agendaEventHtml(a, clock)).join('')
          : '<div class="empty"><h3>На этот день записей нет</h3><p>Нажмите +, чтобы добавить запись.</p></div>') +
        '</section>';
    }
    return (
      '<section class="global-panel calendar-panel overview-panel">' +
      actions.calendarControlsHtml(actions.formatDate(actions.isoDate(state.calendarAnchorDate))) +
      '<div class="calendar-layout">' +
      actions.monthCalendarHtml() +
      content +
      '</div></section>'
    );
  }
  function updateCurrentTime() {
    if (state.currentView !== 'calendar') return;
    const now = actions.cabinetClock(),
      buttons = document.querySelectorAll('[data-calendar-state][data-appointment-id]');
    if (buttons.length) {
      const records = new Map(
        actions
          .calendarEvents()
          .filter((a) => !a.busy)
          .map((a) => [JSON.stringify([a.patientId, a.id]), a]),
      );
      for (const button of buttons) {
        const a = records.get(
          JSON.stringify([button.dataset.calendarPatient, button.dataset.appointmentId]),
        );
        if (!a) continue;
        const appearance = calendarAppointmentAppearance(a, now),
          hasNote = hasPreVisitNote(a);
        if (
          button.dataset.calendarState === appearance.state &&
          button.dataset.calendarSource === (a.bookingSource === 'online' ? 'online' : 'manual') &&
          button.dataset.calendarNote === String(hasNote) &&
          button.querySelector('[data-calendar-status]').textContent === appearance.label + ' · '
        )
          continue;
        button.classList.remove('appointment-state-' + button.dataset.calendarState);
        button.classList.add('appointment-state-' + appearance.state);
        button.dataset.calendarState = appearance.state;
        button.dataset.calendarSource = a.bookingSource === 'online' ? 'online' : 'manual';
        button.dataset.calendarNote = String(hasNote);
        if (button.classList.contains('calendar-event')) {
          button.classList.toggle('calendar-event-has-note', hasNote);
          button.querySelector('.calendar-event-note')?.remove();
          if (hasNote) button.insertAdjacentHTML('beforeend', noteIcon);
        } else {
          button.querySelector('.agenda-indicators, .agenda-chevron')?.remove();
          button.insertAdjacentHTML(
            'beforeend',
            hasNote
              ? '<span class="agenda-indicators">' +
                  noteIcon +
                  '<span class="agenda-chevron" aria-hidden="true">›</span></span>'
              : '<span class="agenda-chevron" aria-hidden="true">›</span>',
          );
        }
        button.querySelector('[data-calendar-status]').textContent = appearance.label + ' · ';
        const label = calendarEventLabel(a, appearance.label);
        button.setAttribute('aria-label', label);
        button.title = label;
      }
    }
    const grid = actions.$('.time-grid[data-dates]');
    if (!grid) return;
    actions.renderCalendarGaps();
    const dates = grid.dataset.dates.split(','),
      index = dates.indexOf(now.date),
      minute = now.hour * 60 + now.minute,
      first = Number(grid.dataset.firstMinute),
      line = grid.querySelector('.current-time');
    line.hidden = index < 0 || minute < first;
    if (line.hidden) return;
    const gutter = grid.querySelector('.time-labels').getBoundingClientRect().width;
    line.style.top = (minute - first) * calendarMinuteHeight(grid) + 'px';
    line.style.left =
      state.calendarMode === 'day'
        ? gutter + 'px'
        : 'calc(' + gutter + 'px + (100% - ' + gutter + 'px) * ' + index / dates.length + ')';
    line.style.width =
      'calc((100% - ' + gutter + 'px) / ' + (state.calendarMode === 'day' ? 1 : dates.length) + ')';
    line.querySelector('span').textContent = actions.timeLabel(minute);
  }
  function appointmentStart(a) {
    const [hour, minute] = String(a.time || '00:00')
      .split(':')
      .map(Number);
    return hour * 60 + minute;
  }
  function layoutAppointments(events) {
    const sorted = events
      .map((a) => ({
        ...a,
        start: actions.appointmentStart(a),
        end: actions.appointmentStart(a) + Math.max(5, Number(a.duration) || 60),
        // Reserve readable lanes for very short cards, not additional occupied time.
        visualEnd: actions.appointmentStart(a) + Math.max(15, Number(a.duration) || 60),
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    let group = [],
      laneEnds = [],
      groupEnd = -1;
    const finish = () => {
      for (const a of group) a.lanes = laneEnds.length;
      group = [];
      laneEnds = [];
    };
    for (const a of sorted) {
      if (a.start >= groupEnd) {
        finish();
        groupEnd = -1;
      }
      let lane = laneEnds.findIndex((end) => end <= a.start);
      if (lane < 0) lane = laneEnds.length;
      a.lane = lane;
      laneEnds[lane] = a.visualEnd;
      group.push(a);
      groupEnd = Math.max(groupEnd, a.visualEnd);
    }
    finish();
    return sorted;
  }
  function positionCalendarEvents() {
    // CSSOM property assignment respects strict style-src; HTML style attributes do not.
    const grid = actions.$('.calendar-entity-grid');
    if (grid) {
      const count = Number(grid.dataset.columnCount) || 1;
      const board = grid.closest('.calendar-entity-board');
      const daily = state.calendarMode === 'day';
      const minimum = daily ? 210 : 170;
      board.style.setProperty('--calendar-column-count', String(count));
      grid.style.minWidth = 52 + count * minimum + 'px';
      board.querySelector('.time-head').style.minWidth = 52 + count * minimum + 'px';
      const weekScroll = state.calendarMode === 'week' && grid.closest('.time-scroll-week');
      if (weekScroll) actions.bindCalendarWeekScroll(weekScroll);
    }
    document.querySelectorAll('.time-slot[data-work-background]').forEach((slot) => {
      slot.style.background = slot.dataset.workBackground;
    });
    const minuteHeight = calendarMinuteHeight(grid);
    document.querySelectorAll('.calendar-event-positioned').forEach((button) => {
      const { offset, minutes, lane, lanes } = button.dataset;
      const actualHeight = Number(minutes) * minuteHeight;
      const top = Number(offset) * minuteHeight;
      const centering =
        button.dataset.cardSize === 'micro' ? Math.max(0, (18 - actualHeight) / 2) : 0;
      const slotMinute = actions.appointmentStart({
        time: button.closest('[data-slot-time]')?.dataset.slotTime || '00:00',
      });
      const lower =
        -Math.max(0, slotMinute - Number(grid?.dataset.firstMinute || 0)) * minuteHeight;
      button.style.top = Math.max(lower, top - centering) + 'px';
      button.style.height = Number(minutes) * minuteHeight + 'px';
      button.style.left = 'calc(' + (Number(lane) * 100) / Number(lanes) + '% + 2px)';
      button.style.width = 'calc(' + 100 / Number(lanes) + '% - 4px)';
    });
    actions.renderCalendarGaps();
  }
  return {
    monthCalendarHtml,
    calendarHtml,
    calendarControlsHtml,
    calendarOverviewHtml,
    calendarAppointmentAppearance,
    updateCurrentTime,
    appointmentStart,
    layoutAppointments,
    positionCalendarEvents,
  };
}
