function createCalendarLoadView(state, actions) {
  const icon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path class="load-icon-bar-blue" d="M4 20V10"/><path class="load-icon-bar-purple" d="M12 20V4"/><path class="load-icon-bar-orange" d="M20 20v-7"/></svg>';
  const hours = (minutes) =>
    new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(minutes / 60);
  const percent = (total) =>
    total.capacity ? Math.round((total.booked / total.capacity) * 100) + '%' : '—';
  function calendarLoadButtonHtml() {
    if (!state.multiUser) return '';
    return (
      '<button type="button" class="secondary calendar-load-open" data-calendar-mode="load" aria-pressed="' +
      (state.calendarMode === 'load') +
      '">' +
      icon +
      '<span>Загрузка</span></button>'
    );
  }
  function loadCell(row, cell, date, roomMode) {
    const attributes =
      ' data-load-day="' +
      date +
      '" data-load-entity="' +
      actions.esc(row.id) +
      '" data-load-group="' +
      (roomMode ? 'rooms' : 'staff') +
      '"';
    const personal = cell.personalCount ? ' · личных событий: ' + cell.personalCount : '';
    const hint = actions.esc(
      row.name + ', ' + actions.formatDate(date) + personal + ', открыть день',
    );
    const title =
      cell.status === 'common'
        ? 'Общий выходной'
        : cell.status === 'closed'
          ? 'Выходной'
          : 'График не задан';
    const tone = cell.percent >= 80 ? 'high' : cell.percent >= 50 ? 'medium' : 'low';
    if (state.calendarLoadPeriod === 'month') {
      const value = cell.status === 'working' ? percent(cell) : '—';
      const detail = cell.status === 'working' ? 'Загрузка ' + value : title;
      return (
        '<td><button class="load-cell load-cell-' +
        (cell.status === 'working' ? tone : cell.status) +
        '"' +
        attributes +
        ' aria-label="' +
        hint +
        ', ' +
        actions.esc(detail) +
        '" title="' +
        actions.esc(detail) +
        '"><strong>' +
        value +
        '</strong></button></td>'
      );
    }
    if (cell.status !== 'working') {
      return (
        '<td><button class="load-cell load-cell-' +
        cell.status +
        '"' +
        attributes +
        ' aria-label="' +
        hint +
        '"><strong>' +
        title +
        '</strong><small>' +
        (cell.count || cell.personalCount
          ? cell.count +
            ' ' +
            actions.plural(cell.count, 'запись', 'записи', 'записей') +
            personal +
            ' · занято ' +
            hours(cell.occupied) +
            ' ч'
          : cell.status === 'common'
            ? 'Организация не принимает'
            : cell.status === 'unset'
              ? 'Рабочие часы не заданы'
              : 'Нет рабочих часов') +
        '</small></button></td>'
      );
    }
    return (
      '<td><button class="load-cell load-cell-' +
      tone +
      '"' +
      attributes +
      ' aria-label="' +
      hint +
      '"><span class="load-cell-top"><strong>' +
      (cell.percent === null ? '—' : cell.percent + '%') +
      '</strong><small>' +
      cell.count +
      ' ' +
      actions.plural(cell.count, 'запись', 'записи', 'записей') +
      personal +
      '</small></span><span>Занято ' +
      hours(cell.booked) +
      ' из ' +
      hours(cell.capacity) +
      ' ч</span><meter min="0" max="100" value="' +
      (cell.percent || 0) +
      '">' +
      cell.percent +
      '%</meter><small>Свободно ' +
      hours(cell.free) +
      ' ч' +
      (cell.outside ? ' · вне графика ' + hours(cell.outside) + ' ч' : '') +
      '</small></button></td>'
    );
  }
  function calendarLoadHtml() {
    const model = actions.calendarLoadModel();
    const periodName = { day: 'день', week: 'неделю', month: 'месяц' }[
      state.calendarLoadPeriod || 'week'
    ];
    const label =
      actions.formatDate(model.dates[0]) +
      (model.dates.length > 1 ? ' — ' + actions.formatDate(model.dates.at(-1)) : '') +
      ' · ' +
      actions.cabinetTimeZoneLabel();
    const header =
      '<section class="global-panel calendar-panel calendar-load-panel">' +
      actions.calendarControlsHtml(label);
    if (!model.ready)
      return header + '<p class="settings-loading" role="status">Загрузка графиков…</p></section>';
    const total = model.totals;
    const group = model.canGroup
      ? '<div class="load-group"><button data-load-group="staff" aria-pressed="' +
        !model.roomMode +
        '">Сотрудники</button><button data-load-group="rooms" aria-pressed="' +
        model.roomMode +
        '">Кабинеты</button></div>'
      : '';
    const stats = [
      [
        'Загрузка ' + (model.roomMode ? 'кабинетов' : 'команды'),
        percent(total),
        'По заданным рабочим графикам',
      ],
      [
        'Занято по графику',
        hours(total.booked) + ' ч',
        'Из ' + hours(total.capacity) + ' рабочих часов',
      ],
      ['Свободное время', hours(total.free) + ' ч', 'В пределах рабочих графиков'],
      [
        'Записи за ' + periodName,
        total.count,
        'По ' +
          (model.roomMode ? 'всем кабинетам' : 'всем доступным специалистам') +
          (total.personalCount ? ' · личных событий: ' + total.personalCount : ''),
      ],
    ]
      .map(
        ([title, value, note]) =>
          '<div><span>' +
          title +
          '</span><strong>' +
          value +
          '</strong><small>' +
          note +
          '</small></div>',
      )
      .join('');
    const headings = model.dates
      .map(
        (date) =>
          '<th scope="col"><span>' +
          new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(actions.parseDate(date)) +
          '</span><strong><span class="load-date-full">' +
          actions.formatDate(date) +
          '</span><span class="load-date-short">' +
          new Intl.DateTimeFormat('ru-RU', {
            day: 'numeric',
            ...(state.calendarLoadPeriod === 'month' ? {} : { month: 'short' }),
          }).format(actions.parseDate(date)) +
          '</span></strong></th>',
      )
      .join('');
    const rows = model.rows
      .map(
        (row) =>
          '<tr><th scope="row"><strong>' +
          actions.esc(row.name) +
          '</strong>' +
          (row.role === 'owner' ? '<small>Владелец · ведёт приём</small>' : '') +
          '<small>' +
          hours(row.cells.reduce((n, c) => n + c.booked, 0)) +
          ' из ' +
          hours(row.cells.reduce((n, c) => n + (c.capacity || 0), 0)) +
          ' ч за ' +
          periodName +
          '</small></th>' +
          row.cells.map((cell, i) => loadCell(row, cell, model.dates[i], model.roomMode)).join('') +
          '</tr>',
      )
      .join('');
    const daily = model.daily
      .map(
        (day) =>
          '<td><strong>' +
          percent(day) +
          '</strong>' +
          (state.calendarLoadPeriod === 'month'
            ? ''
            : '<small>' + hours(day.booked) + ' из ' + hours(day.capacity) + ' ч</small>') +
          '</td>',
      )
      .join('');
    const warning = total.unknown
      ? '<p class="load-warning">На часть дней график не задан. Проценты и свободные часы рассчитаны только по заданным графикам.</p>'
      : '';
    const outside = total.outside
      ? '<p class="load-warning">Вне рабочих графиков занято ' +
        hours(total.outside) +
        ' ч. Эти часы показаны отдельно и не увеличивают заполненность рабочих смен.</p>'
      : '';
    return (
      header +
      '<div class="calendar-load-picker">' +
      actions.monthCalendarHtml() +
      '</div><div class="calendar-load-scroll">' +
      group +
      '<div class="load-stats">' +
      stats +
      '</div>' +
      warning +
      outside +
      (model.rows.length
        ? '<div class="load-table-scroll ' +
          (state.calendarLoadPeriod === 'month' ? 'load-table-month' : '') +
          '" style="--load-day-count:' +
          model.dates.length +
          '" tabindex="0" aria-label="Загрузка за ' +
          periodName +
          '"><table class="load-table"><thead><tr><th scope="col">' +
          (model.roomMode ? 'Кабинет' : 'Специалист') +
          '</th>' +
          headings +
          '</tr></thead><tbody>' +
          rows +
          '</tbody><tfoot><tr><th scope="row">' +
          (model.roomMode ? 'Все кабинеты' : 'Вся команда') +
          '</th>' +
          daily +
          '</tr></tfoot></table></div>'
        : '<p>Нет доступных специалистов.</p>') +
      '<div class="load-legend"><span class="low">До 50% — много свободного времени</span><span class="medium">50–79% — средняя загрузка</span><span class="high">От 80% — плотная запись</span></div><p class="form-hint">Нажмите ячейку, чтобы открыть день. Свободные часы специалиста не гарантируют свободный кабинет.</p></div></section>'
    );
  }
  function handleCalendarLoadClick(target) {
    const button = target.closest('[data-load-group]');
    if (!button) return false;
    if (button.dataset.loadDay) {
      state.calendarAnchorDate = actions.parseDate(button.dataset.loadDay);
      state.monthPickerOpen = false;
      state.calendarMode = 'day';
      state.calendarGrouping = button.dataset.loadGroup;
      state.selectedScheduleStaff =
        button.dataset.loadGroup === 'staff' ? button.dataset.loadEntity : '';
      state.selectedRoomId = button.dataset.loadGroup === 'rooms' ? button.dataset.loadEntity : '';
    } else state.calendarLoadGrouping = button.dataset.loadGroup;
    actions.setView('calendar');
    return true;
  }
  return { calendarLoadHtml, calendarLoadButtonHtml, handleCalendarLoadClick };
}
