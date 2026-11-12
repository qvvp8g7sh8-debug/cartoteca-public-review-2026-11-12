function createAppointments(state, actions) {
  function timeOptions(current = '', hour = '') {
    const restricted = /^([01]\d|2[0-3])$/.test(hour);
    const firstMinute = restricted ? Number(hour) * 60 : 0;
    return Array.from({ length: restricted ? 12 : 288 }, (_, i) => {
      const value = actions.timeLabel(firstMinute + i * 5);
      return `<option value="${value}" ${value === current ? 'selected' : ''}>${value}</option>`;
    }).join('');
  }
  function durationOptions(current = 60) {
    const values = Array.from({ length: 36 }, (_, index) => (index + 1) * 5);
    if (Number(current) > 180 && Number(current) <= 1440 && Number(current) % 5 === 0)
      values.push(Number(current));
    return values
      .sort((a, b) => a - b)
      .map(
        (value) =>
          `<option value="${value}" ${Number(current) === value ? 'selected' : ''}>${actions.formatMinutes(value)}</option>`,
      )
      .join('');
  }
  let formSequence = 0;
  async function openAppointmentForm(a = null, source = 'calendar') {
    const formId = ++formSequence,
      view = state.currentView,
      account = state.account,
      editor = state.editorMode,
      assistantGeneration = state.assistantGeneration,
      assistantIdentity = JSON.stringify([account?.id, account?.organizationId, account?.role]);
    const current = () =>
      formId === formSequence &&
      state.currentView === view &&
      state.account === account &&
      state.editorMode === editor &&
      (source !== 'assistant' ||
        (assistantGeneration === state.assistantGeneration &&
          assistantIdentity ===
            JSON.stringify([
              state.account?.id,
              state.account?.organizationId,
              state.account?.role,
            ])));
    if (a?.id && !actions.canEditRecord(a)) {
      actions.toast('Сотрудник может изменять только свои записи');
      return;
    }
    let patient = state.data.find((p) => p.id === a?.patientId);
    let pointEdit = null;
    if (
      state.lazyReads &&
      a?.id &&
      a.patientId &&
      source !== 'assistant' &&
      actions.readAppointmentEditor &&
      actions.isActiveAppointment(a)
    ) {
      try {
        const result = await actions.readAppointmentEditor(a.patientId, a.id);
        if (!current()) return;
        if (
          result?.kind === 'appointment-edit-v1' &&
          actions.isActiveAppointment(result.appointment)
        ) {
          pointEdit = {
            patientId: result.patient.id,
            before: structuredClone(result.appointment),
            revision: result.revision,
            account: result.account,
          };
          patient = { ...result.patient, visits: [], appointments: [result.appointment] };
        }
      } catch (error) {
        if (current()) actions.toast(error.message);
        return;
      }
    }
    if (
      !pointEdit &&
      state.lazyReads &&
      a?.patientId &&
      a.patientId !== '__new__' &&
      (a.id || !patient)
    ) {
      try {
        patient = await actions.ensurePatient(a.patientId, {
          force: Boolean(a.id),
        });
      } catch (error) {
        if (current()) actions.toast(error.message);
        return;
      }
    }
    if (!current()) return;
    if (a?.id) {
      const saved = patient?.appointments.find((record) => record.id === a.id);
      if (!saved) {
        actions.toast('Запись уже удалена или недоступна. Обновите календарь.');
        return;
      }
      a = { ...saved, patientId: patient.id };
      if (!actions.canEditRecord(a)) {
        actions.toast('Нет доступа к этой записи');
        return;
      }
    }
    if (a?.status === 'completed') {
      const visit = patient?.visits.find(
        (v) => v.id === a.completedVisitId && v.appointmentId === a.id,
      );
      if (!visit) {
        actions.toast('Результаты посещения не найдены. Обновите карточку.');
        return;
      }
      state.selectedId = patient.id;
      actions.openVisitForm(visit);
      return;
    }
    if (a && actions.isClosedAppointment(a)) {
      if (patient) actions.openAppointmentOutcome(a, patient);
      return;
    }
    if (!patient && a?.patientId)
      patient = actions.clientRecords().find((p) => p.id === a.patientId);
    if (!current()) return;
    state.appointmentFromServices = source === 'services';
    state.editorMode = {
      kind: 'appointment',
      ...(pointEdit ? { pointEdit } : {}),
      patientId: a?.patientId || '',
      id: a?.id || null,
      source,
      gapDuration: a?.gapDuration || 0,
      serviceItems:
        a?.serviceItems ||
        (a?.id
          ? []
          : actions.selectedServiceItems(
              a?.service,
              '',
              a?.staffId || state.selectedScheduleStaff || actions.accountId(),
            )),
    };
    if (source === 'assistant') state.assistantEditor = state.editorMode;
    actions.$('#dialog-title').textContent = a?.id ? 'Изменить запись' : 'Новая запись';
    const newVisible = a?.patientId === '__new__';
    const selectedDuration =
      Number(a?.duration) ||
      actions.serviceDuration(
        a?.service || '',
        a?.staffId || state.selectedScheduleStaff || actions.accountId(),
      ) ||
      60;
    actions.$('#form-content').innerHTML = [
      `<div class="form-grid${a?.id ? ' appointment-edit-form' : ''}">${actions.appointmentPatientPickerHtml(patient)}${actions.patientFieldsHtml(null, { appointment: true })}<label class="field appointment-new-field" ${newVisible ? '' : 'hidden'}>Телефон<input name="newPhone" `,
      `inputmode="tel" `,
      `value="" `,
      `placeholder="Телефон">`,
      `</label>${actions.staffField(a?.staffId || state.selectedScheduleStaff)}<label class="field">Дата записи<input name="date" `,
      `type="date" required value="${actions.esc(a?.date || actions.isoDate(state.calendarAnchorDate))}">`,
      `</label>`,
      `<label class="field">Время<select name="time" required${!a?.id && a?.timeHour ? ' data-calendar-slot-time' : ''}>${actions.timeOptions(a?.time || '10:00', a?.id ? '' : a?.timeHour || '')}</select>`,
      `</label>`,
      `<label class="field">Длительность<select name="duration" `,
      `id="appointment-duration" required>${actions.durationOptions(selectedDuration)}</select>`,
      `</label>`,
      '<div class="field full appointment-procedures" id="appointment-procedures-field"></div>',
      `<label class="field full">Комментарий<textarea name="notes" `,
      `placeholder="Что нужно учесть до визита">${actions.esc(a?.notes || '')}</textarea>`,
      `</label>`,
      `</div>`,
      `<p class="form-hint">Начало — с шагом 5 минут. В длительности доступны также 5 и 10 минут. Цвет показывает состояние записи.</p>`,
    ].join('');
    if (newVisible) actions.$('#appointment-patient').value = '__new__';
    const staffSelect = actions.$('#form-content select[name="staffId"]');
    if (!a?.id && staffSelect?.options.length === 1) staffSelect.closest('label').hidden = true;
    const dateField = actions.$('#form-content [name="date"]').closest('label');
    dateField.insertAdjacentHTML('beforebegin', actions.appointmentRoomField(a || {}));
    if (
      state.workspace.enabled ||
      state.workspace.staffRules?.some((rule) => rule.preventOverlap) ||
      state.workspace.rooms?.some((room) => room.active && room.preventOverlap)
    )
      actions.$('#form-content > .form-hint').textContent =
        'Начало — с шагом 5 минут. В длительности доступны также 5 и 10 минут. Занятость специалиста и кабинета проверяется перед сохранением.';
    actions.mountAppointmentProcedures(a);
    actions
      .$('#form-content')
      .insertAdjacentHTML(
        'beforeend',
        '<p class="form-hint" id="appointment-work-schedule" aria-live="polite"></p>',
      );
    actions.openDialog();
    void actions.refreshAppointmentSchedule();
    actions.mountAppointmentPatientPicker(patient);
    void actions.refreshAppointmentRooms();
  }
  function serviceSnapshot(s) {
    const category = actions.serviceCategory(s);
    return {
      id: s.id,
      name: s.name,
      category,
      categoryTitle: state.SERVICE_CATEGORIES.find((c) => c.id === category)?.title || 'Другое',
      description: s.description || '',
      duration: actions.durationMinutes(s.duration),
      price: Number(s.price) || 0,
    };
  }
  function selectedServiceItems(name = '', id = '', staffId = '') {
    const s = actions.servicesForStaff(staffId).find((s) => (id ? s.id === id : s.name === name));
    return s ? [actions.serviceSnapshot(s)] : [];
  }
  function patientAppointmentsHtml(p) {
    const appointments = (p.appointments || [])
      .filter((a) => actions.isActiveAppointment(a))
      .sort((a, b) => (a.date + ' ' + a.time).localeCompare(b.date + ' ' + b.time));
    return (
      '<section class="patient-appointments" aria-label="Записи на приём"><div class="content-heading patient-appointments-heading"><h3>Записи на приём</h3></div><div class="patient-appointments-list" tabindex="0" role="region" aria-label="Записи клиента: прокручиваемый список">' +
      (appointments.length
        ? appointments
            .map(
              (a) =>
                '<div class="patient-appointment-row"><button class="patient-appointment-main" data-card-appointment="' +
                actions.esc(a.id) +
                '"><strong>' +
                actions.esc(actions.formatDate(a.date)) +
                ', ' +
                actions.esc(a.time) +
                '</strong><span>' +
                actions.esc(a.service) +
                ' · ' +
                actions.formatMinutes(a.duration || 60) +
                '</span><small>' +
                (a.telegramConfirmedAt || a.notificationConfirmedAt
                  ? 'Подтверждена клиентом'
                  : a.date < actions.cabinetToday()
                    ? 'Прошедшая запись — посещение не оформлено'
                    : 'Ждём подтверждения клиента') +
                '</small></button>' +
                (actions.canEditRecord(a)
                  ? '<button class="secondary" data-complete-appointment="' +
                    actions.esc(a.id) +
                    '">Оформить посещение</button>'
                  : '') +
                '</div>',
            )
            .join('')
        : '<p class="form-hint">Записей пока нет. История появляется только после оформления проведённого посещения.</p>') +
      '</div></section>'
    );
  }
  async function completeAppointment(id) {
    const formId = ++formSequence,
      view = state.currentView,
      account = state.account,
      editor = state.editorMode;
    const current = () =>
      formId === formSequence &&
      state.currentView === view &&
      state.account === account &&
      state.editorMode === editor;
    let p = state.data.find((p) => p.appointments.some((a) => a.id === id));
    if (
      !p &&
      state.editorMode?.kind === 'appointmentActions' &&
      state.editorMode.id === id &&
      state.editorMode.account === account
    )
      p = state.editorMode.inspectorPatient;
    if (state.lazyReads && p) {
      try {
        p = await actions.ensurePatient(p.id, { force: true });
      } catch (error) {
        if (current()) actions.toast(error.message);
        return;
      }
    }
    if (!current()) return;
    const a = p?.appointments.find((a) => a.id === id);
    if (!a || !actions.canEditRecord(a)) return;
    state.selectedId = p.id;
    if (a.status === 'completed') {
      const visit = p.visits.find((v) => v.id === a.completedVisitId && v.appointmentId === a.id);
      if (!visit) {
        actions.toast('Результаты посещения не найдены. Обновите карточку.');
        return;
      }
      actions.openVisitForm(visit);
      return;
    }
    if (!actions.isActiveAppointment(a)) {
      actions.openAppointmentOutcome(a, p);
      return;
    }
    if (
      actions.$('#editor').open &&
      state.editorMode?.kind === 'appointment' &&
      !(await actions.confirmAction(
        'Перейти к оформлению посещения?',
        `${p.name} · ${actions.formatDate(a.date)} · ${a.time}\nНесохранённые изменения записи будут отменены.`,
        'Перейти к оформлению',
        'Продолжить редактирование',
      ))
    )
      return;
    if (!current() || state.busy) return;
    actions.openVisitForm(
      {
        date: a.date > actions.cabinetToday() ? actions.cabinetToday() : a.date,
        time: a.time,
        duration: a.duration || 60,
        procedure: a.service,
        staffId: a.staffId,
      },
      a,
    );
  }
  function bindAppointmentWorkflowEvents() {
    document.addEventListener('click', async (e) => {
      if (state.busy) return;
      const card = e.target.closest('[data-card-appointment]'),
        complete = e.target.closest('[data-complete-appointment]'),
        patient = e.target.closest('[data-open-appointment-patient]');
      if (e.target.closest('#new-patient-appointment')) {
        actions.openAppointmentForm(
          { patientId: state.selectedId, date: actions.cabinetToday() },
          'card',
        );
        return;
      }
      if (complete) {
        actions.completeAppointment(complete.dataset.completeAppointment);
        return;
      }
      if (patient) {
        await actions.requestEditorClose();
        if (actions.$('#editor').open) return;
        state.selectedId = patient.dataset.openAppointmentPatient;
        actions.setView('card');
        return;
      }
      if (card) {
        const p = actions.patient() || actions.viewPatient(),
          a = p?.appointments.find((a) => a.id === card.dataset.cardAppointment);
        if (a) actions.openAppointmentActions({ ...a, patientId: p.id }, 'card');
      }
    });
  }
  return {
    timeOptions,
    durationOptions,
    openAppointmentForm,
    serviceSnapshot,
    selectedServiceItems,
    patientAppointmentsHtml,
    completeAppointment,
    bindAppointmentWorkflowEvents,
  };
}
