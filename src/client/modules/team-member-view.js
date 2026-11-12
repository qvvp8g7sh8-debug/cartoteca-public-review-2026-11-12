function createTeamMemberView(state, actions) {
  function channelsHtml(member) {
    return (
      '<div class="team-member-channels" aria-label="Личные уведомления">' +
      ['max', 'telegram', 'push']
        .map((channel) => {
          const name = { max: 'MAX', telegram: 'Telegram', push: 'Push' }[channel];
          const status = member.notifications?.[channel];
          const enabled = status?.linked && status?.enabled;
          const description = !status
            ? 'Статус неизвестен'
            : !status.prepared
              ? 'Пока недоступны'
              : !status.linked
                ? 'Не подключены'
                : enabled
                  ? 'Личное подключение включено'
                  : 'Подключены, уведомления выключены';
          const title = `${name}: ${description}. Сотрудник настраивает подключение в своём аккаунте.`;
          return `<span class="connection-service connection-${channel} team-channel ${enabled ? 'is-linked' : ''}" role="img" tabindex="0" title="${actions.esc(title)}" aria-label="${actions.esc(title)}">${actions.staffChannelIconHtml(channel)}</span>`;
        })
        .join('') +
      '</div>'
    );
  }
  function memberHtml(member) {
    const esc = actions.esc,
      id = esc(member.accountId);
    const role = state.roleNames[member.role] || member.role;
    const name =
      member.displayName === role ? 'Имя не заполнено' : member.displayName || 'Без имени';
    const canEdit = actions.canManageMembers() && member.role !== 'owner';
    const specialist = ['owner', 'cosmetologist'].includes(member.role);
    const status = member.status === 'active' ? 'Доступ включён' : 'Доступ выключен';
    const access = canEdit
      ? `<button type="button" class="secondary member-access-toggle team-access-pill" role="switch" aria-checked="${member.status === 'active'}" aria-label="Доступ к сайту: ${esc(name)}" data-member-status="${id}" data-next-status="${member.status === 'active' ? 'suspended' : 'active'}">${status}</button>`
      : `<span class="team-access-pill" aria-label="${esc(name)}: ${status}">${status}</span>`;
    const roleControl = canEdit
      ? [
          '<details class="member-menu-action"><summary>Изменить роль</summary>',
          `<label class="field member-role-field">Роль<select aria-label="Роль ${esc(name)}" data-member-role="${id}">`,
          `<option value="salon_admin" ${member.role === 'salon_admin' ? 'selected' : ''}>Администратор</option>`,
          `<option value="cosmetologist" ${member.role === 'cosmetologist' ? 'selected' : ''}>Сотрудник</option></select></label></details>`,
          '<details class="member-menu-action"><summary>Изменить специальность</summary>',
          `<form class="member-specialty-form" data-member-specialty="${id}"><label class="field">Специальность<input name="specialty" maxlength="120" value="${esc(member.specialty || '')}" placeholder="Необязательно"></label><button class="secondary" type="submit">Сохранить</button></form></details>`,
        ].join('')
      : '';
    const ruleControl = specialist
      ? `<details class="member-menu-action"><summary>Правила записи</summary><div data-team-rule-staff="${id}"></div></details>`
      : '';
    const menu =
      canEdit || specialist
        ? `<details class="member-edit-panel team-member-menu" name="team-member-menu"><summary title="Действия сотрудника" aria-label="Действия сотрудника: ${esc(name)}"><span aria-hidden="true">⋯</span></summary><div class="member-menu-body">${roleControl}${ruleControl}</div></details>`
        : '<button type="button" class="team-more-placeholder" disabled aria-label="Действия сотрудника недоступны"><span aria-hidden="true">⋯</span></button>';
    return `<article class="team-member ${member.status !== 'active' ? 'is-suspended' : ''}" data-member="${id}"><div class="team-member-main"><span class="team-avatar" aria-hidden="true">${esc(actions.initials(name))}</span><div class="team-member-copy"><strong>${esc(name)}</strong><small>${esc(role)}${specialist && member.specialty ? ' · ' + esc(member.specialty) : ''}</small></div></div><div class="team-member-actions">${channelsHtml(member)}${access}${menu}</div></article>`;
  }
  return { memberHtml };
}
