function createWorkspaceView(state, actions) {
  const roomIcon =
    '<span class="workspace-room-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v18m5-10v2"/></svg></span>';
  const canAssignRooms = () => state.workspace.canEdit || state.workspace.canEditRoomAssignments;
  function workspaceSettingsHtml() {
    return actions.settingsSectionHtml(
      'Кабинеты и занятость',
      'workspace-settings',
      '<p>Загружаем кабинеты…</p>',
    );
  }
  function workspaceRoomEditorHtml(room, index = 0, expanded = false) {
    const specialists = state.workspace.members.filter((member) =>
      ['owner', 'cosmetologist'].includes(member.role),
    );
    const disabled = state.workspace.canEdit ? '' : 'disabled',
      assignmentDisabled = canAssignRooms() ? '' : 'disabled',
      overlapDisabled =
        state.workspace.canEdit || state.workspace.canEditRoomOverlap ? '' : 'disabled',
      multiple = room.staffMode === 'multiple',
      soleAssignedStaff =
        specialists.length === 1 &&
        room.staffIds.length === 1 &&
        room.staffIds[0] === specialists[0].accountId;
    const staff = specialists
      .map((member) =>
        [
          `<label>`,
          `<input type="${multiple ? 'checkbox' : 'radio'}" `,
          `name="staff-${actions.esc(room.id)}" data-room-staff value="${actions.esc(member.accountId)}" ${room.staffIds.includes(member.accountId) ? 'checked' : ''} ${assignmentDisabled}><span class="workspace-staff-person"><strong>${actions.esc(member.displayName || 'Имя не заполнено')}</strong><small>${actions.esc(state.roleNames[member.role] || member.role)}${member.status === 'active' ? '' : ' · доступ приостановлен'}</small></span>`,
          `</label>`,
        ].join(''),
      )
      .join('');
    return [
      `<article class="workspace-room" `,
      `data-room-id="${actions.esc(room.id)}" data-room-expanded="${expanded}">`,
      '<div class="workspace-room-overview"><div>',
      `<strong data-room-summary-name>${actions.esc(room.name)}</strong>`,
      `<small data-room-summary-staff>${actions.esc(
        specialists
          .filter((member) => room.staffIds.includes(member.accountId))
          .map((member) => member.displayName || 'Имя не заполнено')
          .join(', ') || 'Сотрудники не назначены',
      )}${room.active ? '' : ' · Не действует'}</small></div>`,
      `<button type="button" class="text-btn" data-room-edit aria-expanded="${expanded}" aria-controls="room-heading-${actions.esc(room.id)} room-assignments-${actions.esc(room.id)}">${expanded ? 'Свернуть' : 'Изменить'}</button></div>`,
      `<div class="workspace-room-heading" id="room-heading-${actions.esc(room.id)}">`,
      `<label class="field">Название кабинета<span class="workspace-room-name-control"><input data-room-name value="${actions.esc(room.name)}" `,
      `maxlength="100" required ${disabled}>`,
      `<span class="workspace-room-number" data-room-number aria-hidden="true">${index + 1}</span></span></label>`,
      `<label class="telegram-switch">`,
      `<input type="checkbox" data-room-active ${room.active ? 'checked' : ''} ${disabled}> Действует</label>`,
      disabled || room.id === 'main'
        ? ''
        : '<div class="workspace-room-delete"><button type="button" class="text-btn danger" data-remove-room>Удалить</button>' +
          actions.settingsHelpHtml(
            'Удаление кабинета',
            'Удалить можно только пустой кабинет — без записей, в том числе прошлых. Если записи есть, снимите отметку «Действует»: кабинет отключится, а история сохранится. В организации должен остаться хотя бы один действующий кабинет.',
          ) +
          '</div>',
      '</div>',
      `<div class="workspace-room-assignments" id="room-assignments-${actions.esc(room.id)}" ${soleAssignedStaff ? 'hidden' : ''}><div class="field workspace-staff-mode"><div class="settings-label-row">`,
      `<label for="room-mode-${actions.esc(room.id)}">Кто здесь принимает</label>`,
      `<span class="workspace-sharing-hint" ${multiple ? '' : 'hidden'}>`,
      actions.settingsHelpHtml(
        'Несколько сотрудников в кабинете',
        'Кабинет доступен выбранным сотрудникам. Возможность одновременных записей задаётся галочкой «Запретить пересечения в этом кабинете».',
      ),
      '</span></div>',
      `<select id="room-mode-${actions.esc(room.id)}" data-room-staff-mode ${assignmentDisabled}>`,
      `<option value="single" ${multiple ? '' : 'selected'}>Один сотрудник</option>`,
      `<option value="multiple" ${multiple ? 'selected' : ''}>Несколько сотрудников</option>`,
      `</select>`,
      `</div>`,
      `<fieldset>`,
      `<legend>Выберите ${multiple ? 'сотрудников' : 'сотрудника'}</legend>`,
      `<div class="workspace-staff">${staff}</div>`,
      `</fieldset></div>`,
      '<div class="workspace-protection"><h4>Занятость кабинета</h4><div class="settings-label-row">',
      '<label class="telegram-switch"><input type="checkbox" data-room-prevent-overlap ',
      `aria-label="Запретить пересечения в кабинете ${actions.esc(room.name)}" ${room.preventOverlap !== false ? 'checked' : ''} ${overlapDisabled}></label>`,
      '<span>Запретить пересечения в этом кабинете</span>',
      actions.settingsHelpHtml(
        'Пересечения в кабинете',
        'При включённой галочке в этом кабинете может быть только один приём в каждый момент. Если снять её, разные сотрудники смогут принимать одновременно. Правила остальных кабинетов не меняются. Занятость одного сотрудника настраивается отдельно.',
      ),
      '</div></div>',
      `</article>`,
    ].join('');
  }
  function renderWorkspaceSettings() {
    const root = actions.$('#workspace-settings');
    if (!root) return;
    const w = state.workspace,
      disabled = w.canEdit ? '' : 'disabled';
    if (!actions.canManageTeam()) {
      root.innerHTML = [
        `<section class="workspace-layout-bar" data-room-layout="${w.roomLayout === 'multiple' ? 'multiple' : 'single'}"><div class="workspace-block-heading">`,
        roomIcon,
        '<h3>Доступные кабинеты</h3></div><div class="workspace-room-tags">',
        w.rooms
          .map((r) => `<span class="workspace-room-tag">${actions.esc(r.name)}</span>`)
          .join('') || '<p class="form-hint">Пока не назначены</p>',
        '</div></section>',
      ].join('');
      return;
    }
    root.innerHTML = [
      `<form id="workspace-settings-form" data-workspace-revision="${w.revision}">`,
      `<section class="workspace-layout-bar" data-room-layout="${w.roomLayout === 'multiple' ? 'multiple' : 'single'}"><div class="workspace-block-heading">`,
      roomIcon,
      '<div><h3>Кабинеты</h3><p class="form-hint">Помещения и сотрудники, которые в них принимают.</p></div></div>',
      `<label class="field workspace-layout-field">Количество кабинетов<select name="roomLayout" ${disabled}>`,
      `<option value="single" ${w.roomLayout === 'single' ? 'selected' : ''}>Один кабинет</option>`,
      `<option value="multiple" ${w.roomLayout === 'multiple' ? 'selected' : ''}>Несколько кабинетов</option>`,
      `</select>`,
      `</label></section>`,
      `<div id="workspace-room-list">${w.rooms.map((room, index) => workspaceRoomEditorHtml(room, index)).join('')}</div>${w.canEdit ? `<button type="button" class="secondary" id="workspace-add-room" ${w.roomLayout === 'multiple' ? '' : 'hidden'}>+ Добавить кабинет</button>` : ''}`,
      `<input type="checkbox" name="enabled" hidden ${w.enabled ? 'checked' : ''} ${disabled}>`,
      canAssignRooms()
        ? `<div class="workspace-settings-actions"><button type="submit" class="primary">${w.canEdit || w.canEditRoomOverlap ? 'Сохранить настройки' : 'Сохранить назначения'}</button></div>`
        : '',
      w.canEdit
        ? ''
        : '<div class="settings-label-row"><span class="form-hint">Названия, количество и отключение кабинетов — у владельца</span>' +
          actions.settingsHelpHtml(
            'Настройки кабинетов',
            'Администратор назначает сотрудников в существующие кабинеты и разрешает или запрещает пересечения в каждом из них. Названия, количество и отключение кабинетов настраивает владелец. Готовые записи сохраняются: при необходимости сначала перенесите будущие приёмы вручную.',
          ) +
          '</div>',
      '<p id="workspace-settings-message" ',
      `role="status">`,
      `</p>`,
      `</form>`,
    ].join('');
  }
  function workspaceSettingsMessage(form, text) {
    form.querySelector('#workspace-settings-message').textContent = text;
  }
  function syncWorkspaceRoomLayout(form) {
    const add = form.querySelector('#workspace-add-room');
    if (add) add.hidden = form.elements.roomLayout.value !== 'multiple';
    form.querySelector('.workspace-layout-bar').dataset.roomLayout = form.elements.roomLayout.value;
  }
  function expandWorkspaceRoom(row, expanded) {
    row.dataset.roomExpanded = String(expanded);
    const button = row.querySelector('[data-room-edit]');
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded ? 'Свернуть' : 'Изменить';
  }
  function syncWorkspaceRoomSummary(row) {
    if (!row) return;
    row.querySelector('[data-room-summary-name]').textContent =
      row.querySelector('[data-room-name]').value || 'Название не заполнено';
    const names = [...row.querySelectorAll('[data-room-staff]:checked')]
      .map((input) => input.closest('label').querySelector('strong').textContent)
      .join(', ');
    row.querySelector('[data-room-summary-staff]').textContent =
      (names || 'Сотрудники не назначены') +
      (row.querySelector('[data-room-active]').checked ? '' : ' · Не действует');
  }
  function renderWorkspaceError(text) {
    const root = actions.$('#workspace-settings');
    if (root) root.innerHTML = '<p class="error">' + actions.esc(text) + '</p>';
  }
  return {
    workspaceSettingsHtml,
    workspaceRoomEditorHtml,
    renderWorkspaceSettings,
    workspaceSettingsMessage,
    syncWorkspaceRoomLayout,
    expandWorkspaceRoom,
    syncWorkspaceRoomSummary,
    renderWorkspaceError,
  };
}
