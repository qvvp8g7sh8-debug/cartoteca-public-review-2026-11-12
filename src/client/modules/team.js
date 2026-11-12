function createTeam(state, actions) {
  function settingsSectionHtml(title, id, content, extraClass = '') {
    const blocks = {
      'improvement-settings': [
        '<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0l-1 2H9Z"/>',
        'Ваши предложения и их состояния',
      ],
      'online-booking-settings': [
        '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18m-6 4 2 2 4-4"/>',
        'Правила времени и запись клиентов',
      ],
      'paid-services-settings': [
        '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 10h18M7 15h3"/>',
        'Подключённые услуги и история покупок',
      ],
      'integrations-settings': [
        '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        'Подключение внешних сервисов',
      ],
      'profile-settings': [
        '<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>',
        'Данные и контакты',
      ],
      'team-settings': [
        '<circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 4 5"/>',
        'Права, правила записи и мои уведомления',
      ],
      'personal-access': [
        '<rect x="4" y="10" width="16" height="12" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
        'Ваша роль и доступные действия',
      ],
      'workspace-settings': [
        state.multiUser
          ? '<rect x="4" y="3" width="11" height="18" rx="1.5"/><path d="M7 3v18M10 12h.01"/><circle cx="18" cy="17" r="4"/><path d="M18 15v2l1 1"/>'
          : '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 3v18M3 12h18"/>',
        'Кабинеты и занятость',
      ],
      'telegram-settings': [
        state.multiUser
          ? '<path class="settings-icon-volume" d="M5 16c2-2 2-3 2-7a5 5 0 0 1 10 0c0 4 0 5 2 7v1H5Z"/><path d="M10 20a2 2 0 0 0 4 0M12 2v2"/>'
          : '<path d="m3 11 18-8-5 18-5-7-8-3Zm8 3L21 3"/>',
        'Telegram и MAX · общие правила',
      ],
      'support-settings': [
        [
          '<path d="M4 13v-1a8 8 0 0 1 16 0v1M20 17v1a4 4 0 0 1-4 4h-4"/>',
          '<rect x="2" ',
          'y="11" ',
          'width="4" ',
          'height="7" ',
          'rx="2"/>',
          '<rect x="18" ',
          'y="11" ',
          'width="4" ',
          'height="7" ',
          'rx="2"/>',
        ].join(''),
        'Помощь и версия приложения',
      ],
    };
    const [icon, description] = blocks[id] || [
      '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
      '',
    ];
    return (
      '<details class="settings-section settings-accordion compact-accordion settings-tile ' +
      extraClass +
      [
        '" name="cartoteca-settings">',
        '<summary>',
        '<span class="settings-tile-icon" ',
        `data-settings-icon="${actions.esc(id)}" aria-hidden="true">`,
        '<svg viewBox="0 0 24 24" ',
        'fill="none" ',
        'stroke="currentColor" ',
        'stroke-width="1.7" ',
        'stroke-linecap="round" ',
        'stroke-linejoin="round">',
      ].join('') +
      icon +
      '</svg></span><span class="settings-tile-copy"><span class="settings-tile-heading"><span class="settings-tile-title">' +
      actions.esc(title) +
      '</span>' +
      (id === 'online-booking-settings'
        ? '<span class="booking-inbox-count booking-health-count" data-booking-health-count hidden></span>'
        : '') +
      '</span>' +
      (description
        ? '<span class="settings-tile-description">' + actions.esc(description) + '</span>'
        : '') +
      '</span></summary>' +
      (state.multiUser
        ? '<div class="settings-page-surface"><header class="settings-page-toolbar"><button type="button" class="secondary settings-page-back" data-settings-back aria-label="Вернуться к списку настроек"><span aria-hidden="true">‹</span> Назад</button><h3 class="settings-page-title" tabindex="-1">' +
          actions.esc(title) +
          '</h3></header>'
        : '') +
      '<div id="' +
      actions.esc(id) +
      '" class="settings-accordion-content">' +
      content +
      '</div>' +
      (state.multiUser ? '</div>' : '') +
      '</details>'
    );
  }
  function settingsHtml() {
    const role = state.roleNames[actions.accountRole()] || actions.accountRole();
    const accessSection = actions.canManageTeam()
      ? actions.settingsSectionHtml(
          'Сотрудники и доступ',
          'team-settings',
          '<p class="settings-loading">Загружаем список сотрудников…</p><div id="staff-booking-rules"></div><div id="staff-notifications"></div>',
          'team-settings',
        )
      : actions.settingsSectionHtml(
          'Сотрудники и доступ',
          'personal-access',
          [
            '<div class="settings-label-row">',
            `<strong>${actions.esc(role)}</strong>`,
            actions.settingsHelpHtml(
              'Ваш доступ',
              'Вы можете создавать клиентов, записи и свои посещения. Изменение основных сведений, услуг и удаление данных ограничено.',
            ),
            '</div><div id="staff-booking-rules"></div><div id="staff-notifications"></div>',
          ].join(''),
          'personal-access',
        );
    return [
      `<section class="global-panel settings-panel ${state.multiUser ? 'settings-pages' : ''}">`,
      `<h2>Настройки</h2>`,
      `<section class="account-settings">`,
      `<div>`,
      `<strong id="account-profile-name">${actions.esc(state.account?.displayName === role ? 'Мой аккаунт' : state.account?.displayName || 'Мой аккаунт')}</strong>`,
      `<p>${actions.esc(state.account?.email || '')} · ${actions.esc(role)}</p>`,
      `</div>`,
      `<button class="secondary" `,
      `id="logout-account">Выйти</button>`,
      `</section>`,
      '<div class="settings-tiles">',
      state.multiUser
        ? [
            actions.profileSettingsHtml(),
            actions.integrationsSettingsHtml(),
            actions.paidServicesSettingsHtml(),
            accessSection,
            actions.workspaceSettingsHtml(),
            actions.onlineBookingSettingsHtml(),
            actions.telegramSettingsHtml(),
          ].join('')
        : '<section id="security-settings" class="settings-section"></section>',
      actions.supportSettingsHtml(),
      actions.improvementSettingsHtml(),
      '</div>',
      '<p class="settings-legal"><a href="privacy.html" target="_blank" rel="noopener noreferrer">Политика обработки персональных данных</a></p>',
      `</section>`,
    ].join('');
  }
  function renderTeamAccess() {
    const root = actions.$('#team-settings');
    if (!root || !state.teamAccess) return;
    const priorRules = root.querySelector('#staff-booking-rules-form');
    if (priorRules?.dataset.confirming === 'true' || priorRules?.dataset.unknown === 'true') return;
    const members = state.teamAccess.members.filter(
      (member) =>
        member.accountId !== actions.accountId() &&
        (actions.accountRole() !== 'owner' || member.role !== 'owner'),
    );
    const invite = actions.canManageTeam()
      ? [
          '<details class="team-invite-panel"><summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m4-11v8m-4-4h8"/></svg>Пригласить<span class="invite-panel-chevron" aria-hidden="true">⌄</span></summary>',
          `<form id="invite-member-form" `,
          `class="invite-member-form">`,
          `<div class="settings-label-row invite-member-heading">`,
          `<h4>Пригласить сотрудника</h4>`,
          actions.settingsHelpHtml(
            'Приглашение сотрудника',
            'Отправим письмо на указанную почту. Доступ появится после принятия приглашения.',
          ),
          `</div>`,
          `<label class="field invite-email-field">Электронная почта<input name="email" `,
          `type="email" required autocomplete="off" `,
          `placeholder="name@example.ru">`,
          `</label>`,
          `<label class="field invite-role-field">Роль<select name="role"><option value="cosmetologist" selected>Сотрудник</option>${actions.accountRole() === 'owner' ? '<option value="salon_admin">Администратор</option>' : ''}`,
          `</select>`,
          `</label><p class="form-hint invite-role-hint">Доступ появится после принятия приглашения.</p>`,
          state.teamAccess.invitationMailConfigured === false
            ? '<p class="form-hint error invite-mail-warning">Отправка писем не настроена.</p>'
            : '',
          '<div class="invite-form-actions"><button class="secondary" type="button" data-invite-cancel>Отмена</button>',
          `<button class="primary" type="submit" ${state.teamAccess.invitationMailConfigured === false ? 'disabled' : ''}>Отправить приглашение</button></div>`,
          '</form>',
          '</details>',
        ].join('')
      : '';
    root.innerHTML = [
      '<section class="team-own-notifications"><div id="staff-notifications"></div>',
      ['owner', 'cosmetologist'].includes(actions.accountRole())
        ? `<details class="team-self-rules"><summary>Мои правила записи</summary><div data-team-rule-staff="${actions.esc(actions.accountId())}"></div></details>`
        : '',
      '</section><section class="team-roster"><header class="team-roster-heading"><div class="settings-label-row">',
      '<h3>Команда</h3>',
      actions.settingsHelpHtml(
        'Роли и доступ',
        'Владелец управляет ролями и приостановкой доступа. Отзыв приглашения запрещает только принять его по ссылке; для уже принятого приглашения приостановите доступ сотрудника. Администратор может приглашать сотрудников.',
      ),
      `</div></header>${invite}${invitationListHtml()}<div class="team-members">${members.map(actions.memberHtml).join('') || '<p class="form-hint team-empty">Здесь появятся приглашённые сотрудники.</p>'}</div>`,
      '<p class="form-hint team-channel-hint">Каждый сотрудник подключает уведомления в своём аккаунте.</p>',
      '<div id="staff-booking-rules"></div>',
      '</section>',
      `<p id="team-message" `,
      `class="form-hint" `,
      `role="status">`,
      `</p>`,
    ].join('');
    actions.renderStaffBookingRules();
    actions.mountStaffNotifications();
  }
  function invitationListHtml() {
    const invitations = state.teamAccess.invitations || [];
    if (!invitations.length) return '';
    const labels = {
      pending: 'Отправляется',
      sent: 'Отправлено · ожидаем принятия',
      failed: 'Ошибка отправки',
      accepted: 'Принято',
      expired: 'Срок истёк',
      revoked: 'Отозвано',
    };
    return (
      '<section id="team-invitations" class="team-invitations"><div class="settings-label-row"><h4>Приглашения</h4>' +
      actions.settingsHelpHtml(
        'Срок приглашения',
        'Ссылка действует 7 дней. Повторная отправка доступна через минуту и заменяет прежнюю ссылку.',
      ) +
      '</div>' +
      invitations
        .map((invitation) => {
          const canManage =
            invitation.canManage && !['accepted', 'revoked'].includes(invitation.status);
          const controls = canManage
            ? `<div class="invitation-controls">` +
              `<button type="button" class="secondary" ${state.teamAccess.invitationMailConfigured === false ? 'disabled' : ''} data-invitation-action="resend" data-invitation-id="${actions.esc(invitation.id)}">Отправить повторно</button>` +
              `<button type="button" class="quiet danger" data-invitation-action="revoke" data-invitation-id="${actions.esc(invitation.id)}">Отозвать</button></div>`
            : '';
          return (
            `<article class="team-invitation" data-invitation-status="${actions.esc(invitation.status)}">` +
            `<div class="invitation-copy"><strong>${actions.esc(invitation.email)}</strong>` +
            `<small>${actions.esc(state.roleNames[invitation.role] || invitation.role)}</small>` +
            `<span>${labels[invitation.status] || 'Неизвестный статус'}</span></div>${controls}</article>`
          );
        })
        .join('') +
      '</section>'
    );
  }
  async function loadTeamAccess() {
    if (!actions.canManageTeam()) return;
    const root = actions.$('#team-settings');
    if (!root) return;
    try {
      state.teamAccess = await actions.request('/api/organization/access');
      if (state.currentView === 'settings') actions.renderTeamAccess();
    } catch (error) {
      if (root.isConnected) root.innerHTML = `<p class="error">${actions.esc(error.message)}</p>`;
    }
  }
  async function refreshTeamInvitations() {
    const root = actions.$('#team-settings'),
      account = state.account;
    if (!root || !state.teamAccess) return;
    const result = await actions.readBackground('/api/organization/access');
    if (
      state.account !== account ||
      state.busy ||
      !root.isConnected ||
      state.currentView !== 'settings'
    )
      return;
    const previousIds = new Set(state.teamAccess.members.map((member) => member.accountId));
    const newMembers = result.members.filter((member) => !previousIds.has(member.accountId));
    const changed =
      JSON.stringify(result.invitations) !== JSON.stringify(state.teamAccess.invitations);
    // Keep the snapshots behind unsaved member forms: polling must not silently
    // replace expectedSpecialty and bypass a concurrent-edit conflict.
    state.teamAccess = {
      ...state.teamAccess,
      invitations: result.invitations,
      members: [...state.teamAccess.members, ...newMembers],
    };
    if (changed) {
      const section = root.querySelector('#team-invitations');
      if (section) section.outerHTML = invitationListHtml();
      else
        root
          .querySelector('.team-members')
          ?.insertAdjacentHTML('beforebegin', invitationListHtml());
    }
    const members = root.querySelector('.team-members');
    for (const member of newMembers)
      members?.insertAdjacentHTML('beforeend', actions.memberHtml(member));
    if (newMembers.length) actions.renderStaffBookingRules({ rebase: true });
  }

  return {
    settingsSectionHtml,
    settingsHtml,
    renderTeamAccess,
    loadTeamAccess,
    refreshTeamInvitations,
  };
}
