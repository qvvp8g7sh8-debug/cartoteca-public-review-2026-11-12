function createWorkspaceSettings(state, actions) {
  const canAssignRooms = () => state.workspace.canEdit || state.workspace.canEditRoomAssignments;
  function bindWorkspaceSettingsEvents() {
    document.addEventListener(
      'invalid',
      (e) => {
        const row = e.target.closest('#workspace-settings-form [data-room-id]');
        if (row) actions.expandWorkspaceRoom(row, true);
      },
      true,
    );
    document.addEventListener('input', (e) => {
      actions.syncWorkspaceRoomSummary(e.target.closest('#workspace-settings-form [data-room-id]'));
    });
    document.addEventListener('click', (e) => {
      if (state.busy) return;
      const edit = e.target.closest('#workspace-settings-form [data-room-edit]');
      if (edit) {
        const row = edit.closest('[data-room-id]'),
          name = row.querySelector('[data-room-name]'),
          expanded = row.dataset.roomExpanded !== 'true';
        if (!expanded && !name.checkValidity()) {
          name.reportValidity();
          return;
        }
        actions.expandWorkspaceRoom(row, expanded);
        return;
      }
      if (!state.workspace.canEdit) return;
      if (e.target.closest('#workspace-add-room')) {
        const form = actions.$('#workspace-settings-form'),
          list = form?.querySelector('#workspace-room-list');
        if (!list || list.children.length >= 50 || form.elements.roomLayout.value !== 'multiple')
          return;
        const room = {
          id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          name: 'Кабинет ' + (list.children.length + 1),
          active: true,
          preventOverlap: true,
          staffMode: 'single',
          staffIds: [actions.accountId()],
        };
        list.insertAdjacentHTML(
          'beforeend',
          actions.workspaceRoomEditorHtml(room, list.children.length, true),
        );
        actions.workspaceSettingsMessage(form, '');
        return;
      }
      const remove = e.target.closest('[data-remove-room]');
      if (!remove) return;
      const row = remove.closest('[data-room-id]'),
        form = row.closest('form');
      if (row.dataset.roomId === 'main') return;
      if (
        row.querySelector('[data-room-active]').checked &&
        form.querySelectorAll('[data-room-active]:checked').length === 1
      ) {
        actions.workspaceSettingsMessage(form, 'Нужно оставить хотя бы один действующий кабинет.');
        return;
      }
      if (
        window.confirm(
          'Удалить кабинет? Удалить можно только кабинет без записей, в том числе прошлых. Изменение применится после сохранения настроек.',
        )
      ) {
        row.remove();
        form.querySelectorAll('[data-room-number]').forEach((number, index) => {
          number.textContent = String(index + 1);
        });
      }
    });
    document.addEventListener('change', (e) => {
      const form = e.target.closest('#workspace-settings-form');
      if (!form || state.busy || !canAssignRooms()) return;
      if (
        !state.workspace.canEdit &&
        !e.target.matches('[data-room-staff], [data-room-staff-mode]') &&
        !(state.workspace.canEditRoomOverlap && e.target.matches('[data-room-prevent-overlap]'))
      )
        return;
      actions.workspaceSettingsMessage(form, '');
      if (e.target.name === 'roomLayout') {
        if (
          e.target.value === 'single' &&
          form.querySelectorAll('[data-room-active]:checked').length !== 1
        ) {
          e.target.value = 'multiple';
          actions.workspaceSettingsMessage(
            form,
            'Сначала оставьте один действующий кабинет: отключите остальные отметкой «Действует». История сохранится.',
          );
        }
        actions.syncWorkspaceRoomLayout(form);
        return;
      }
      if (e.target.matches('[data-room-active]')) {
        if (!form.querySelector('[data-room-active]:checked')) {
          e.target.checked = true;
          actions.workspaceSettingsMessage(
            form,
            'Нужно оставить хотя бы один действующий кабинет.',
          );
        }
        if (form.querySelectorAll('[data-room-active]:checked').length > 1) {
          form.elements.roomLayout.value = 'multiple';
          actions.syncWorkspaceRoomLayout(form);
        }
        actions.syncWorkspaceRoomSummary(e.target.closest('[data-room-id]'));
        return;
      }
      if (!e.target.matches('[data-room-staff-mode]')) return;
      const row = e.target.closest('[data-room-id]'),
        multiple = e.target.value === 'multiple';
      if (!multiple && row.querySelectorAll('[data-room-staff]:checked').length > 1) {
        e.target.value = 'multiple';
        actions.workspaceSettingsMessage(
          form,
          'Сначала оставьте выбранным одного сотрудника. Назначения не удалены.',
        );
        return;
      }
      for (const input of row.querySelectorAll('[data-room-staff]'))
        input.type = multiple ? 'checkbox' : 'radio';
      row.querySelector('legend').textContent = multiple
        ? 'Выберите сотрудников'
        : 'Выберите сотрудника';
      row.querySelector('.workspace-sharing-hint').hidden = !multiple;
    });
    document.addEventListener('submit', async (e) => {
      if (e.target.id !== 'workspace-settings-form') return;
      e.preventDefault();
      if (state.busy || !canAssignRooms()) return;
      const form = e.target,
        values = actions.workspaceFormValues(form),
        button = form.querySelector('[type="submit"]');
      actions.workspaceSettingsMessage(form, '');
      const rulesChanged =
        (state.workspace.canEdit && values.enabled !== state.workspace.enabled) ||
        ((state.workspace.canEdit || state.workspace.canEditRoomOverlap) &&
          (values.rooms || values.roomAssignments || []).some((room) => {
            const prior = state.workspace.rooms.find((r) => r.id === room.id);
            return (
              prior &&
              typeof room.preventOverlap === 'boolean' &&
              prior.preventOverlap !== room.preventOverlap
            );
          }));
      if (
        rulesChanged &&
        !window.confirm(
          'Изменить правила пересечений? Прежние записи сохранятся. При включении защиты сервер проверит будущие записи по новым правилам.',
        )
      )
        return;
      state.busy = true;
      button.disabled = true;
      try {
        await actions.saveWorkspaceSettings(values);
      } catch (error) {
        actions.workspaceSettingsMessage(form, error.message);
      } finally {
        state.busy = false;
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  return { bindWorkspaceSettingsEvents };
}
