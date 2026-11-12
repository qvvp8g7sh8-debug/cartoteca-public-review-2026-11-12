// Manual editor hints only. The server rechecks overlap rules under its commit lock.
function createAppointmentAvailability(state, actions) {
  let sequence = 0;
  const startAt = (a) => Date.parse(a.date + 'T' + a.time + ':00Z');
  function appointmentIntervalConflict(a, other) {
    const start = startAt(a),
      end = start + Number(a.duration) * 60000;
    const oldStart = startAt(other),
      oldEnd = oldStart + (Number(other.duration) || 60) * 60000;
    if (!(start < oldEnd && oldStart < end)) return '';
    const startsInside = start >= oldStart && start < oldEnd;
    const endsInside = end > oldStart && end <= oldEnd;
    if (startsInside && endsInside) return 'Выбранный интервал попадает на другую запись.';
    if (startsInside) return 'Начало записи попадает на другую запись.';
    if (endsInside) return 'Окончание записи попадает на другую запись.';
    return 'Выбранный интервал включает другую запись.';
  }
  function setAppointmentTimeHint(root, text, tone = '', detail = '') {
    if (!root) return;
    root.textContent = text;
    root.title = detail || text;
    root.classList.add('appointment-time-status');
    root.classList.toggle('is-valid', tone === 'valid');
    root.classList.toggle('is-warning', tone === 'warning');
  }
  function conflict(
    a,
    busy,
    calendar = state.calendarRecords,
    personal = state.personalEvents || [],
  ) {
    for (const event of personal) {
      if (event.staffId === a.staffId && appointmentIntervalConflict(a, event))
        return 'Это время занято личным событием. Укажите другую дату и время.';
    }
    const rules = actions.appointmentOverlapRules(a.staffId, a.roomId);
    const records = (
      state.lazyReads ? calendar || [] : state.data.flatMap((p) => p.appointments || [])
    )
      .filter((other) => other.id !== state.editorMode?.id && actions.isActiveAppointment(other))
      .filter(
        (other) =>
          (rules.staff && (other.staffId || actions.accountId()) === a.staffId) ||
          (rules.room && actions.appointmentRoomId(other) === a.roomId),
      );
    for (const other of [...records, ...busy.filter((b) => rules.room && b.roomId === a.roomId)]) {
      const message = appointmentIntervalConflict(a, other);
      if (message) return 'Это время занято. ' + message + ' Укажите другую дату и время.';
    }
    return '';
  }
  async function availability(a) {
    const first = actions.parseDate(a.date),
      last = actions.parseDate(a.date);
    first.setDate(first.getDate() - 1);
    last.setDate(last.getDate() + 1);
    const range = 'from=' + actions.isoDate(first) + '&to=' + actions.isoDate(last);
    const [rooms, calendar] = await Promise.all([
      actions.readBackground('/api/workspace/availability?' + range),
      actions.readBackground('/api/cabinet/calendar?' + range),
    ]);
    return conflict(a, rooms.busy, calendar?.appointments, calendar?.personalEvents || []);
  }
  async function assertAppointmentAvailability(a) {
    if (!state.multiUser) return;
    const editor = state.editorMode,
      account = state.account;
    const message = await availability(a);
    if (state.editorMode !== editor || state.account !== account)
      throw new Error('Форма или аккаунт изменились. Откройте запись заново.');
    if (message) throw new Error(message);
  }
  async function refreshAppointmentRooms({ staffChanged = false } = {}) {
    const id = ++sequence;
    if (!state.multiUser || state.editorMode?.kind !== 'appointment') return;
    const form = actions.$('#editor-form'),
      field = actions.$('#appointment-room');
    if (!form || !field) return;
    const staffId = form.elements.staffId.value || actions.accountId();
    if (staffChanged) {
      if (field.tagName === 'SELECT') field.innerHTML = actions.roomOptions(staffId, field.value);
      else {
        const rooms = actions.roomsFor(staffId);
        field.value = rooms.length === 1 ? rooms[0].id : '';
      }
    }
    const root = actions.$('#appointment-room-status');
    if (!root) return;
    root.hidden = false;
    // Keep the selected value in FormData, even when a longer duration now conflicts.
    for (const option of form.elements.time.options) option.disabled = false;
    const a = {
      staffId,
      roomId: field.value,
      date: form.elements.date.value,
      time: form.elements.time.value,
      duration: Number(form.elements.duration.value),
    };
    if (!a.roomId) {
      actions.setAppointmentTimeHint(
        root,
        field.type === 'hidden' ? 'Нет кабинета' : 'Выберите кабинет',
        'warning',
        field.type === 'hidden'
          ? 'Сотрудник не назначен в этот кабинет. Проверьте настройки «Кто здесь принимает».'
          : 'Выберите доступный физический кабинет.',
      );
      return;
    }
    if (!a.date || !a.time || !a.duration) {
      actions.setAppointmentTimeHint(root, 'Укажите дату и время', 'warning');
      return;
    }
    const rules = actions.appointmentOverlapRules(staffId, a.roomId);
    const editor = state.editorMode,
      account = state.account;
    actions.setAppointmentTimeHint(root, 'Проверяем время…');
    try {
      const message = await availability(a);
      if (
        id !== sequence ||
        state.editorMode !== editor ||
        state.account !== account ||
        !root.isConnected
      )
        return;
      actions.setAppointmentTimeHint(
        root,
        message
          ? 'Время занято'
          : !rules.staff && !rules.room
            ? 'Пересечения разрешены'
            : 'Время свободно',
        message ? 'warning' : 'valid',
        message ||
          (!rules.staff && !rules.room
            ? 'Личное время свободно. Пересечения клиентских записей разрешены настройками.'
            : 'Время свободно. При сохранении занятость проверяется повторно.'),
      );
    } catch (error) {
      if (id === sequence && root.isConnected)
        actions.setAppointmentTimeHint(
          root,
          'Время не проверено',
          'warning',
          'Не удалось проверить занятость. ' + error.message,
        );
    }
  }
  return {
    appointmentIntervalConflict,
    setAppointmentTimeHint,
    assertAppointmentAvailability,
    refreshAppointmentRooms,
  };
}
