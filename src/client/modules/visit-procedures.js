function createVisitProcedures(state, actions) {
  function mountVisitProcedures(v, appointment) {
    const mode = state.editorMode;
    mode.procedureStaffId = actions.$('#form-content [name="staffId"]')?.value || '';
    mode.serviceItems = structuredClone(
      v?.id ? v.serviceItems || [] : appointment?.serviceItems || v?.serviceItems || [],
    );
    const savedName = v?.id ? v.procedure || '' : appointment?.service || v?.procedure || '',
      joined = mode.serviceItems.map((s) => s.name).join(' + ');
    mode.visitLegacyProcedure = !joined
      ? savedName
      : savedName.endsWith(' + ' + joined)
        ? savedName.slice(0, -joined.length - 3)
        : '';
    mode.visitLegacyDuration = mode.visitLegacyProcedure
      ? Math.max(
          0,
          (Number(v?.duration || appointment?.duration) || 0) -
            mode.serviceItems.reduce((sum, s) => sum + s.duration, 0),
        )
      : 0;
    actions.$('#visit-procedures-field').innerHTML =
      '<label for="visit-procedure">Услуги посещения</label><select id="visit-procedure" aria-label="Добавить услугу">' +
      actions.serviceOptions().replace('Выберите услугу', 'Добавить услугу') +
      [
        '</select>',
        '<p class="form-hint">Можно выбрать несколько услуг.</p>',
        '<div id="visit-selected-procedures" ',
        'aria-label="Выбранные услуги">',
        '</div>',
        '<p id="visit-procedures-total" ',
        'class="form-hint" ',
        'role="status">',
        '</p>',
        '<input type="hidden" ',
        'name="procedure" ',
        'id="visit-procedure-value">',
      ].join('');
    renderVisitProcedures();
    actions.lockSavedVisit(v);
  }
  function renderVisitProcedures(recalculate = false) {
    const mode = state.editorMode,
      items = mode.serviceItems || [],
      legacy = mode.visitLegacyProcedure;
    const names = [...(legacy ? [legacy] : []), ...items.map((s) => s.name)];
    actions.$('#visit-procedure-value').value = names.join(' + ');
    actions.$('#visit-selected-procedures').innerHTML =
      (legacy
        ? '<div class="visit-procedure-row"><div><strong>' +
          actions.esc(legacy) +
          [
            '</strong>',
            '<small>Ранее сохранённая услуга</small>',
            '</div>',
            '<button class="visit-procedure-remove" ',
            'type="button" data-remove-visit-legacy aria-label="Убрать ранее сохранённую услугу">×</button>',
            '</div>',
          ].join('')
        : '') +
      items
        .map(
          (s) =>
            '<div class="visit-procedure-row"><div><strong>' +
            actions.esc(s.name) +
            '</strong><small>' +
            actions.esc(actions.formatMinutes(s.duration)) +
            '</small></div><button class="visit-procedure-remove" type="button" data-remove-visit-procedure="' +
            actions.esc(s.id) +
            '" aria-label="Убрать услугу ' +
            actions.esc(s.name) +
            '">×</button></div>',
        )
        .join('');
    const total = items.reduce((sum, s) => sum + s.duration, mode.visitLegacyDuration || 0);
    actions.$('#visit-procedures-total').textContent = total
      ? 'Всего: ' + actions.formatMinutes(total)
      : '';
    if (recalculate) {
      actions.$('[name="duration"]').value = total ? String(total) : '';
    }
  }
  function bindVisitProcedureEvents() {
    actions.$('#form-content').addEventListener('change', (e) => {
      if (
        e.target.name === 'staffId' &&
        state.editorMode?.kind === 'visit' &&
        !state.editorMode.appendOnly &&
        !state.busy
      ) {
        const mode = state.editorMode;
        if (e.target.value === mode.procedureStaffId) return;
        if (
          (mode.serviceItems.length || mode.visitLegacyProcedure) &&
          !window.confirm('При смене сотрудника выбранные услуги будут убраны. Продолжить?')
        ) {
          e.target.value = mode.procedureStaffId;
          return;
        }
        mode.procedureStaffId = e.target.value;
        mode.serviceItems = [];
        mode.visitLegacyProcedure = '';
        mode.visitLegacyDuration = 0;
        actions.$('#visit-procedure').innerHTML = actions
          .serviceOptions()
          .replace('Выберите услугу', 'Добавить услугу');
        renderVisitProcedures(true);
        return;
      }
      if (
        e.target.id !== 'visit-procedure' ||
        state.editorMode?.kind !== 'visit' ||
        state.editorMode.appendOnly ||
        state.busy
      )
        return;
      const service = actions
        .servicesForStaff()
        .find((s) => s.id === e.target.selectedOptions[0]?.dataset.serviceId);
      if (!service) return;
      const mode = state.editorMode,
        items = mode.serviceItems,
        snapshot = actions.serviceSnapshot(service);
      if (items.some((s) => s.id === service.id)) {
        actions.toast('Эта услуга уже добавлена');
        e.target.value = '';
        return;
      }
      if (
        items.length >= 100 ||
        items.reduce((sum, s) => sum + s.duration, mode.visitLegacyDuration || 0) +
          snapshot.duration >
          1440
      ) {
        actions.toast('Общая длительность не должна превышать 1440 минут');
        e.target.value = '';
        return;
      }
      items.push(snapshot);
      e.target.value = '';
      renderVisitProcedures(true);
    });
    actions.$('#form-content').addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove-visit-procedure]'),
        legacy = e.target.closest('[data-remove-visit-legacy]');
      if (
        (!remove && !legacy) ||
        state.editorMode?.kind !== 'visit' ||
        state.editorMode.appendOnly ||
        state.busy
      )
        return;
      if (remove)
        state.editorMode.serviceItems = state.editorMode.serviceItems.filter(
          (s) => s.id !== remove.dataset.removeVisitProcedure,
        );
      if (legacy) {
        state.editorMode.visitLegacyProcedure = '';
        state.editorMode.visitLegacyDuration = 0;
      }
      renderVisitProcedures(true);
    });
  }
  return { mountVisitProcedures, bindVisitProcedureEvents };
}
