function createStaffField(state, actions) {
  function staffField(current = '', locked = false) {
    if (locked) {
      const member = state.teamAccess?.members.find((member) => member.accountId === current);
      const name =
        member?.displayName ||
        (current === actions.accountId() ? state.account?.displayName : '') ||
        'Специалист исходной записи';
      return (
        '<label class="field full">Специалист<input readonly value="' +
        actions.esc(name) +
        '"></label><input type="hidden" name="staffId" value="' +
        actions.esc(current || actions.accountId()) +
        '">'
      );
    }
    const active = (state.teamAccess?.members || []).filter(
      (member) => member.status === 'active' && ['owner', 'cosmetologist'].includes(member.role),
    );
    if (!actions.canManageTeam() || !active.length)
      return `<input type="hidden" name="staffId" value="${actions.esc(current || actions.accountId())}">`;
    return [
      `<label class="field full">Специалист<select name="staffId" required>${active.map((member) => `<option value="${actions.esc(member.accountId)}" ${member.accountId === (current || actions.accountId()) ? 'selected' : ''}>${actions.esc(member.displayName)} · ${actions.esc(state.roleNames[member.role] || member.role)}</option>`).join('')}</select>`,
      `</label>`,
    ].join('');
  }
  return { staffField };
}
