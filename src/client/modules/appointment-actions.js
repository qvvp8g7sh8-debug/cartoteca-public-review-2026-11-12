// Read-only appointment inspector. Mutations use the existing confirmation/save paths.
function createAppointmentActions(state, actions) {
  let sequence = 0,
    pending = null;
  const scope = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  function currentRecord() {
    const mode = state.editorMode;
    if (
      mode?.kind !== 'appointmentActions' ||
      mode.loading ||
      mode.account !== state.account ||
      (mode.scope && mode.scope !== scope())
    )
      return null;
    const patient = mode.inspectorPatient || state.data.find((p) => p.id === mode.patientId);
    const appointment = patient?.appointments.find((a) => a.id === mode.id);
    return patient && appointment ? { mode, patient, appointment } : null;
  }
  function refreshAppointmentActions() {
    const record = currentRecord();
    if (!record || !actions.$('#editor').open) return;
    const { patient: p, appointment: a } = record,
      active = actions.isActiveAppointment(a),
      editable = actions.canEditRecord(a),
      phone = actions.calendarClientPhone({ patientPhone: p.phone }),
      clientName = actions.patientNameParts(p).lastFirst,
      name = clientName || phone || 'Клиент',
      status =
        (a.bookingSource === 'online' ? 'Онлайн-запись · ' : '') +
        actions.calendarAppointmentAppearance(a).label;
    const button = (attribute, label, style = 'secondary') =>
      `<button type="button" class="${style}" ${attribute}>${label}</button>`;
    const complete =
      editable && (active || a.status === 'completed')
        ? button(
            `data-complete-appointment="${actions.esc(a.id)}"`,
            a.status === 'completed' ? 'Открыть посещение' : 'Оформить посещение',
          )
        : '';
    actions.$('#dialog-title').textContent = 'Детали записи';
    actions.$('#form-content').innerHTML =
      `<section class="appointment-action-summary"><strong>${actions.esc(name)}</strong>` +
      `<span>${actions.esc(actions.formatDate(a.date) + ' · ' + a.time)} · ${actions.formatMinutes(a.duration || 60)}</span>` +
      `<span>${actions.esc(a.service || 'Услуга не указана')}</span>` +
      (clientName && phone
        ? `<span class="appointment-action-phone">${actions.esc(phone)}</span>`
        : '') +
      `<small role="status">${actions.esc(status)}</small></section>` +
      `<div class="appointment-action-contact">${actions.clientContactActionsHtml(p, { labels: true })}</div>` +
      actions.notificationHistoryHtml(p.id, a.id) +
      '<div class="appointment-action-options">' +
      (active && editable
        ? button(
            'data-edit-appointment-action',
            '<svg class="appointment-action-pencil" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 15 10-10 4 4L9 19l-5 1Z" fill="#daa658"/><path d="m15 5 2-2a1.5 1.5 0 0 1 2 0l2 2a1.5 1.5 0 0 1 0 2l-2 2Z" fill="#8199a8"/><path d="m5 15 4 4-5 1Z" fill="#536b7a"/><path d="m7 15 9-9" stroke="#fff" stroke-opacity=".65" stroke-linecap="round"/></svg><span>Изменить запись</span>',
          )
        : '') +
      button(
        `data-open-appointment-patient="${actions.esc(p.id)}" aria-label="Открыть карточку клиента" title="Открыть карточку клиента"`,
        '<svg class="appointment-client-card-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">' +
          '<defs><linearGradient id="appointment-client-silver" x1="14" y1="6" x2="35" y2="42" gradientUnits="userSpaceOnUse">' +
          '<stop stop-color="#e1eeef"/><stop offset=".32" stop-color="#bbd6da"/><stop offset=".68" stop-color="#83b0b8"/><stop offset="1" stop-color="#5c8996"/></linearGradient></defs>' +
          '<circle class="client-icon-portrait" cx="24" cy="14" r="8" fill="url(#appointment-client-silver)"/>' +
          '<path class="client-icon-portrait" d="M8 39c0-8.5 7.2-14 16-14s16 5.5 16 14v2c-9 3-23 3-32 0Z" fill="url(#appointment-client-silver)"/>' +
          '<path class="client-icon-shine" d="M19.2 11.5a5.2 5.2 0 0 1 6.3-2.4M12.5 35c2.3-4.8 6.1-7 11.5-7" stroke="#fff" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round"/></svg>',
      ) +
      (active && editable
        ? actions.appointmentConfirmationControls(a, p.id, { allowUndo: true })
        : '') +
      complete +
      (!active && a.status !== 'completed' && editable
        ? button(`data-book-again="${actions.esc(p.id)}"`, 'Перезаписать')
        : '') +
      '</div>' +
      (a.notes ? `<p class="appointment-action-notes">${actions.esc(a.notes)}</p>` : '') +
      `<div class="appointment-action-outcomes">${actions.appointmentOutcomeControls(a, p.id)}</div>` +
      (active && editable && actions.canDelete()
        ? '<div class="appointment-action-delete">' +
          button('data-delete-appointment-action', 'Удалить без истории', 'text-btn danger') +
          '</div>'
        : '');
    const confirm = actions.$('#form-content [data-manual-confirm][data-confirm-value="true"]');
    if (confirm) confirm.textContent = 'Подтвердить запись';
  }
  async function openAppointmentActions(a, source = 'calendar') {
    if (!a?.id || a.busy || state.busy || !actions.canEditRecord(a)) return;
    if (
      pending &&
      !pending.cancelled &&
      pending.account === state.account &&
      pending.scope === scope() &&
      pending.view === state.currentView &&
      pending.id === a.id &&
      pending.patientId === a.patientId &&
      (!pending.mode || (state.editorMode === pending.mode && actions.$('#editor').open))
    )
      return pending.task;
    pending?.controller?.abort();
    const requestId = ++sequence,
      account = state.account,
      view = state.currentView,
      owned = { account, scope: scope(), view, id: a.id, patientId: a.patientId };
    pending = owned;
    const current = () =>
      !owned.cancelled &&
      requestId === sequence &&
      state.account === account &&
      owned.scope === scope() &&
      state.currentView === view;
    owned.task = (async () => {
      if (actions.$('#editor').open) await actions.requestEditorClose();
      if (!current() || actions.$('#editor').open) return;
      const mode = {
        kind: 'appointmentActions',
        loading: true,
        id: a.id,
        patientId: a.patientId,
        source,
        account,
        scope: owned.scope,
      };
      owned.mode = state.editorMode = mode;
      state.uploadItems = [];
      try {
        // Start the authoritative read before rendering feedback, so the loading
        // state adds no serial network delay to opening the actual details.
        const pointRead =
            state.lazyReads && actions.readAppointmentEditor && actions.isActiveAppointment(a)
              ? actions.readAppointmentEditor(a.patientId, a.id, {
                  details: true,
                  signal: (owned.controller = new AbortController()).signal,
                })
              : null,
          fullRead = pointRead ? null : actions.ensurePatient(a.patientId, { force: true });
        // Keep a rejected read observed even if rendering the loading UI throws.
        void Promise.resolve(pointRead || fullRead).catch(() => {});
        actions.$('#dialog-title').textContent = 'Детали записи';
        actions.$('#form-content').innerHTML =
          '<section class="appointment-action-summary" role="status" aria-live="polite">Загружаем запись…</section>';
        actions.openDialog();
        let p,
          inspectorPatient = null;
        if (pointRead) {
          const result = await pointRead;
          if (!current() || state.editorMode !== mode || !actions.$('#editor').open) return;
          if (result?.kind === 'appointment-edit-v1')
            inspectorPatient = {
              ...result.patient,
              visits: [],
              appointments: [result.displayAppointment || result.appointment],
            };
        }
        p =
          inspectorPatient ||
          (await (fullRead || actions.ensurePatient(a.patientId, { force: true })));
        if (!current() || state.busy || state.editorMode !== mode || !actions.$('#editor').open)
          return;
        const saved = p?.appointments.find((record) => record.id === a.id);
        if (!saved || !actions.canEditRecord(saved))
          throw new Error('Запись уже удалена или недоступна. Обновите календарь.');
        Object.assign(mode, {
          loading: false,
          ...(inspectorPatient ? { inspectorPatient } : {}),
          id: saved.id,
          patientId: p.id,
          source,
          account,
        });
        refreshAppointmentActions();
      } catch (error) {
        if (current() && state.editorMode === mode && actions.$('#editor').open) {
          mode.retryAppointment = a;
          actions.$('#form-content').innerHTML =
            `<p role="alert">${actions.esc(error.message)}</p>` +
            '<button type="button" class="secondary" data-retry-appointment-action>Повторить загрузку</button>';
          actions.toast(error.message);
        }
      } finally {
        if (!current() && state.editorMode === mode && actions.$('#editor').open)
          await actions.requestEditorClose();
      }
    })();
    try {
      return await owned.task;
    } finally {
      if (pending === owned) pending = null;
    }
  }
  async function deleteFromActions(button) {
    const record = currentRecord();
    if (!record || !actions.canDelete() || !actions.isActiveAppointment(record.appointment)) return;
    const { mode, patient, appointment } = record;
    if (
      !(await actions.confirmAction(
        'Удалить запись без истории?',
        `${actions.patientNameParts(patient).lastFirst || actions.calendarClientPhone({ patientPhone: patient.phone }) || 'Клиент'} · ${actions.formatDate(appointment.date)} · ${appointment.time}\nЗапись будет удалена без истории отмены. Чтобы сохранить историю, выберите «Отменить запись».`,
        'Удалить без истории',
        'Оставить запись',
      ))
    )
      return;
    if (
      state.busy ||
      state.editorMode !== mode ||
      mode.account !== state.account ||
      !actions.$('#editor').open
    )
      return;
    state.busy = true;
    button.disabled = true;
    try {
      const p = await actions.ensurePatient(patient.id, { force: true });
      if (state.editorMode !== mode || mode.account !== state.account) return;
      const a = p?.appointments.find((a) => a.id === mode.id);
      if (
        !a ||
        !actions.canDelete() ||
        !actions.canEditRecord(a) ||
        !actions.isActiveAppointment(a)
      )
        throw new Error('Запись уже изменена или недоступна. Откройте её заново.');
      if (JSON.stringify(a) !== JSON.stringify(appointment))
        throw new Error('Запись изменилась. Откройте её заново перед удалением.');
      p.appointments = p.appointments.filter((a) => a.id !== mode.id);
      await actions.save();
      actions.closeEditor();
      actions.setView(state.currentView);
      actions.toast('Запись удалена');
    } catch (error) {
      actions.rollback();
      actions.toast(error.message);
    } finally {
      state.busy = false;
      if (button.isConnected) button.disabled = false;
    }
  }
  function bindAppointmentActionEvents() {
    actions.$('#editor').addEventListener('close', () => {
      // A delayed close event from an old dialog must not cancel its replacement.
      if (
        pending?.mode?.loading &&
        !actions.$('#editor').open &&
        (!state.editorMode || state.editorMode === pending.mode)
      ) {
        pending.cancelled = true;
        pending.controller?.abort();
      }
    });
    window.addEventListener('pagehide', () => {
      if (!pending) return;
      pending.cancelled = true;
      pending.controller?.abort();
      if (state.editorMode === pending.mode && pending.mode?.loading)
        void actions.requestEditorClose();
    });
    document.addEventListener('click', async (event) => {
      const retry = event.target.closest('[data-retry-appointment-action]');
      if (retry) {
        event.stopImmediatePropagation();
        const mode = state.editorMode;
        if (
          mode?.loading &&
          mode.account === state.account &&
          mode.scope === scope() &&
          mode.retryAppointment
        )
          return openAppointmentActions(mode.retryAppointment, mode.source);
        return;
      }
      const edit = event.target.closest('[data-edit-appointment-action]'),
        remove = event.target.closest('[data-delete-appointment-action]');
      if ((!edit && !remove) || state.busy) return;
      event.stopImmediatePropagation();
      if (remove) return deleteFromActions(remove);
      const record = currentRecord();
      if (!record || !actions.$('#editor').open) return;
      actions.openAppointmentForm(
        { ...record.appointment, patientId: record.patient.id },
        record.mode.source,
      );
    });
  }
  return { openAppointmentActions, refreshAppointmentActions, bindAppointmentActionEvents };
}
