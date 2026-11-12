function createWorkScheduleEditor(state, actions) {
  let draft = null,
    intervalDraft = [],
    hintSequence = 0;
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  function timeOptions(maximum, selected, placeholder, step = 1) {
    return (
      (placeholder
        ? `<option value="" disabled ${selected ? '' : 'selected'}>${placeholder}</option>`
        : '') +
      Array.from({ length: maximum + 1 }, (_, i) => i)
        .filter((i) => i % step === 0 || String(i).padStart(2, '0') === selected)
        .map((i) => {
          const value = String(i).padStart(2, '0');
          return `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`;
        })
        .join('')
    );
  }
  function timeField(value, index, endpoint, label) {
    const [hour = '', minute = '00'] = value.split(':');
    const title = endpoint === 'start' ? 'начала' : 'окончания';
    return [
      `<div class="field work-time-field"><span>${label}</span><div class="work-time-select" data-work-time>`,
      `<select data-work-hour aria-label="Часы ${title} интервала ${index + 1}" required>`,
      timeOptions(endpoint === 'end' ? 24 : 23, hour, '—'),
      '</select><span aria-hidden="true">:</span>',
      `<select data-work-minute aria-label="Минуты ${title} интервала ${index + 1}" ${hour === '24' ? 'disabled' : ''} required>`,
      timeOptions(59, minute, '', 15),
      '</select>',
      `<input type="hidden" data-work-${endpoint}="${index}" value="${actions.esc(value)}">`,
      '</div></div>',
    ].join('');
  }
  function intervalRow(pair, index) {
    return [
      '<div class="work-interval">',
      timeField(pair[0], index, 'start', 'С'),
      timeField(pair[1], index, 'end', 'До'),
      `<button type="button" class="secondary" data-work-remove="${index}" `,
      `aria-label="Удалить рабочий интервал" ${intervalDraft.length === 1 ? 'disabled' : ''}>`,
      '×</button></div>',
    ].join('');
  }
  function readIntervals() {
    return [...document.querySelectorAll('[data-work-start]')].map((input) => [
      input.value,
      actions.$(`[data-work-end="${input.dataset.workStart}"]`).value,
    ]);
  }
  function renderWorkIntervals() {
    const root = actions.$('#work-intervals');
    if (!root) return;
    const working = actions.$('#work-day-status').value === 'working';
    root.hidden = !working;
    root.innerHTML =
      intervalDraft.map(intervalRow).join('') +
      `<button type="button" class="secondary" data-work-add ${intervalDraft.length >= 8 ? 'disabled' : ''}>+ Рабочий интервал</button><p class="form-hint">Промежутки между интервалами — перерывы. 24:00 означает конец дня.</p>`;
    root.querySelectorAll('input,select').forEach((input) => {
      input.disabled =
        !working ||
        (input.hasAttribute('data-work-minute') &&
          input.closest('[data-work-time]').querySelector('[data-work-hour]').value === '24');
    });
    if (actions.$('#editor')?.open) actions.mountAppointmentTimePicker?.();
  }
  function openWorkScheduleEditor() {
    draft = actions.scheduleEditorContext();
    if (!draft) return;
    intervalDraft = draft.day?.intervals?.length
      ? structuredClone(draft.day.intervals)
      : [['08:00', '20:00']];
    state.editorMode = { kind: 'workSchedule' };
    const organization = draft.staffId === 'organization';
    actions.$('#dialog-title').textContent =
      draft.dates.length === 1
        ? (organization ? 'Нерабочий день организации · ' : 'График · ') +
          actions.formatDate(draft.dates[0])
        : (organization ? 'Нерабочие дни организации · дат: ' : 'График · выбранных дат: ') +
          draft.dates.length;
    actions.$('#form-content').innerHTML = [
      '<div class="form-grid visit-form-grid work-schedule-form"><label class="field full">',
      organization ? 'Общие нерабочие дни' : 'Выбранные дни',
      '<select name="status" id="work-day-status">',
      !organization ? '<option value="working">Рабочий день</option>' : '',
      `<option value="closed">${organization ? 'Нерабочий день для всей организации' : 'Выходной'}</option>`,
      `<option value="reset">${organization ? 'Снять общий нерабочий день' : 'Снять настройку дня'}</option>`,
      '</select></label><div class="full" id="work-intervals"></div></div>',
      `<p class="form-hint">${actions.esc(actions.cabinetTimeZoneLabel())}. `,
      'Изменения применяются только к выбранным датам; существующие записи сохраняются.</p>',
    ].join('');
    actions.$('#work-day-status').value =
      draft.day?.status || (organization ? 'closed' : 'working');
    renderWorkIntervals();
    actions.openDialog();
  }
  async function postWorkSchedule(body) {
    try {
      return await actions.request('/api/work-schedules', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (!error.outcomeUnknown || !draft || draft.scope !== scope()) throw error;
      // No automatic write retry: verify the date-scoped authoritative result.
      const latest = await actions.request(
        '/api/work-schedules?staffId=' +
          encodeURIComponent(body.staffId) +
          '&from=' +
          body.dates[0] +
          '&to=' +
          body.dates.at(-1),
      );
      if (!draft || draft.scope !== scope()) throw error;
      const expected =
        body.status === 'reset'
          ? null
          : {
              status: body.status,
              intervals:
                body.status === 'working'
                  ? [...body.intervals].sort((a, b) => a[0].localeCompare(b[0]))
                  : [],
            };
      if (
        latest.revision === body.revision + 1 &&
        latest.timeZone === body.expectedTimeZone &&
        body.dates.every(
          (date) => JSON.stringify(latest.days[date] || null) === JSON.stringify(expected),
        )
      )
        return { saved: true, revision: latest.revision };
      throw new Error(
        'Результат сохранения графика не подтверждён. Закройте форму и откройте график заново перед повторной отправкой.',
      );
    }
  }
  async function saveWorkScheduleForm(values) {
    if (!draft || draft.scope !== scope())
      throw new Error('Аккаунт изменился. Откройте график заново.');
    const body = {
      staffId: draft.staffId,
      dates: draft.dates,
      revision: draft.revision,
      expectedTimeZone: draft.expectedTimeZone,
      status: values.status,
      intervals: values.status === 'working' ? readIntervals() : [],
    };
    if (
      body.dates.length > 1 &&
      !(await actions.confirmAction(
        'Применить график к выбранным датам?',
        `Дат: ${body.dates.length}\nС ${actions.formatDate(body.dates[0])} по ${actions.formatDate(body.dates.at(-1))}\n` +
          (body.status === 'working'
            ? 'Рабочие интервалы: ' + body.intervals.map((pair) => pair.join('–')).join(', ')
            : body.status === 'closed'
              ? 'Отметить выходными.'
              : 'Снять настройки выбранных дней.') +
          '\nАвтоматическое повторение не включается. Существующие записи сохраняются.',
        'Применить график',
        'Вернуться к графику',
      ))
    )
      return;
    if (!draft || draft.scope !== scope())
      throw new Error('Аккаунт изменился. Откройте график заново.');
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await postWorkSchedule(body);
      if (draft.scope !== scope()) throw new Error('Аккаунт изменился. Откройте график заново.');
      if (!result.requiresConfirmation) break;
      if (
        !(await actions.confirmAction(
          'Есть записи вне нового графика',
          `Изменение затрагивает записей: ${result.conflictCount}. Они останутся в календаре без изменений, вне нового графика. Сохранить график?`,
          'Сохранить график',
          'Вернуться к графику',
        ))
      )
        return;
      body.confirmation = result.confirmation;
    }
    if (!result?.saved)
      throw new Error('Записи изменились во время настройки. Повторите сохранение после проверки.');
    draft = null;
    actions.closeEditor();
    await actions.loadWorkSchedules();
    void actions.loadCalendarSchedule({ force: true });
    void actions.refreshBookingHealth({ force: true });
    actions.toast('Рабочие дни сохранены');
  }
  async function confirmAppointmentWorkSchedule(appointment) {
    if (!state.multiUser) return '';
    const key = scope(),
      editor = state.editorMode;
    const result = await actions.request('/api/work-schedules/check', {
      method: 'POST',
      body: JSON.stringify({
        staffId: appointment.staffId || actions.accountId(),
        date: appointment.date,
        time: appointment.time,
        duration: appointment.duration,
      }),
    });
    if (key !== scope() || state.editorMode !== editor)
      throw new Error('Форма или аккаунт изменились. Откройте запись заново.');
    if (!result.warning) return '';
    if (!result.canOverride) throw new Error(result.warning + ' Обратитесь к администратору.');
    const accepted = await actions.confirmAction(
      'Запись вне графика',
      result.warning + '\nСохранить запись? Запрет параллельных записей остаётся в силе.',
      'Сохранить запись',
      'Изменить время',
      { preferCancel: true },
    );
    if (key !== scope() || state.editorMode !== editor)
      throw new Error('Форма или аккаунт изменились. Откройте запись заново.');
    return accepted ? result.acknowledgement : false;
  }
  async function refreshAppointmentSchedule() {
    const root = actions.$('#appointment-work-schedule');
    if (!state.multiUser || !root || state.editorMode?.kind !== 'appointment') return;
    const id = ++hintSequence,
      editor = state.editorMode,
      key = scope();
    const form = actions.$('#editor-form'),
      values = Object.fromEntries(new FormData(form));
    if (!values.date || !values.staffId || !values.time || !values.duration) {
      actions.setAppointmentTimeHint(root, 'Укажите дату и время', 'warning');
      return;
    }
    const next = actions.parseDate(values.date);
    next.setDate(next.getDate() + 1);
    actions.setAppointmentTimeHint(root, 'Проверяем график…');
    try {
      const result = await actions.readBackground(
        '/api/work-schedules?staffId=' +
          encodeURIComponent(values.staffId) +
          '&from=' +
          values.date +
          '&to=' +
          actions.isoDate(next),
      );
      if (
        id !== hintSequence ||
        key !== scope() ||
        state.editorMode !== editor ||
        !root.isConnected
      )
        return;
      const day = result.days[values.date];
      const warning = actions.appointmentScheduleWarning(values, result.days, result.closures);
      actions.setAppointmentTimeHint(
        root,
        actions.appointmentScheduleHint(values, result.days, result.closures),
        warning ? 'warning' : 'valid',
        warning
          ? warning +
              (['owner', 'salon_admin'].includes(actions.accountRole())
                ? ' Для сохранения потребуется подтверждение.'
                : ' Запись вне графика может подтвердить только владелец или администратор.')
          : 'Запись помещается в рабочие часы: ' +
              day.intervals.map((pair) => pair.join('–')).join(', '),
      );
    } catch (error) {
      if (id === hintSequence && root.isConnected)
        actions.setAppointmentTimeHint(root, 'График не проверен', 'warning', error.message);
    }
  }
  function bindWorkScheduleEditorEvents() {
    document.addEventListener('click', (e) => {
      const button = e.target.closest('[data-work-add],[data-work-remove]');
      if (!button || state.editorMode?.kind !== 'workSchedule' || state.busy) return;
      e.stopImmediatePropagation();
      intervalDraft = readIntervals();
      if (button.hasAttribute('data-work-add') && intervalDraft.length < 8)
        intervalDraft.push(['', '']);
      if (button.hasAttribute('data-work-remove') && intervalDraft.length > 1)
        intervalDraft.splice(Number(button.dataset.workRemove), 1);
      renderWorkIntervals();
    });
    document.addEventListener('change', (e) => {
      if (
        state.editorMode?.kind === 'workSchedule' &&
        e.target.matches('[data-work-hour],[data-work-minute]')
      ) {
        const field = e.target.closest('[data-work-time]'),
          hour = field.querySelector('[data-work-hour]').value,
          minute = field.querySelector('[data-work-minute]');
        if (hour === '24') minute.value = '00';
        minute.disabled = hour === '24';
        field.querySelector('input').value = hour ? hour + ':' + minute.value : '';
      }
      if (e.target.id === 'work-day-status') {
        intervalDraft = readIntervals();
        renderWorkIntervals();
      }
      if (
        state.editorMode?.kind === 'appointment' &&
        ['date', 'staffId', 'duration', 'time'].includes(e.target.name)
      )
        void refreshAppointmentSchedule();
    });
  }
  return {
    openWorkScheduleEditor,
    saveWorkScheduleForm,
    confirmAppointmentWorkSchedule,
    refreshAppointmentSchedule,
    bindWorkScheduleEditorEvents,
  };
}
