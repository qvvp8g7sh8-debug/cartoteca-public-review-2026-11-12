// Display only: no requests, mutations, selections or editor lifecycle.
function createWorkScheduleView(state, actions) {
  function staffScheduleLabel(member) {
    const name = member?.displayName || state.roleNames?.[member?.role];
    return name ? 'График сотрудника · ' + name : 'Мой график';
  }
  function workDayLabel(view, date) {
    if (view?.closures?.[date]?.status === 'closed') return 'Общий нерабочий день';
    const day = view?.days?.[date];
    if (day?.status === 'closed') return 'Выходной';
    if (day?.status === 'working') return day.intervals.map((pair) => pair.join('–')).join(', ');
    return 'Не задан';
  }
  function scheduleStaffOptions(view, value, organization = false) {
    const closure =
      organization && actions.accountRole() !== 'cosmetologist'
        ? '<option value="organization">Нерабочие дни организации</option>'
        : '';
    return (
      closure +
      view.members
        .map((member) =>
          [
            `<option value="${actions.esc(member.accountId)}" `,
            `${member.accountId === value ? 'selected' : ''}>`,
            actions.esc(
              organization
                ? staffScheduleLabel(member)
                : member.displayName || state.roleNames[member.role],
            ),
            '</option>',
          ].join(''),
        )
        .join('')
    );
  }
  function workDateCell(view, date, day, selected) {
    const configured = view.days[date];
    const closed = view.closures[date]?.status === 'closed' || configured?.status === 'closed';
    const kind = closed
      ? 'is-closed'
      : configured?.status === 'working'
        ? 'is-working'
        : 'is-unset';
    const label = workDayLabel(view, date);
    return [
      `<button type="button" class="work-day ${kind}" data-work-date="${date}" `,
      `aria-pressed="${selected}" aria-label="`,
      actions.esc(actions.formatDate(date) + ', ' + label),
      `" title="${actions.esc(label)}"><strong>${day}</strong><small>`,
      closed ? 'Вых.' : configured?.status === 'working' ? 'Раб.' : '—',
      '</small></button>',
    ].join('');
  }
  function workScheduleMonthHtml(view, month, dates) {
    const selected = new Set(dates),
      staff = view.staffId;
    const [year, number] = month.split('-').map(Number),
      first = new Date(year, number - 1, 1);
    const count = new Date(year, number, 0).getDate(),
      offset = (first.getDay() + 6) % 7;
    const cells = Array.from({ length: offset }, () => '<span aria-hidden="true"></span>');
    for (let day = 1; day <= count; day++) {
      const date = month + '-' + String(day).padStart(2, '0');
      cells.push(workDateCell(view, date, day, selected.has(date)));
    }
    const employee = view.members.find((m) => m.accountId === staff);
    const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
      .map((name, index) =>
        [
          `<button type="button" data-work-weekday="${index}" `,
          `title="Выбрать ${name} только в этом месяце">${name}</button>`,
        ].join(''),
      )
      .join('');
    const permission =
      view.canManagePermission && employee?.role === 'cosmetologist'
        ? [
            '<label class="work-permission"><input type="checkbox" id="work-schedule-permission" ',
            view.allowSelfEdit ? 'checked' : '',
            '>Сотрудник может изменять свой график</label>',
          ].join('')
        : '';
    const calendarHours = Array.from({ length: 24 }, (_, hour) => {
      const value = String(hour).padStart(2, '0') + ':00';
      return `<option value="${value}" ${value === view.calendarHiddenUntil ? 'selected' : ''}>${value}</option>`;
    }).join('');
    const calendarSetting = view.canManageCalendar
      ? [
          '<label class="field work-calendar-start">Вид календаря · скрывать часы до',
          `<select id="calendar-hidden-until">${calendarHours}</select>`,
          '<small>Для всех сотрудников организации. Меняется только вид календаря, не рабочий график. 00:00 — показывать весь день.</small></label>',
        ].join('')
      : `<p class="form-hint">Календарь по умолчанию показан с ${actions.esc(view.calendarHiddenUntil)}.</p>`;
    const single = view.members.length <= 1;
    const organization = staff === 'organization';
    const person = view.members[0];
    return [
      `<div class="work-schedule-toolbar"><label class="field" ${single ? 'hidden' : ''}><span class="work-scope-label ${organization ? 'work-scope-organization' : 'work-scope-staff'}">${organization ? 'Нерабочие дни организации' : 'График сотрудника'}</span>`,
      `<select id="work-schedule-staff">${scheduleStaffOptions(view, staff, true)}</select></label>`,
      single
        ? [
            `<div class="work-schedule-person"><strong${organization ? ' class="work-scope-label work-scope-organization"' : ''}>`,
            actions.esc(organization ? 'Нерабочие дни организации' : staffScheduleLabel(person)),
            '</strong>',
            person && actions.accountRole() !== 'cosmetologist'
              ? `<button type="button" class="text-btn work-scope-label ${organization ? 'work-scope-staff' : 'work-scope-organization'}" data-work-scope="${actions.esc(organization ? person.accountId : 'organization')}">${organization ? actions.esc(staffScheduleLabel(person)) : 'Нерабочие дни организации'}</button>`
              : '',
            '</div>',
          ].join('')
        : '',
      '<div class="work-month-nav">',
      '<button class="secondary" data-work-month="-1" aria-label="Предыдущий месяц">‹</button>',
      `<strong>${actions.esc(actions.monthTitle(first))}</strong>`,
      '<button class="secondary" data-work-month="1" aria-label="Следующий месяц">›</button>',
      '</div></div>',
      organization
        ? '<p class="form-hint">Общие нерабочие дни — праздники, ремонт или другие даты, когда организация не принимает. Личные графики сотрудников и уже созданные записи сохраняются.</p>'
        : '',
      '<div class="work-selection"><span>',
      selected.size ? 'Выбрано дат: ' + selected.size : 'Выберите даты в календаре',
      `</span><button class="secondary" data-work-clear ${selected.size ? '' : 'disabled'}>Снять выбор</button>`,
      `<button class="primary" data-work-edit ${selected.size && view.canEdit ? '' : 'disabled'}>Настроить дни</button></div>`,
      selected.size === 1
        ? '<p class="work-date-info">' +
          actions.esc(actions.formatDate(dates[0]) + ' · ' + workDayLabel(view, dates[0])) +
          '</p>'
        : '',
      '<div class="work-schedule-layout"><div class="work-schedule-calendar">',
      '<p class="form-hint">Нажмите Пн–Вс, чтобы выбрать все такие дни только в этом месяце.</p>',
      `<div class="work-weekdays">${weekdays}</div>`,
      `<div class="work-month-grid">${cells.join('')}</div>`,
      '<div class="work-legend"><span class="is-working">Рабочий</span>',
      '<span class="is-closed">Выходной</span><span>— Не задан</span></div>',
      '</div><aside class="work-schedule-selection" aria-label="Вид календаря и помощь">',
      `<p class="form-hint">Время организации · ${actions.esc(actions.cabinetTimeZoneLabel())}</p>`,
      '<details class="work-schedule-help"><summary>Как настроить график</summary><p>Выберите даты и нажмите «Настроить дни». Можно задать рабочие часы, выходной или снять настройку.</p>',
      '<p>Перерывы задаются несколькими интервалами. График не повторяется автоматически.</p>',
      '<p>Не задан — не выходной: ручная запись доступна. Изменение графика не отменяет существующие записи.</p></details>',
      !view.canEdit ? '<p class="form-hint">Владелец отключил изменение вашего графика.</p>' : '',
      permission,
      calendarSetting,
      '</aside></div>',
    ].join('');
  }
  return { workDayLabel, scheduleStaffOptions, workScheduleMonthHtml };
}
