function createStaffBookingRules(state, actions) {
  const confirming = new WeakSet();
  const canEditRules = () => state.workspace.canEditStaffRules ?? state.workspace.canEdit;
  const protectedStaff = (id) =>
    state.workspace.staffRules?.find((rule) => rule.staffId === id)?.preventOverlap ??
    state.workspace.enabled;
  const ruleInputs = (form) =>
    [...form.elements].filter((input) => input.matches('[data-workspace-staff-rule]'));
  const formRules = (form) =>
    ruleInputs(form).map((input) => ({
      staffId: input.dataset.workspaceStaffRule,
      preventOverlap: input.checked,
    }));
  const headingHtml = (title, subtitle) =>
    '<div class="staff-booking-rules-heading"><span class="staff-booking-rules-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-12 5 3 3 5-5"/></svg></span><div class="staff-booking-rules-title"><h4>' +
    actions.esc(title) +
    '</h4><p class="form-hint">' +
    actions.esc(subtitle) +
    '</p></div>';
  function ruleRow(member) {
    const name = member.displayName || 'Имя не заполнено',
      blocked = protectedStaff(member.accountId);
    return [
      `<div class="staff-booking-rule-row" data-staff-rule-state="${blocked ? 'blocked' : 'allowed'}">`,
      '<div class="staff-booking-rule-person">',
      `<strong>${actions.esc(name)}</strong><small>${actions.esc(state.roleNames[member.role] || member.role)}${member.accountId === actions.accountId() ? ' · вы' : ''}${member.status === 'active' ? '' : ' · доступ приостановлен'}</small></div>`,
      '<div class="staff-booking-rule-choice">',
      `<span data-staff-rule-label>${blocked ? 'Запрещены' : 'Разрешены'}</span>`,
      `<label class="staff-booking-rule-check"><input type="checkbox" name="staff-overlap-${actions.esc(member.accountId)}" data-workspace-staff-rule="${actions.esc(member.accountId)}" aria-label="Запретить одновременные записи к сотруднику: ${actions.esc(name)}" ${blocked ? 'checked' : ''} ${canEditRules() ? '' : 'disabled'}></label></div></div>`,
    ].join('');
  }
  function renderStaffBookingRules({ rebase = false, force = false } = {}) {
    const root = actions.$('#staff-booking-rules');
    if (!root) return;
    const prior = root.querySelector('#staff-booking-rules-form');
    if (!force && prior && (confirming.has(prior) || prior.dataset.unknown === 'true')) return;
    if (!force && prior && JSON.stringify(formRules(prior)) !== prior.dataset.baseline) {
      if (rebase) prior.dataset.revision = String(state.workspace.revision);
      return;
    }
    const slots = actions.$('#team-settings')?.querySelectorAll('[data-team-rule-staff]');
    if (actions.canManageTeam() && slots?.length) {
      const members = state.teamAccess?.members || state.workspace.members;
      root.innerHTML =
        '<form id="staff-booking-rules-form"><p id="staff-booking-rules-message" class="form-hint" role="status"></p><button type="button" class="secondary" data-staff-rules-refresh hidden>Обновить состояние</button></form>';
      for (const slot of slots) {
        const member = members.find((item) => item.accountId === slot.dataset.teamRuleStaff);
        if (!member) {
          slot.innerHTML = '<p class="form-hint">Загружаем правило…</p>';
          continue;
        }
        const blocked = protectedStaff(member.accountId),
          name = member.displayName || 'Имя не заполнено';
        slot.innerHTML = [
          `<div class="staff-booking-rule-row" data-staff-rule-state="${blocked ? 'blocked' : 'allowed'}">`,
          '<div class="staff-booking-rule-person"><strong>Одновременные записи</strong><small>Во всех кабинетах</small></div>',
          '<div class="staff-booking-rule-choice">',
          `<span data-staff-rule-label>${blocked ? 'Запрещены' : 'Разрешены'}</span>`,
          '<label class="staff-booking-rule-check">',
          `<input type="checkbox" name="staff-overlap-${actions.esc(member.accountId)}" form="staff-booking-rules-form" `,
          `data-workspace-staff-rule="${actions.esc(member.accountId)}" data-staff-name="${actions.esc(name)}" `,
          `aria-label="Запретить одновременные записи к сотруднику: ${actions.esc(name)}" `,
          `${blocked ? 'checked' : ''} ${canEditRules() ? '' : 'disabled'}></label></div></div>`,
          '<p class="form-hint member-rule-hint">Правила кабинетов действуют отдельно. Онлайн-запись предлагает только свободное время.</p>',
        ].join('');
      }
      const form = root.querySelector('#staff-booking-rules-form');
      form.dataset.revision = String(state.workspace.revision);
      form.dataset.baseline = JSON.stringify(formRules(form));
      actions.markSettingsSaved(form);
      return;
    }
    if (!actions.canManageTeam()) {
      const blocked = protectedStaff(actions.accountId());
      root.innerHTML = [
        '<section class="staff-booking-rules-card">',
        headingHtml('Мои правила записи', 'Одновременные записи · во всех кабинетах'),
        '</div><div class="staff-booking-rules-list">',
        `<div class="staff-booking-rule-row" data-staff-rule-state="${blocked ? 'blocked' : 'allowed'}">`,
        '<div class="staff-booking-rule-person"><strong>Одновременные записи ко мне</strong></div>',
        `<div class="staff-booking-rule-choice"><span data-staff-rule-label>${blocked ? 'Запрещены' : 'Разрешены'}</span></div></div></div>`,
        '<p class="form-hint">Правило меняет владелец или администратор. Настройки кабинетов действуют независимо.</p></section>',
      ].join('');
      return;
    }
    const w = state.workspace;
    if (!w.members.length) {
      root.innerHTML = '<p class="form-hint">Загружаем правила записи…</p>';
      return;
    }
    root.innerHTML = [
      '<section class="staff-booking-rules-card">',
      headingHtml('Правила записи к сотрудникам', 'Одновременные записи · во всех кабинетах'),
      actions.settingsHelpHtml(
        'Одновременные записи к сотруднику',
        'Галочка запрещает пересекающиеся по времени записи только к указанному сотруднику, во всех кабинетах. Если снять её, при ручной записи эта проверка отключится. Правила остальных сотрудников не изменятся.\n\n' +
          'Запрет пересечений в каждом кабинете действует независимо. Онлайн-запись по-прежнему предлагает только свободное время специалиста.\n\n' +
          'При постановке и снятии галочки запрашивается подтверждение. После подтверждения правило сохраняется сразу. При включении запрета сервер проверит будущие записи; прежние записи не удаляются.',
      ),
      '</div><form id="staff-booking-rules-form">',
      `<div class="staff-booking-rules-list">${w.members
        .filter((member) => ['owner', 'cosmetologist'].includes(member.role))
        .map(ruleRow)
        .join('')}</div>`,
      canEditRules() ? '' : '<p class="form-hint">Правила меняет владелец или администратор.</p>',
      '<p id="staff-booking-rules-message" class="form-hint" role="status"></p><button type="button" class="secondary" data-staff-rules-refresh hidden>Обновить состояние</button></form></section>',
    ].join('');
    const form = root.querySelector('#staff-booking-rules-form');
    form.dataset.revision = String(w.revision);
    form.dataset.baseline = JSON.stringify(formRules(form));
    actions.markSettingsSaved(form);
  }
  function bindStaffBookingRulesEvents() {
    document.addEventListener('submit', (event) => {
      if (event.target.id === 'staff-booking-rules-form') event.preventDefault();
    });
    document.addEventListener('change', async (event) => {
      const input = event.target;
      if (
        !input.matches('[data-workspace-staff-rule]') ||
        input.form?.id !== 'staff-booking-rules-form'
      )
        return;
      const form = input.form,
        staffRules = JSON.parse(form.dataset.baseline),
        rule = staffRules.find((item) => item.staffId === input.dataset.workspaceStaffRule),
        requested = input.checked,
        original = rule.preventOverlap,
        message = form.querySelector('#staff-booking-rules-message'),
        account = state.account;
      input.checked = original;
      if (
        state.busy ||
        !canEditRules() ||
        input.disabled ||
        confirming.has(form) ||
        requested === original
      )
        return;
      const name =
        input.dataset.staffName ||
        input.closest('.staff-booking-rule-row').querySelector('strong').textContent;
      confirming.add(form);
      form.dataset.confirming = 'true';
      input.disabled = true;
      let saving = false,
        unknown = false;
      try {
        const accepted = await actions.confirmAction(
          requested ? 'Запретить одновременные записи?' : 'Разрешить одновременные записи?',
          `${name}: ${requested ? 'записи на пересекающееся время будут запрещены' : 'при ручной записи запрет пересечений будет выключен'} во всех кабинетах. Правила остальных сотрудников и кабинетов не изменятся.`,
          requested ? 'Запретить' : 'Разрешить',
          'Отмена',
        );
        if (!accepted || state.busy || !form.isConnected || state.account !== account) return;
        rule.preventOverlap = requested;
        const values = { revision: Number(form.dataset.revision), staffRules };
        state.busy = true;
        saving = true;
        message.textContent = 'Сохраняем правило…';
        const result = await actions.request('/api/workspace', {
          method: 'POST',
          body: JSON.stringify(values),
        });
        if (state.account !== account) return;
        state.workspace = result;
        state.roomCacheKey = '';
        state.roomBusy = [];
        // The command changes only staff rules; leave an open room draft untouched.
        const roomsForm = actions.$('#workspace-settings-form');
        if (roomsForm) roomsForm.dataset.workspaceRevision = String(result.revision);
        renderStaffBookingRules({ force: true });
        actions.toast('Правила записи к сотрудникам сохранены');
      } catch (error) {
        if (!form.isConnected || state.account !== account) return;
        unknown = Boolean(error.outcomeUnknown || error.status === 409);
        form.dataset.unknown = String(unknown);
        message.textContent = error.outcomeUnknown
          ? 'Результат сохранения неизвестен. Обновите состояние перед следующим изменением.'
          : error.message;
        form.querySelector('[data-staff-rules-refresh]').hidden = false;
        if (error.outcomeUnknown) {
          const row = input.closest('.staff-booking-rule-row');
          row.dataset.staffRuleState = 'unknown';
          row.querySelector('[data-staff-rule-label]').textContent = 'Неизвестно';
        }
      } finally {
        confirming.delete(form);
        delete form.dataset.confirming;
        if (saving) state.busy = false;
        if (form.isConnected && state.account === account) {
          for (const field of ruleInputs(form)) field.disabled = unknown || !canEditRules();
          if (!unknown) input.focus({ preventScroll: true });
        }
      }
    });
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-staff-rules-refresh]');
      if (!button || state.busy) return;
      const form = button.form,
        account = state.account;
      if (confirming.has(form)) return;
      confirming.add(form);
      button.disabled = true;
      try {
        const result = await actions.request('/api/workspace');
        if (!form.isConnected || state.account !== account) return;
        state.workspace = result;
        state.roomCacheKey = '';
        state.roomBusy = [];
        renderStaffBookingRules({ force: true });
      } catch (error) {
        if (form.isConnected)
          form.querySelector('#staff-booking-rules-message').textContent = error.message;
      } finally {
        confirming.delete(form);
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  return { renderStaffBookingRules, bindStaffBookingRulesEvents };
}
