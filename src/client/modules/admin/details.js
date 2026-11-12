function createAdminDetails(records) {
  const { esc, roles, states, delivery, date, field, reason, form, heading, close, button } =
    records;
  function organization(org) {
    const profile = form(
      'profile',
      org.id,
      org.revision,
      '/api/admin/organizations/update',
      '<div class="admin-profile-controls">' +
        field('Название для клиентов', 'name', org.name, 'required maxlength="120"') +
        field('Город', 'city', org.city, 'maxlength="120"') +
        field('Телефон', 'phone', org.phone, 'type="tel" maxlength="40"') +
        '</div>' +
        button('Сохранить профиль'),
    );
    const access = form(
      'organizationAccess',
      org.id,
      org.revision,
      '/api/admin/organizations/access',
      '<p>Действует только на эту организацию. Статус подписки не изменится.</p>' +
        '<input type="hidden" name="status" value="' +
        (org.status === 'active' ? 'suspended' : 'active') +
        '">' +
        reason() +
        button(org.status === 'active' ? 'Приостановить организацию' : 'Восстановить доступ'),
    );
    const limits = org.limits || {};
    const terms = form(
      'subscription',
      org.id,
      org.subscriptionRevision,
      '/api/admin/subscriptions/update',
      '<p>Ручные условия доступа. Выбор «Платный» не подтверждает оплату.</p><div class="admin-controls">' +
        '<label class="field">План картотеки<select name="plan"><option value="free"' +
        (org.plan === 'free' ? ' selected' : '') +
        '>Бесплатный</option><option value="paid"' +
        (org.plan === 'paid' ? ' selected' : '') +
        '>Платный</option></select></label>' +
        field(
          'Лимит клиентов',
          'patients',
          limits.patients,
          'type="number" min="1" max="100000" required',
        ) +
        field(
          'Лимит фотографий',
          'photos',
          limits.photos,
          'type="number" min="1" max="1000000" required',
        ) +
        '<label class="admin-check"><input type="checkbox" name="publicBooking"' +
        (limits.publicBooking ? ' checked' : '') +
        '> Онлайн-запись доступна</label><label class="admin-check"><input type="checkbox" name="automaticNotifications"' +
        (limits.automaticNotifications ? ' checked' : '') +
        '> Уведомления доступны</label></div>' +
        reason() +
        button('Сохранить условия'),
    );
    const usage = org.usage?.available
      ? org.usage.patients +
        ' / ' +
        limits.patients +
        ' клиентов · ' +
        org.usage.photos +
        ' / ' +
        limits.photos +
        ' фотографий'
      : 'Использование лимитов сейчас недоступно';
    const members = org.members
      .map(
        (member) =>
          '<li>' +
          esc(member.displayName) +
          ' · ' +
          esc(roles[member.role] || member.role) +
          ' · ' +
          esc(member.email) +
          (member.status === 'active' ? '' : ' · доступ приостановлен') +
          '</li>',
      )
      .join('');
    return (
      close +
      '<p class="admin-contact-line">' +
      esc(org.ownerName) +
      ' · ' +
      esc(org.ownerEmail) +
      ' · ' +
      esc(org.timeZone) +
      '</p><p class="admin-note-inline">' +
      esc(usage) +
      '<br>Последняя активность: ' +
      date(org.lastActivityAt) +
      '</p><div class="admin-detail-grid">' +
      heading('Профиль', profile) +
      heading('Доступ организации', access) +
      heading('Условия картотеки', terms) +
      heading(
        'Пакет помощника',
        '<p>Месячный пакет, остаток задач и пробное подключение.</p>' +
          '<button type="button" class="secondary" data-admin-billing-organization="' +
          esc(org.id) +
          '">Открыть пакет помощника</button>',
      ) +
      heading(
        'Сотрудники',
        '<ul class="admin-memberships">' +
          members +
          '</ul>' +
          '<div class="admin-related-actions"><button type="button" class="text-btn" data-admin-related="support" data-organization="' +
          esc(org.id) +
          '">Обращения организации</button><button type="button" class="text-btn" data-admin-related="audit" data-organization="' +
          esc(org.id) +
          '">История организации</button></div>',
      ) +
      '</div>'
    );
  }
  function account(person) {
    let html =
      close +
      '<p class="admin-note-inline">Почта ' +
      (person.emailVerified ? 'подтверждена' : 'не подтверждена') +
      ' · Последний вход: ' +
      date(person.lastLoginAt) +
      ' · Действующих сеансов: ' +
      person.sessions +
      '</p>' +
      '<ul class="admin-memberships">' +
      person.memberships
        .map(
          (m) =>
            '<li>' +
            esc(m.organizationName) +
            ' · ' +
            esc(roles[m.role] || m.role) +
            (m.status === 'active' ? '' : ' · доступ приостановлен') +
            '</li>',
        )
        .join('') +
      '</ul>';
    if (person.globalAdmin)
      return (
        html + '<p>Системная учётная запись. Смена почты и блокировка этим способом недоступны.</p>'
      );
    const access = form(
      'accountAccess',
      person.id,
      person.revision,
      '/api/admin/accounts/update',
      '<p>Влияет на вход этого человека во все его организации.</p><input type="hidden" name="status" value="' +
        (person.status === 'active' ? 'suspended' : 'active') +
        '">' +
        reason() +
        button(person.status === 'active' ? 'Заблокировать пользователя' : 'Восстановить доступ'),
    );
    const sessions = form(
      'sessions',
      person.id,
      person.revision,
      '/api/admin/accounts/sessions/revoke',
      '<p>Завершить сеансы без блокировки аккаунта и смены пароля.</p>' +
        reason() +
        button('Завершить все сеансы'),
    );
    const recovery = person.recovery
      ? '<p>Ожидается подтверждение новой почты: ' +
        esc(person.recovery.email) +
        '. Срок: ' +
        date(person.recovery.expiresAt) +
        '. Прежний адрес продолжает работать.</p><p>Письмо: ' +
        esc(delivery[person.recovery.deliveries?.[0]?.status] || 'В очереди') +
        '</p>' +
        form(
          'cancelRecovery',
          person.id,
          person.revision,
          '/api/admin/accounts/email/cancel',
          reason() + button('Отменить запрос'),
        )
      : person.mailConfigured === false
        ? '<p>Отправка почты не подключена. Восстановление адреса пока недоступно; прежний вход сохраняется.</p>'
        : form(
            'emailRecovery',
            person.id,
            person.revision,
            '/api/admin/accounts/email',
            '<p>Проверьте принадлежность аккаунта. Новая почта станет логином только после подтверждения письма.</p>' +
              field(
                'Новый адрес для входа',
                'email',
                '',
                'type="email" required maxlength="254" autocomplete="off"',
              ) +
              reason() +
              '<label class="admin-check"><input type="checkbox" name="identityConfirmed" required> Принадлежность аккаунта проверена мной</label>' +
              field(
                'Ваш пароль администратора',
                'password',
                '',
                'type="password" required maxlength="128" autocomplete="current-password"',
              ) +
              button('Отправить подтверждение'),
          );
    return (
      html +
      '<div class="admin-detail-grid">' +
      heading('Доступ пользователя', access) +
      heading('Восстановление почты', recovery) +
      heading('Сеансы', sessions) +
      '</div>'
    );
  }
  function support(ticket) {
    const proposal = ticket.kind === 'improvement';
    const statusForm = form(
      'caseState',
      ticket.id,
      ticket.revision,
      '/api/admin/support/update',
      '<label class="field">' +
        (proposal ? 'Состояние предложения' : 'Состояние обращения') +
        '<select name="' +
        (proposal ? 'improvementState' : 'state') +
        '">' +
        Object.entries(proposal ? records.improvementStates : states)
          .map(
            ([value, title]) =>
              '<option value="' +
              value +
              '"' +
              ((proposal ? ticket.improvementState || 'received' : ticket.state) === value
                ? ' selected'
                : '') +
              '>' +
              title +
              '</option>',
          )
          .join('') +
        '</select></label>' +
        (proposal ? '<input type="hidden" name="state" value="' + esc(ticket.state) + '">' : '') +
        '<label class="admin-check"><input name="claim" type="checkbox"> Назначить меня ответственным</label>' +
        button('Сохранить состояние'),
    );
    const messageForm = form(
      'caseMessage',
      ticket.id,
      ticket.revision,
      '/api/admin/support/message',
      '<label class="field">Тип сообщения<select name="kind"><option value="internal">Внутренняя заметка</option><option value="reply"' +
        (ticket.mailConfigured ? '' : ' disabled') +
        '>Ответ пользователю на почту</option></select></label>' +
        '<label class="field">Сообщение<textarea name="text" rows="4" maxlength="1500" required></textarea></label>' +
        '<p class="admin-note-inline">Не включайте пароли и данные клиентов. Внутренняя заметка видна только поддержке.' +
        (ticket.mailConfigured
          ? ' Ответ направим на текущую почту аккаунта.'
          : ' Отправка ответов на почту не подключена.') +
        '</p>' +
        button('Сохранить сообщение'),
    );
    const messages = records.supportMessages(ticket.messages);
    return (
      close +
      '<p>' +
      esc(ticket.displayName) +
      ' · ' +
      esc(ticket.email) +
      ' · ' +
      esc(ticket.organization || 'Без организации') +
      '</p><p class="admin-case-description">' +
      esc(ticket.description) +
      '</p>' +
      '<p class="admin-note-inline">Доставка оператору: ' +
      ticket.deliveries
        .map((item) => esc(item.channel) + ' — ' + esc(delivery[item.status]))
        .join('; ') +
      '. Это не состояние решения проблемы.</p><div class="admin-detail-grid">' +
      heading('Обработка', statusForm) +
      heading('Заметка или ответ', messageForm) +
      '</div>' +
      (ticket.messagesNext
        ? '<button class="text-btn" type="button" data-admin-older-messages data-before="' +
          ticket.messagesNext.before +
          '" data-before-id="' +
          esc(ticket.messagesNext.beforeId) +
          '">Показать прежние сообщения</button>'
        : '') +
      '<div class="admin-thread">' +
      messages +
      '</div>'
    );
  }
  return { organization, account, support };
}
