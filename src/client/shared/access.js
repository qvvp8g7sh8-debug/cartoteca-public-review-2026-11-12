function createAccess(state, actions) {
  const accountRole = () => state.account?.role || 'owner';
  const accountId = () => state.account?.id || 'legacy-owner';
  const canManageTeam = () => ['owner', 'salon_admin'].includes(actions.accountRole());
  const canManageMembers = () => actions.accountRole() === 'owner';
  const canEditServices = () => ['owner', 'salon_admin'].includes(actions.accountRole());
  const canEditPatient = () => ['owner', 'salon_admin'].includes(actions.accountRole());
  const canDelete = () => actions.accountRole() === 'owner';
  const canEditRecord = (record) =>
    actions.accountRole() !== 'cosmetologist' || record?.staffId === actions.accountId();
  function lockSavedVisit(v) {
    if (!v?.id || actions.accountRole() === 'owner') return;
    state.editorMode.appendOnly = true;
    state.editorMode.savedPhotoCount = (v.photos || []).length;
    actions.$('#dialog-title').textContent = 'Дополнить посещение';
    const content = actions.$('#form-content');
    for (const field of content.querySelectorAll(
      'input:not([type="file"]):not([type="hidden"]),select,textarea:not([name="notes"])',
    ))
      field.disabled = true;
    for (const button of content.querySelectorAll(
      '[data-remove-visit-procedure],[data-remove-visit-legacy]',
    ))
      button.hidden = true;
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent =
      'Сведения проведённого посещения сохранены. Можно добавить заметки и фотографии; исправления доступны владельцу.';
    content.prepend(hint);
    const notes = content.querySelector('[name="notes"]');
    notes.value = '';
    notes.placeholder = 'Дополнение к сохранённому посещению';
    if (v.notes) {
      const prior = document.createElement('p');
      prior.className = 'note';
      prior.textContent = v.notes;
      notes.before(prior);
    }
  }
  return {
    accountRole,
    accountId,
    canManageTeam,
    canManageMembers,
    canEditServices,
    canEditPatient,
    canDelete,
    canEditRecord,
    lockSavedVisit,
  };
}
