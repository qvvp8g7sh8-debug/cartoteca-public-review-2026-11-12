function createWorkspaceData(state, actions) {
  async function loadWorkspace({ render = false, required = false } = {}) {
    if (!state.multiUser) return;
    const account = state.account,
      requestScope = JSON.stringify([account?.id, account?.organizationId]),
      current = () =>
        state.account === account &&
        requestScope === JSON.stringify([state.account?.id, state.account?.organizationId]);
    try {
      const result = await actions.request('/api/workspace');
      if (!current()) return;
      state.workspace = result;
      state.roomCacheKey = '';
      state.roomBusy = [];
      if (state.selectedRoomId && !result.rooms.some((r) => r.id === state.selectedRoomId))
        state.selectedRoomId = '';
      if (render && state.currentView === 'settings') {
        actions.renderWorkspaceSettings();
        actions.renderStaffBookingRules();
      }
    } catch (error) {
      if (required) throw error;
      if (render && current()) {
        actions.renderWorkspaceError(error.message);
      }
    }
  }
  function workspaceFormValues(form) {
    const rooms = [...form.querySelectorAll('[data-room-id]')].map((row) => ({
      id: row.dataset.roomId,
      name: row.querySelector('[data-room-name]').value,
      active: row.querySelector('[data-room-active]').checked,
      preventOverlap: row.querySelector('[data-room-prevent-overlap]').checked,
      staffMode: row.querySelector('[data-room-staff-mode]').value,
      staffIds: [...row.querySelectorAll('[data-room-staff]:checked')].map((input) => input.value),
    }));
    if (!state.workspace.canEdit)
      return {
        revision: Number(form.dataset.workspaceRevision),
        roomAssignments: rooms.map(({ id, staffMode, staffIds, preventOverlap }) => ({
          id,
          staffMode,
          staffIds,
          ...(state.workspace.canEditRoomOverlap ? { preventOverlap } : {}),
        })),
      };
    return {
      revision: Number(form.dataset.workspaceRevision),
      enabled: form.elements.enabled.checked,
      mode: rooms.some((r) => r.staffMode === 'multiple') ? 'shared' : 'separate',
      roomLayout: form.elements.roomLayout.value,
      rooms,
    };
  }
  async function saveWorkspaceSettings(values) {
    state.workspace = await actions.request('/api/workspace', {
      method: 'POST',
      body: JSON.stringify(values),
    });
    state.roomCacheKey = '';
    state.roomBusy = [];
    actions.renderWorkspaceSettings();
    actions.renderStaffBookingRules({ rebase: true });
    actions.toast(
      state.workspace.canEdit
        ? 'Кабинеты и занятость сохранены'
        : state.workspace.canEditRoomOverlap
          ? 'Назначения и правила кабинетов сохранены'
          : 'Назначения сотрудников сохранены',
    );
  }
  return { loadWorkspace, workspaceFormValues, saveWorkspaceSettings };
}
