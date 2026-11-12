function createAdminVoiceView({ records }) {
  const { esc, date } = records;
  const providers = createAdminVoiceProviders({ records });
  const commands = {
    calendar: 'Календарь и свободные окна',
    clients: 'Поиск клиентов и открытие карточек',
    prepareAppointment: 'Подготовка новой записи',
  };
  const limits = {
    monthlyBudgetRub: ['Бюджет на месяц, ₽', 0, 100000, 0.01],
    dailyRequests: ['Запросов в день на пользователя', 1, 1000, 1],
    maxAudioSeconds: ['Голосовой запрос, секунд', 1, 60, 1],
    maxTextChars: ['Текст запроса, символов', 100, 4000, 1],
    maxReplyChars: ['Текст ответа, символов', 100, 1000, 1],
    maxOutputTokens: ['Ответ модели, токенов', 50, 1000, 1],
    requestTimeoutMs: ['Ожидание ответа, мс', 3000, 30000, 1],
  };
  const rates = {
    llmInput: 'Обработка команды: вход',
    llmOutput: 'Обработка команды: выход',
    sttInput: 'Распознавание речи: вход',
    sttOutput: 'Распознавание речи: выход',
    ttsInput: 'Озвучивание: вход',
    ttsOutput: 'Озвучивание: выход',
  };
  function field(label, name, value, attributes = '') {
    return (
      '<label class="field">' +
      esc(label) +
      '<input name="' +
      esc(name) +
      '" value="' +
      esc(value ?? '') +
      '" ' +
      attributes +
      '></label>'
    );
  }
  function check(label, name, enabled) {
    return (
      '<label class="admin-check"><input type="checkbox" name="' +
      name +
      '"' +
      (enabled ? ' checked' : '') +
      '> ' +
      esc(label) +
      '</label>'
    );
  }
  function options(selected, entries) {
    return Object.entries(entries)
      .map(
        ([value, label]) =>
          '<option value="' +
          esc(value) +
          '"' +
          (selected === value ? ' selected' : '') +
          '>' +
          esc(label) +
          '</option>',
      )
      .join('');
  }
  function settings(data) {
    const policy = data.policy,
      usage = data.usage || {};
    const limitFields = Object.entries(limits)
      .map(([key, [label, min, max, step]]) =>
        field(
          label,
          'limit.' + key,
          policy.limits[key],
          'type="number" min="' + min + '" max="' + max + '" step="' + step + '" required',
        ),
      )
      .join('');
    const priceFields = Object.entries(rates)
      .map(([key, label]) =>
        field(
          label,
          'rate.' + key,
          data.rates[key],
          'type="number" min="0.000001" max="1000000" step="any" required',
        ),
      )
      .join('');
    return (
      '<form data-admin-voice-form="settings" data-admin-voice-draft data-revision="' +
      esc(data.revision) +
      '"><fieldset data-voice-fields>' +
      '<section class="admin-detail-section"><h3>Доступ и возможности</h3>' +
      '<label class="field">Режим<select name="mode">' +
      options(policy.mode, {
        off: 'Выключен для всех',
        selected: 'Включён для подключённых кабинетов и участников тестирования',
      }) +
      '</select></label><p>Платное подключение управляется в разделе «Пакеты и оплата». Персональный доступ к тестированию — во вкладке «Доступ пользователей».</p>' +
      '<div class="admin-voice-checks">' +
      Object.entries(commands)
        .map(([key, label]) => check(label, 'command.' + key, policy.commands[key]))
        .join('') +
      '</div>' +
      '<p class="admin-voice-rule">Доступные действия помощника ограничены правами пользователя и настройками платформы.</p></section>' +
      '<details class="admin-voice-options"><summary>Лимиты и бюджет</summary>' +
      '<p>Период: ' +
      esc(usage.month || 'текущий месяц') +
      '. Расчётные расходы: ' +
      esc(usage.spentRub ?? 0) +
      ' ₽; зарезервировано: ' +
      esc(usage.reservedRub ?? 0) +
      ' ₽.</p><details class="admin-explanation"><summary>Как считаются расходы и запросы</summary><p>' +
      'Оценка по ставкам, не счёт Timeweb. Распознавание, обработка и озвучивание ' +
      'считаются отдельными вызовами дневного лимита.</p></details>' +
      '<div class="admin-voice-fields">' +
      limitFields +
      '</div></details>' +
      '<details class="admin-voice-options"><summary>Речь и модель</summary>' +
      '<p>Выберите распознавание, обработку команды и озвучивание.</p>' +
      '<div class="admin-voice-providers">' +
      providers.render(data) +
      '</div>' +
      '<p>Timeweb: ' +
      (data.credentialStatus?.timeweb?.configured ? 'ключ сохранён' : 'ключ не настроен') +
      '. Соединение с провайдером здесь не проверяется.</p>' +
      field(
        'Новый API-ключ Timeweb',
        'timewebApiKey',
        '',
        'type="password" minlength="12" maxlength="512" pattern="\\S{12,512}" autocomplete="new-password" spellcheck="false"',
      ) +
      '<p>Оставьте пустым, чтобы сохранить текущий ключ.</p>' +
      check('Удалить сохранённый ключ Timeweb', 'removeTimewebKey', false) +
      '</details>' +
      '<details class="admin-voice-options"><summary>Ставки для оценки расходов</summary>' +
      '<p>Рубли за миллион токенов Timeweb. Запросы локального Codex используют лимиты подписки вместо этих ставок. Изменение ставок не отправляет запросы провайдерам.</p>' +
      '<div class="admin-voice-fields">' +
      priceFields +
      '</div></details>' +
      '<label class="field">Причина изменения<input name="reason" required minlength="3" maxlength="300" autocomplete="off"></label>' +
      '</fieldset><div class="admin-voice-actions"><button class="primary" type="submit">Сохранить настройки</button>' +
      '<button class="secondary" type="button" data-voice-reload>Обновить</button></div>' +
      '<p class="admin-voice-result" data-voice-result role="status" aria-live="polite"></p></form>'
    );
  }
  function memberLimits(data) {
    return (
      '<details class="admin-voice-options"><summary>Персональные лимиты</summary>' +
      '<p>Пустое поле — общий лимит. Расходы Timeweb ограничены общим бюджетом.</p>' +
      '<div class="admin-voice-fields">' +
      Object.entries(limits)
        .filter(([key]) => key !== 'monthlyBudgetRub')
        .map(([key, [label, min, max, step]]) =>
          field(
            label,
            'memberLimit.' + key,
            data.limits?.[key] ?? '',
            'type="number" min="' +
              min +
              '" max="' +
              max +
              '" step="' +
              step +
              '" placeholder="' +
              esc(data.effectiveLimits?.[key] ?? '') +
              '"',
          ),
        )
        .join('') +
      '</div></details>'
    );
  }
  function membership(data, identity) {
    const reason = data.effective?.reason || 'Состояние доступа не определено';
    return (
      '<form data-admin-voice-form="member" data-admin-voice-draft data-revision="' +
      esc(data.revision) +
      '"><fieldset data-voice-fields><p><strong>' +
      esc(identity.displayName) +
      '</strong> · ' +
      esc(identity.organizationName) +
      '</p><p class="admin-voice-effective" data-enabled="' +
      Boolean(data.effective?.enabled) +
      '">Сейчас: ' +
      (data.effective?.enabled ? 'доступен' : 'недоступен') +
      '. ' +
      esc(reason) +
      '</p>' +
      check('Разрешить помощника этому пользователю в этой организации', 'enabled', data.enabled) +
      '<p>Разрешение действует только для выбранного членства. Общий режим и действующие права ' +
      'могут ограничить доступ.</p>' +
      memberLimits(data) +
      '<label class="field">Причина изменения<input name="reason" required minlength="3" maxlength="300" autocomplete="off"></label>' +
      '</fieldset><button class="primary" type="submit">Сохранить персональный доступ</button>' +
      '<p class="admin-voice-result" data-voice-result role="status" aria-live="polite"></p></form>'
    );
  }
  function history(items, revision) {
    if (!items.length) return '<p>Предыдущих настроек пока нет.</p>';
    return (
      '<form data-admin-voice-form="restore" data-admin-voice-draft data-revision="' +
      esc(revision) +
      '"><fieldset data-voice-fields><p>Восстанавливаются режим, команды, лимиты, ' +
      'провайдеры и ставки. Ключ, персональные разрешения и правила поведения сохраняются.</p>' +
      '<label class="field">Версия настроек<select name="revision" required><option value="">Выберите версию</option>' +
      items
        .map(
          (item) =>
            '<option value="' +
            esc(item.revision) +
            '">Версия ' +
            esc(item.revision) +
            ' · ' +
            esc(date(item.time)) +
            '</option>',
        )
        .join('') +
      '</select></label>' +
      '<label class="field">Причина восстановления<input name="reason" required minlength="3" maxlength="300" autocomplete="off"></label>' +
      '</fieldset><button type="submit" class="secondary">Восстановить настройки</button>' +
      '<p class="admin-voice-result" data-voice-result role="status" aria-live="polite"></p></form>'
    );
  }
  function audit(items) {
    if (!items.length) return '<p>Изменений политики пока нет.</p>';
    const events = {
      assistant_settings_changed: 'Изменены настройки помощника',
      assistant_membership_changed: 'Изменён персональный доступ',
      assistant_policy_restored: 'Восстановлены настройки помощника',
      assistant_behavior_approved: 'Утверждены правила поведения помощника',
      assistant_behavior_restored: 'Восстановлены правила поведения помощника',
    };
    return items
      .map((item) => {
        const detail = item.detail || {},
          parts = [];
        if (detail.reason) parts.push('Причина: ' + detail.reason);
        if (Number.isInteger(detail.revision)) parts.push('Версия: ' + detail.revision);
        if (detail.accountId) parts.push('Пользователь: ' + detail.accountId);
        if (typeof detail.enabled === 'boolean')
          parts.push(detail.enabled ? 'Доступ включён' : 'Доступ выключен');
        if (detail.mode)
          parts.push(detail.mode === 'off' ? 'Выключен для всех' : 'Только выбранным');
        if (Array.isArray(detail.fields)) parts.push('Поля: ' + detail.fields.join(', '));
        return (
          '<article class="admin-audit-item"><strong>' +
          esc(events[item.event] || item.event) +
          '</strong><p>' +
          esc(date(item.time)) +
          ' · Исполнитель: ' +
          esc(item.actorId || '—') +
          (item.organizationId ? ' · Организация: ' + esc(item.organizationId) : '') +
          '</p>' +
          (parts.length ? '<p>' + esc(parts.join(' · ')) + '</p>' : '') +
          '</article>'
        );
      })
      .join('');
  }
  return { settings, membership, history, audit, commands, limits, rates, providers };
}
