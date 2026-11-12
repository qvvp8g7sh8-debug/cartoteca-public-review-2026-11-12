function createAppointmentProcedures(state, actions) {
  function names() {
    const mode = state.editorMode;
    return [mode.appointmentLegacyService, ...(mode.serviceItems || []).map((s) => s.name)]
      .filter(Boolean)
      .join(' + ');
  }
  function total() {
    const mode = state.editorMode;
    return (mode.serviceItems || []).reduce(
      (sum, s) => sum + s.duration,
      mode.appointmentLegacyDuration || 0,
    );
  }
  function renderServiceGroups() {
    const services = actions.servicesForStaff();
    const normalize = (value) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е');
    const query = normalize(actions.$('#appointment-service-search').value).trim();
    const option = (service) =>
      [
        '<button type="button" class="appointment-service-option" ',
        `data-appointment-service="${actions.esc(service.id)}">`,
        '<span>',
        actions.esc(service.name),
        ' · ',
        actions.esc(actions.formatPrice(service.price)),
        '</span></button>',
      ].join('');
    const groups = actions.$('#appointment-service-groups');
    if (query) {
      const words = query.split(/\s+/);
      groups.innerHTML =
        services
          .filter((service) => words.every((word) => normalize(service.name).includes(word)))
          .map(option)
          .join('') ||
        '<p class="appointment-service-empty" role="status">Услуги не найдены. Измените запрос.</p>';
      syncSelectedServices();
      return;
    }
    groups.innerHTML =
      state.SERVICE_CATEGORIES.map((category) => {
        const items = services.filter(
          (service) => actions.serviceCategory(service) === category.id,
        );
        if (!items.length) return '';
        if (category.id === 'other') return items.map(option).join('');
        return [
          '<details class="appointment-service-group" name="appointment-service-group"><summary><strong>',
          actions.esc(category.title),
          '</strong></summary>',
          '<div class="appointment-service-options">',
          ...items.map(option),
          '</div></details>',
        ].join('');
      }).join('') || '<p class="form-hint">У этого сотрудника пока нет услуг.</p>';
    syncSelectedServices();
  }
  function syncSelectedServices() {
    actions
      .$('#appointment-service')
      .querySelectorAll('[data-appointment-service]')
      .forEach((button) => {
        const selected = (state.editorMode.serviceItems || []).some(
          (item) => item.id === button.dataset.appointmentService,
        );
        button.disabled = selected;
        button.title = selected ? 'Услуга уже добавлена' : '';
      });
  }
  function resetServiceSearch() {
    const search = actions.$('#appointment-service-search');
    if (!search.value) return;
    search.value = '';
    renderServiceGroups();
  }
  function refreshAppointmentServices(createdId = '') {
    const service = actions.servicesForStaff().find((item) => item.id === createdId);
    actions.$('#appointment-service-search').value = service?.name || '';
    renderServiceGroups();
    const picker = actions.$('#appointment-service');
    picker.open = Boolean(service);
    (service
      ? picker.querySelector('button:not(:disabled)')
      : actions.$('#appointment-new-service')
    )?.focus({ preventScroll: true });
  }
  function renderAppointmentProcedures(recalculate = false) {
    const mode = state.editorMode;
    actions.$('#appointment-service-value').value = names();
    const row = (name, detail, attribute) =>
      [
        '<div class="appointment-procedure-row"><div><strong>',
        actions.esc(name),
        '</strong><small>',
        actions.esc(detail),
        '</small></div>',
        `<button type="button" class="appointment-procedure-remove" ${attribute} `,
        `aria-label="Убрать услугу ${actions.esc(name)}">×</button></div>`,
      ].join('');
    actions.$('#appointment-selected-procedures').innerHTML = [
      mode.appointmentLegacyService
        ? row(
            mode.appointmentLegacyService,
            'Ранее сохранённая услуга',
            'data-remove-appointment-legacy',
          )
        : '',
      ...(mode.serviceItems || []).map((s) =>
        row(
          s.name,
          actions.formatMinutes(s.duration) + ' · ' + actions.formatPrice(s.price),
          `data-remove-appointment-procedure="${actions.esc(s.id)}"`,
        ),
      ),
    ].join('');
    actions.$('#appointment-procedures-total').textContent = total()
      ? 'Общее время: ' + actions.formatMinutes(total())
      : '';
    syncSelectedServices();
    if (recalculate) {
      const selected = mode.gapDuration
        ? Number(actions.$('#appointment-duration').value) || mode.gapDuration
        : total() || 60;
      actions.$('#appointment-duration').innerHTML = actions.durationOptions(selected);
      void actions.refreshAppointmentSchedule();
      void actions.refreshAppointmentRooms();
    }
  }
  function mountAppointmentProcedures(appointment) {
    const mode = state.editorMode;
    mode.procedureStaffId = actions.$('#form-content [name="staffId"]')?.value || '';
    mode.serviceItems = structuredClone(mode.serviceItems || []);
    const savedName = appointment?.service || '',
      joined = mode.serviceItems.map((s) => s.name).join(' + ');
    mode.appointmentLegacyService = !joined
      ? savedName
      : savedName.endsWith(' + ' + joined)
        ? savedName.slice(0, -joined.length - 3)
        : '';
    mode.appointmentLegacyDuration = mode.appointmentLegacyService
      ? Math.max(
          0,
          (Number(appointment.duration) || 60) -
            mode.serviceItems.reduce((sum, s) => sum + s.duration, 0),
        )
      : 0;
    actions.$('#appointment-procedures-field').innerHTML = [
      '<span id="appointment-services-label">Услуги записи</span>',
      '<div id="appointment-selected-procedures" aria-label="Выбранные услуги"></div>',
      '<div class="appointment-service-controls">',
      '<details id="appointment-service" class="appointment-service-picker">',
      '<summary aria-label="Выбрать услугу для записи">Выбрать услугу</summary>',
      '<div class="appointment-service-menu">',
      '<div class="appointment-service-window-heading"><strong>Выбрать услугу</strong>',
      '<button type="button" data-close-service-picker aria-label="Закрыть выбор услуг">×</button></div>',
      '<div class="appointment-service-search">',
      '<input type="search" id="appointment-service-search" placeholder="Найти услугу" ',
      'aria-label="Найти услугу" aria-controls="appointment-service-groups" ',
      'autocomplete="off" spellcheck="false" enterkeyhint="search" maxlength="200"></div>',
      '<div id="appointment-service-groups" role="group" ',
      'aria-labelledby="appointment-services-label"></div></div></details>',
      actions.canEditServices()
        ? '<button type="button" id="appointment-new-service" class="secondary" ' +
          'aria-label="Добавить новую услугу" title="Добавить новую услугу">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
          'stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>'
        : '',
      '</div>',
      '<p id="appointment-procedures-total" class="form-hint" role="status"></p>',
      '<input type="hidden" name="service" id="appointment-service-value">',
    ].join('');
    renderServiceGroups();
    renderAppointmentProcedures();
  }
  function bindAppointmentProcedureEvents() {
    function syncServiceWindow() {
      const picker = actions.$('#appointment-service');
      const menu = picker?.querySelector('.appointment-service-menu');
      if (!menu) return;
      const editor = actions.$('#editor');
      const mobile =
        window.matchMedia('(max-width: 700px)').matches ||
        document.body.classList.contains('phone-landscape');
      picker.toggleAttribute('data-service-window', mobile);
      if (mobile && picker.open && editor.open) {
        if (menu.showPopover) {
          menu.setAttribute('popover', 'manual');
          if (!menu.matches(':popover-open')) menu.showPopover();
        }
        const viewport = window.visualViewport;
        const bounds = editor.getBoundingClientRect();
        const viewTop = viewport?.offsetTop || 0;
        const viewLeft = viewport?.offsetLeft || 0;
        const top = Math.max(viewTop, bounds.top);
        const left = Math.max(viewLeft, bounds.left);
        const bottom = Math.min(viewTop + (viewport?.height || window.innerHeight), bounds.bottom);
        const right = Math.min(viewLeft + (viewport?.width || window.innerWidth), bounds.right);
        // Preserve the original list width; enlarge vertically and center within the main dialog.
        const width = Math.max(
          0,
          Math.min(picker.getBoundingClientRect().width, right - left - 24),
        );
        const verticalInset = Math.min(48, Math.max(12, (bottom - top) * 0.12));
        menu.style.setProperty('--service-window-top', top + verticalInset + 'px');
        menu.style.setProperty('--service-window-left', left + (right - left - width) / 2 + 'px');
        menu.style.setProperty('--service-window-width', width + 'px');
        menu.style.setProperty(
          '--service-window-height',
          Math.max(0, bottom - top - verticalInset * 2) + 'px',
        );
      } else if (menu.hasAttribute('popover')) {
        if (menu.matches(':popover-open')) menu.hidePopover();
        menu.removeAttribute('popover');
      }
    }
    document.addEventListener(
      'toggle',
      (event) => {
        if (event.target.id === 'appointment-service' || event.target.id === 'editor')
          syncServiceWindow();
      },
      true,
    );
    actions.$('#editor').addEventListener('close', syncServiceWindow);
    window.addEventListener('resize', syncServiceWindow);
    window.visualViewport?.addEventListener('resize', syncServiceWindow);
    window.visualViewport?.addEventListener('scroll', syncServiceWindow);
    let dismissOutsideClick = false;
    document.addEventListener(
      'pointerdown',
      (e) => {
        dismissOutsideClick = false;
        const picker = actions.$('#appointment-service');
        if (!picker?.open || picker.contains(e.target)) return;
        picker.open = false;
        if (!picker.hasAttribute('data-service-window')) return;
        // The first outside tap dismisses the window without activating the form behind it.
        dismissOutsideClick = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        picker.querySelector('summary').focus({ preventScroll: true });
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        if (!dismissOutsideClick) return;
        dismissOutsideClick = false;
        if (!e.detail) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    actions.$('#form-content').addEventListener('keydown', (e) => {
      const picker = actions.$('#appointment-service');
      if (e.target.id === 'appointment-service-search' && picker?.open) {
        if (e.key === 'Enter') e.preventDefault();
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          actions
            .$('#appointment-service-groups')
            .querySelector('summary, button:not(:disabled)')
            ?.focus();
        }
      }
      if (e.key !== 'Escape' || !picker?.open || !picker.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      picker.open = false;
      picker.querySelector('summary').focus({ preventScroll: true });
    });
    actions.$('#form-content').addEventListener('input', (e) => {
      if (e.target.id !== 'appointment-service-search' || state.editorMode?.kind !== 'appointment')
        return;
      renderServiceGroups();
      actions.$('#appointment-service-groups').scrollTop = 0;
    });
    actions.$('#form-content').addEventListener('change', (e) => {
      if (e.target.name === 'staffId' && state.editorMode?.kind === 'appointment' && !state.busy) {
        const mode = state.editorMode;
        if (e.target.value === mode.procedureStaffId) return;
        if (
          (mode.serviceItems.length || mode.appointmentLegacyService) &&
          !window.confirm('При смене сотрудника выбранные услуги будут убраны. Продолжить?')
        ) {
          e.target.value = mode.procedureStaffId;
          return;
        }
        mode.procedureStaffId = e.target.value;
        mode.serviceItems = [];
        mode.appointmentLegacyService = '';
        mode.appointmentLegacyDuration = 0;
        actions.$('#appointment-service').open = false;
        actions.$('#appointment-service-search').value = '';
        renderServiceGroups();
        renderAppointmentProcedures(true);
        return;
      }
    });
    actions.$('#form-content').addEventListener('click', (e) => {
      if (e.target.closest('[data-close-service-picker]')) {
        e.preventDefault();
        const picker = actions.$('#appointment-service');
        picker.open = false;
        picker.querySelector('summary').focus({ preventScroll: true });
        return;
      }
      if (e.target.closest('#appointment-new-service')) {
        e.stopPropagation();
        if (state.busy || state.editorMode?.kind !== 'appointment' || !actions.canEditServices())
          return;
        const staffId = actions.$('#form-content [name="staffId"]')?.value || '';
        if (actions.suspendAppointmentEditor()) actions.openServiceForm(null, '', staffId);
        return;
      }
      const heading = e.target.closest('.appointment-service-group > summary');
      if (heading && state.editorMode?.kind === 'appointment') {
        e.preventDefault();
        e.stopPropagation();
        if (state.busy) return;
        const group = heading.parentElement,
          open = !group.open;
        actions
          .$('#appointment-service-groups')
          .querySelectorAll('details')
          .forEach((item) => {
            item.open = item === group && open;
          });
        return;
      }
      const add = e.target.closest('[data-appointment-service]');
      if (add && state.editorMode?.kind === 'appointment' && !state.busy) {
        e.stopPropagation();
        const service = actions
          .servicesForStaff()
          .find((s) => s.id === add.dataset.appointmentService);
        if (!service) return;
        const mode = state.editorMode,
          items = mode.serviceItems;
        const snapshot = actions.serviceSnapshot(service);
        if (items.some((s) => s.id === service.id)) actions.toast('Эта услуга уже добавлена');
        else if (items.length >= 100) actions.toast('В одну запись можно добавить до 100 услуг');
        else if (total() + snapshot.duration > 1440)
          actions.toast('Общая длительность не должна превышать 1440 минут');
        else if ([names(), snapshot.name].filter(Boolean).join(' + ').length > 2000)
          actions.toast('Суммарные названия услуг слишком длинные. Создайте отдельную запись');
        else {
          items.push(snapshot);
          renderAppointmentProcedures(true);
          const picker = actions.$('#appointment-service');
          picker.open = false;
          resetServiceSearch();
          picker.querySelector('summary').focus({ preventScroll: true });
        }
        return;
      }
      const remove = e.target.closest('[data-remove-appointment-procedure]'),
        legacy = e.target.closest('[data-remove-appointment-legacy]');
      if ((!remove && !legacy) || state.editorMode?.kind !== 'appointment' || state.busy) return;
      e.stopPropagation();
      if (remove)
        state.editorMode.serviceItems = state.editorMode.serviceItems.filter(
          (s) => s.id !== remove.dataset.removeAppointmentProcedure,
        );
      if (legacy) {
        state.editorMode.appointmentLegacyService = '';
        state.editorMode.appointmentLegacyDuration = 0;
      }
      renderAppointmentProcedures(true);
    });
  }
  return { mountAppointmentProcedures, bindAppointmentProcedureEvents, refreshAppointmentServices };
}
