function createPersonalEvents(state, actions) {
  function personalEventFields(event = {}) {
    return [
      '<div class="form-grid personal-event-form">',
      actions.staffField(event.staffId || state.selectedScheduleStaff || actions.accountId()),
      '<label class="field">Дата<input name="date" type="date" required value="',
      actions.esc(event.date || actions.isoDate(state.calendarAnchorDate)),
      '"></label>',
      '<label class="field">Время<select name="time" required>',
      actions.timeOptions(event.time || '10:00'),
      '</select></label>',
      '<label class="field full">Длительность<select name="duration" required>',
      actions.durationOptions(Number(event.duration) || 60),
      '</select></label>',
      '<label class="field full">Комментарий<textarea name="notes" maxlength="2000" ',
      'placeholder="Что нужно сделать">',
      actions.esc(event.notes || ''),
      '</textarea></label>',
      '</div>',
      '<p class="form-hint">Время будет занято в календаре. Можно выбрать любой день и час.</p>',
    ].join('');
  }
  function openPersonalEventForm(event = null) {
    if (
      event?.busy ||
      (event?.staffId &&
        actions.accountRole() === 'cosmetologist' &&
        event.staffId !== actions.accountId())
    )
      return;
    state.appointmentFromServices = false;
    state.editorMode = { kind: 'personalEvent', id: event?.id || null, source: 'calendar' };
    actions.$('#dialog-title').textContent = 'Личное';
    actions.$('#form-content').innerHTML = personalEventFields(event || {});
    if (event?.id)
      actions
        .$('#form-content')
        .insertAdjacentHTML(
          'beforeend',
          '<div class="personal-event-actions"><button type="button" class="text-btn danger" ' +
            'data-delete-personal-event="' +
            actions.esc(event.id) +
            '">Удалить личное время</button></div>',
        );
    actions.openDialog();
  }
  async function savePersonalEventForm(values) {
    const duration = Number(values.duration),
      date = String(values.date || ''),
      time = String(values.time || ''),
      notes = String(values.notes || '').trim();
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date + 'T00:00:00Z')) ||
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      Number(time.slice(3)) % 5 ||
      !Number.isSafeInteger(duration) ||
      duration < 5 ||
      duration > 1440 ||
      duration % 5
    )
      throw Error('Укажите дату, время и длительность с шагом 5 минут.');
    if (notes.length > 2000) throw Error('Комментарий — не более 2000 символов.');
    const account = state.account,
      mode = state.editorMode;
    mode.id ||= window.crypto.randomUUID();
    const event = {
      id: mode.id,
      date,
      time,
      duration,
      notes,
      staffId: values.staffId || actions.accountId(),
    };
    const result = await actions.request('/api/calendar/personal-event', {
      method: 'POST',
      body: JSON.stringify({ revision: state.personalRevision, event }),
    });
    if (state.account !== account || state.editorMode !== mode) return;
    state.personalRevision = result.revision;
    state.personalEvents = [...state.personalEvents.filter((item) => item.id !== event.id), event];
    state.calendarAnchorDate = actions.parseDate(date);
    if (actions.appointmentStart(event) < actions.calendarHiddenUntil())
      state.showEarlyHours = true;
    actions.invalidateCalendarRead();
    actions.closeEditor();
    await actions.setView('calendar');
    actions.toast('Личное время сохранено');
  }
  function bindPersonalEventEvents() {
    actions.$('#editor').addEventListener('click', async (event) => {
      const remove = event.target.closest('[data-delete-personal-event]');
      if (!remove || state.busy || state.editorMode?.kind !== 'personalEvent') return;
      if (
        !(await actions.confirmAction(
          'Удалить личное время?',
          'Этот промежуток снова станет свободным в календаре.',
          'Удалить',
          'Отмена',
        ))
      )
        return;
      const account = state.account,
        mode = state.editorMode;
      state.busy = true;
      actions.updatePhotoSaveButton();
      try {
        const result = await actions.request('/api/calendar/personal-event', {
          method: 'DELETE',
          body: JSON.stringify({
            revision: state.personalRevision,
            id: remove.dataset.deletePersonalEvent,
          }),
        });
        if (state.account !== account || state.editorMode !== mode) return;
        state.personalRevision = result.revision;
        state.personalEvents = state.personalEvents.filter((item) => item.id !== mode.id);
        actions.invalidateCalendarRead();
        actions.closeEditor();
        await actions.setView('calendar');
        actions.toast('Личное время удалено');
      } catch (error) {
        actions.$('#form-error').textContent = error.message;
      } finally {
        state.busy = false;
        actions.updatePhotoSaveButton();
      }
    });
  }
  return {
    personalEventFields,
    openPersonalEventForm,
    savePersonalEventForm,
    bindPersonalEventEvents,
  };
}
