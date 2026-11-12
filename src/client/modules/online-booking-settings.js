function createOnlineBookingSettings(state, actions) {
  let snapshot = null,
    snapshotScope = '',
    sequence = 0;
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const formValues = (form) =>
    JSON.stringify(
      [...form.querySelectorAll('input, select, textarea')].map((field) => [
        field.name,
        field.value,
        field.checked,
      ]),
    );
  const ruleLabels = {
    mode: { any: 'Любое свободное время', sequential: 'Последовательно' },
    bookingMode: { approval: 'С согласованием', classic: 'Сразу в календарь' },
  };
  const staffRule = (id, field) =>
    Object.hasOwn(ruleLabels[field], snapshot.staff[id]?.[field])
      ? snapshot.staff[id][field]
      : 'inherit';
  function staffRuleSelect(id, field, label, attribute) {
    const value = staffRule(id, field);
    return [
      `<label class="booking-member-rule">${label}<select name="${field}:${actions.esc(id)}" ${attribute}="${actions.esc(id)}">`,
      `<option value="inherit" ${value === 'inherit' ? 'selected' : ''}>Как в организации</option>`,
      ...Object.entries(ruleLabels[field]).map(
        ([key, text]) =>
          `<option value="${key}" ${value === key ? 'selected' : ''}>${text}</option>`,
      ),
      '</select></label>',
    ].join('');
  }
  function updateStaffRules(form) {
    if (!form) return;
    const defaults = {
      mode: form.querySelector('#booking-settings-mode').value,
      bookingMode: form.querySelector('#booking-settings-kind').value,
    };
    const inherited = { mode: 0, bookingMode: 0 };
    let hasApproval = defaults.bookingMode === 'approval';
    for (const row of form.querySelectorAll('[data-booking-member]')) {
      const enabled = row.querySelector('[data-booking-enabled]').checked;
      for (const [field, attribute] of [
        ['mode', 'data-booking-staff-mode'],
        ['bookingMode', 'data-booking-staff-kind'],
      ]) {
        const select = row.querySelector(`[${attribute}]`);
        const followsDefault = select.value === 'inherit';
        const effective = followsDefault ? defaults[field] : select.value;
        select.querySelector('[value="inherit"]').textContent =
          'Как в организации — ' + ruleLabels[field][defaults[field]];
        row.querySelector(`[data-booking-effective="${field}"]`).textContent =
          ruleLabels[field][effective] + (followsDefault ? ' (общие правила)' : '');
        if (enabled && followsDefault) inherited[field]++;
        if (enabled && field === 'bookingMode' && effective === 'approval') hasApproval = true;
      }
    }
    const hint = form.querySelector('[data-booking-inheritance]');
    if (hint)
      hint.textContent = `Общие правила для принимающих сотрудников: выбор времени — ${inherited.mode}; оформление — ${inherited.bookingMode}.`;
    const reservation = form.querySelector('[data-booking-reservation-field]');
    if (reservation) reservation.hidden = !hasApproval;
  }
  function leadTimeOptions(current) {
    const periods = [
      15,
      30,
      45,
      60,
      ...Array.from({ length: 23 }, (_, i) => (i + 2) * 60),
      ...Array.from({ length: 6 }, (_, i) => (i + 2) * 1440),
      14 * 1440,
    ];
    if (!periods.includes(current)) periods.push(current);
    return periods
      .sort((a, b) => a - b)
      .map((minutes) => {
        const text =
          minutes === 0
            ? 'Без ограничения'
            : minutes >= 2880 && minutes % 1440 === 0
              ? minutes / 1440 + (minutes / 1440 < 5 ? ' дня' : ' дней')
              : minutes > 60 && minutes % 60 === 0
                ? minutes / 60 + ' ч.'
                : minutes + ' мин.';
        return `<option value="${minutes}" ${minutes === current ? 'selected' : ''}>${text}</option>`;
      })
      .join('');
  }
  function onlineBookingSettingsHtml() {
    snapshot = null;
    snapshotScope = '';
    return actions.settingsSectionHtml(
      'Онлайн-запись',
      'online-booking-settings',
      '<p class="settings-loading">Загрузка настроек…</p>',
    );
  }
  function renderOnlineBookingSettings() {
    const root = actions.$('#online-booking-settings');
    if (!root || !snapshot) return;
    const esc = actions.esc;
    if (!snapshot.canManage) {
      root.innerHTML = `<p>Управление своими заявками: <strong>${snapshot.canManageOwnRequests ? 'разрешено' : 'выключено владельцем или администратором'}</strong>.</p><button type="button" class="secondary" data-management-tab="requests">Открыть заявки</button>`;
      return;
    }
    const enabled = (m) => snapshot.staff[m.accountId]?.enabled ?? m.role !== 'salon_admin';
    const members = snapshot.members
      .filter((m) => ['owner', 'cosmetologist'].includes(m.role))
      .map((m) =>
        [
          `<div class="online-booking-member" data-booking-member="${esc(m.accountId)}"><strong>${esc(m.displayName || 'Имя не заполнено')}</strong>`,
          `<small>${esc(m.specialty || state.roleNames[m.role] || '')}</small>`,
          `<label class="check-field"><input type="checkbox" data-booking-enabled="${esc(m.accountId)}" ${enabled(m) ? 'checked' : ''}>Принимает по онлайн-записи</label>`,
          m.role === 'cosmetologist'
            ? [
                `<label class="check-field"><input type="checkbox" data-booking-permission="${esc(m.accountId)}" `,
                `${snapshot.staff[m.accountId]?.manageOwnRequests !== false ? 'checked' : ''}>Может управлять своими заявками</label>`,
              ].join('')
            : '',
          '<p class="booking-member-effective"><span data-booking-effective="mode"></span><span data-booking-effective="bookingMode"></span></p>',
          '<details class="booking-member-rules"><summary>Настроить</summary><div class="booking-member-rule-fields">',
          staffRuleSelect(m.accountId, 'mode', 'Выбор времени', 'data-booking-staff-mode'),
          staffRuleSelect(m.accountId, 'bookingMode', 'Оформление', 'data-booking-staff-kind'),
          '</div></details>',
          '</div>',
        ].join(''),
      )
      .join('');
    root.innerHTML = [
      '<div class="booking-health-panel" data-booking-health-panel role="status" hidden></div>',
      '<div id="booking-publication"></div>',
      `<form id="online-booking-settings-form" ${snapshot.publication?.enabled ? '' : 'hidden'}><p class="booking-defaults-heading">Общие правила организации</p><div class="online-booking-fields">`,
      '<div class="field"><div class="settings-label-row"><span id="booking-settings-kind-label">Вид онлайн-записи</span>',
      actions.settingsHelpHtml(
        'Вид онлайн-записи',
        'С согласованием: сотрудник принимает заявку. Сразу в календарь: выбранное свободное время сразу записывается, клиент получает подтверждение на сайте. Посещение автоматически не оформляется. Ниже можно задать отдельное правило сотруднику.',
      ),
      `</div><input type="hidden" id="booking-settings-kind" name="bookingMode" value="${snapshot.bookingMode === 'classic' ? 'classic' : 'approval'}">`,
      '<div class="booking-kind-switch" role="group" aria-labelledby="booking-settings-kind-label">',
      `<button type="button" class="secondary" data-booking-kind="approval" aria-pressed="${snapshot.bookingMode !== 'classic'}">С согласованием</button>`,
      `<button type="button" class="secondary" data-booking-kind="classic" aria-pressed="${snapshot.bookingMode === 'classic'}">Сразу в календарь</button></div></div>`,
      '<div class="field"><div class="settings-label-row"><span id="booking-settings-mode-label">Выбор времени</span>',
      actions.settingsHelpHtml(
        'Выбор времени онлайн-записи',
        'Клиентам доступны только открытые рабочие дни. Любое свободное время: все подходящие начала приёма. Последовательно: одно самое раннее подходящее время на выбранный день; после его занятия доступно следующее. Правило можно изменить отдельно для сотрудника. Ручная и голосовая запись этим выбором не ограничены.',
      ),
      `</div><input type="hidden" id="booking-settings-mode" name="mode" value="${snapshot.mode === 'sequential' ? 'sequential' : 'any'}">`,
      '<div class="booking-kind-switch" role="group" aria-labelledby="booking-settings-mode-label">',
      `<button type="button" class="secondary" data-booking-time-mode="any" aria-pressed="${snapshot.mode !== 'sequential'}">Любое свободное время</button>`,
      `<button type="button" class="secondary" data-booking-time-mode="sequential" aria-pressed="${snapshot.mode === 'sequential'}">Последовательно</button></div></div>`,
      '<div class="field"><div class="settings-label-row"><label for="booking-settings-lead">За сколько до начала закрывать запись</label>',
      actions.settingsHelpHtml(
        'Когда закрывать онлайн-запись',
        'Клиент может записаться только заранее, не позднее выбранного срока до начала приёма. Это не время отправки напоминания. Уже созданные записи не меняются.',
      ),
      '</div><select id="booking-settings-lead" name="minimumLeadMinutes" required>',
      leadTimeOptions(snapshot.minimumLeadMinutes),
      '</select><small>Например, 14 дней: клиенту нужно записаться минимум за две недели до приёма.</small></div>',
      `<div class="field" data-booking-reservation-field ${snapshot.bookingMode === 'classic' ? 'hidden' : ''}><div class="settings-label-row"><label for="booking-settings-reservation">На сколько минут бронировать время</label>`,
      actions.settingsHelpHtml(
        'Резерв заявки',
        'Общий срок резерва для сотрудников с оформлением «С согласованием». Запрос другого времени не резервирует слот. При записи сразу в календарь резерв не используется.',
      ),
      '</div><input id="booking-settings-reservation" type="number" name="reservationMinutes" min="1" max="1440" step="1" required ',
      `value="${snapshot.reservationMinutes}"><small>Если заявку не приняли за это время, бронь снимается.</small></div></div>`,
      `<div class="settings-label-row"><label class="check-field booking-price-setting"><input type="checkbox" name="showPrices" ${snapshot.showPrices !== false ? 'checked' : ''}>Показывать стоимость услуг в онлайн-записи</label>`,
      actions.settingsHelpHtml(
        'Стоимость в онлайн-записи',
        'При выключении клиент видит услуги и длительность, но не цены и общую сумму. Стоимость в картотеке сохраняется.',
      ),
      '</div>',
      '<p class="booking-inheritance-hint" data-booking-inheritance></p>',
      '<details class="compact-accordion"><summary>Сотрудники</summary>',
      `<div class="online-booking-members">${members}</div></details>`,
      '<button type="submit" class="primary">Сохранить правила</button>',
      '<p id="booking-settings-result" role="status"></p></form>',
    ].join('');
    updateStaffRules(root.querySelector('#online-booking-settings-form'));
    actions.mountBookingPublication(snapshot);
    actions.renderBookingHealth();
    void actions.refreshBookingHealth();
  }
  async function loadOnlineBookingSettings() {
    if (!state.multiUser || state.currentView !== 'settings') return;
    const key = scope(),
      id = ++sequence;
    try {
      const result = await actions.request('/api/online-booking/settings');
      if (key !== scope() || id !== sequence || state.currentView !== 'settings') return;
      snapshot = result;
      snapshotScope = key;
      renderOnlineBookingSettings();
    } catch (error) {
      if (key === scope() && id === sequence) {
        const root = actions.$('#online-booking-settings');
        if (root) root.textContent = error.message;
      }
    }
  }
  function bindOnlineBookingSettingsEvents() {
    const resetSaveFeedback = (event) => {
      const form = event.target.closest('#online-booking-settings-form');
      if (!form || snapshotScope !== scope()) return;
      const button = form.querySelector('button[type="submit"]');
      if (button.dataset.saveState === 'saved') {
        delete button.dataset.saveState;
        button.textContent = 'Сохранить правила';
        button.disabled = state.busy;
      }
      const result = form.querySelector('#booking-settings-result');
      if (result) result.textContent = '';
    };
    document.addEventListener('input', resetSaveFeedback);
    document.addEventListener('change', resetSaveFeedback);
    document.addEventListener('click', (e) => {
      const button = e.target.closest('[data-booking-kind], [data-booking-time-mode]');
      if (!button || state.busy || !snapshot || snapshotScope !== scope()) return;
      const kind = button.hasAttribute('data-booking-kind');
      const value = kind ? button.dataset.bookingKind : button.dataset.bookingTimeMode;
      const field = button
        .closest('form')
        ?.querySelector(kind ? '#booking-settings-kind' : '#booking-settings-mode');
      if (!field || field.value === value) return;
      field.value = value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    document.addEventListener('change', (e) => {
      const form = e.target.closest('#online-booking-settings-form');
      if (!form || !snapshot || snapshotScope !== scope()) return;
      if (
        e.target.matches(
          '#booking-settings-mode, #booking-settings-kind, [data-booking-enabled], [data-booking-staff-mode], [data-booking-staff-kind]',
        )
      )
        updateStaffRules(form);
      if (e.target.id === 'booking-settings-mode') {
        for (const button of e.target
          .closest('form')
          ?.querySelectorAll('[data-booking-time-mode]') || [])
          button.setAttribute(
            'aria-pressed',
            String(button.dataset.bookingTimeMode === e.target.value),
          );
        return;
      }
      if (e.target.id === 'booking-settings-kind') {
        for (const button of e.target.closest('form')?.querySelectorAll('[data-booking-kind]') ||
          [])
          button.setAttribute(
            'aria-pressed',
            String(button.dataset.bookingKind === e.target.value),
          );
        return;
      }
    });
    document.addEventListener('submit', async (e) => {
      if (e.target.id !== 'online-booking-settings-form') return;
      e.preventDefault();
      if (!snapshot || state.busy || snapshotScope !== scope()) return;
      const form = e.target,
        key = scope(),
        button = form.querySelector('button[type="submit"]');
      const fields = new FormData(form),
        submittedValues = formValues(form),
        staff = { ...snapshot.staff },
        services = { ...snapshot.services };
      const enabledInputs = new Map(
        [...form.querySelectorAll('[data-booking-enabled]')].map((input) => [
          input.dataset.bookingEnabled,
          input,
        ]),
      );
      const permissionInputs = new Map(
        [...form.querySelectorAll('[data-booking-permission]')].map((input) => [
          input.dataset.bookingPermission,
          input,
        ]),
      );
      const ruleInputs = new Map(
        [...form.querySelectorAll('[data-booking-member]')].map((row) => [
          row.dataset.bookingMember,
          row,
        ]),
      );
      for (const m of snapshot.members) {
        if (!['owner', 'cosmetologist'].includes(m.role)) continue;
        const check = enabledInputs.get(m.accountId);
        const permission = permissionInputs.get(m.accountId);
        const rules = ruleInputs.get(m.accountId);
        if (!check || !rules) continue;
        staff[m.accountId] = {
          ...staff[m.accountId],
          enabled: check.checked,
          manageOwnRequests: permission?.checked ?? staff[m.accountId]?.manageOwnRequests ?? true,
          mode: rules.querySelector('[data-booking-staff-mode]').value,
          bookingMode: rules.querySelector('[data-booking-staff-kind]').value,
        };
      }
      // Old assignment metadata is retained for compatibility; ownership comes from the catalog.
      const catalogIds = new Set(snapshot.catalog.map((service) => service.id));
      for (const id of Object.keys(services)) if (!catalogIds.has(id)) delete services[id];
      state.busy = true;
      button.disabled = true;
      button.textContent = 'Сохраняем…';
      try {
        const saved = await actions.request('/api/online-booking/settings', {
          method: 'POST',
          body: JSON.stringify({
            revision: snapshot.revision,
            mode: fields.get('mode'),
            bookingMode: fields.get('bookingMode'),
            minimumLeadMinutes: Number(fields.get('minimumLeadMinutes')),
            reservationMinutes: Number(fields.get('reservationMinutes')),
            showPrices: fields.get('showPrices') === 'on',
            staff,
            services,
          }),
        });
        if (key !== scope() || !form.isConnected) return;
        // POST returns saved rules; catalog and publication belong to the GET snapshot.
        snapshot = { ...snapshot, ...saved };
        snapshotScope = key;
        const unchanged = formValues(form) === submittedValues;
        if (unchanged) {
          actions.markSettingsSaved(form);
          button.textContent = 'Сохранено';
          button.dataset.saveState = 'saved';
          button.disabled = true;
        }
        void actions.refreshBookingHealth({ force: true });
        const result = actions.$('#booking-settings-result');
        if (result)
          result.textContent = unchanged
            ? 'Правила сохранены'
            : 'Правила сохранены. Новые изменения ещё не сохранены.';
      } catch (error) {
        if (key === scope() && form.isConnected)
          form.querySelector('#booking-settings-result').textContent = error.message;
      } finally {
        state.busy = false;
        if (button.isConnected) {
          button.disabled = button.dataset.saveState === 'saved';
          if (!button.disabled) button.textContent = 'Сохранить правила';
        }
      }
    });
  }
  return {
    onlineBookingSettingsHtml,
    loadOnlineBookingSettings,
    bindOnlineBookingSettingsEvents,
  };
}
