function createTelegramSettings(state, actions) {
  const reminderPeriods = [15, 30, 60, 120, 360, 720, 1440, 2880, 10080, 20160];
  let previewSequence = 0,
    previewTimer,
    checkedRoot = null,
    checkedScope = '',
    checkedAt = -Infinity,
    loading = null;
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const botText = (bot) =>
    bot.connected
      ? `Подключён бот @${bot.username}`
      : bot.configured
        ? bot.error || 'Подключаемся к Telegram…'
        : 'Бот пока недоступен. Обратитесь в техподдержку для подключения.';
  const botState = (bot) =>
    bot.connected ? 'connected' : bot.configured ? 'checking' : 'unlinked';
  const maxState = (max) =>
    max.configured ? (max.running ? 'connected' : 'checking') : 'unlinked';
  const channelLabels = { connected: 'Доступен', checking: 'Неактивен', unlinked: 'Недоступен' };
  const channelMark = (status) =>
    status === 'connected' ? '✓' : status === 'checking' ? '!' : '−';
  const telegramIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 3.4 18.5 20c-.2 1.2-.9 1.5-1.9.9l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6 13.8l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20.2 3c.9-.3 1.7.2 1.5.4Z"/></svg>';
  function channelHtml(channel) {
    return `<div id="${channel}-bot-status" class="reminder-channel-status" role="status" tabindex="0" data-connection-state="checking"><span class="reminder-channel-icon reminder-channel-${channel}" aria-hidden="true">${channel === 'telegram' ? telegramIcon : '<span>MAX</span>'}<span class="reminder-channel-mark" data-channel-mark>!</span></span><small data-channel-label>Проверяем</small></div>`;
  }
  function updateChannel(root, channel, status, detail, label = channelLabels[status]) {
    const element = root.querySelector(`#${channel}-bot-status`);
    if (!element) return;
    element.dataset.connectionState = status;
    element.title = (channel === 'telegram' ? 'Telegram' : 'MAX') + ': ' + detail;
    element.setAttribute('aria-label', element.title);
    element.querySelector('[data-channel-mark]').textContent = channelMark(status);
    element.querySelector('[data-channel-label]').textContent = label;
  }
  function updateChannels(root, result) {
    updateChannel(root, 'telegram', botState(result.bot), botText(result.bot));
    updateChannel(
      root,
      'max',
      maxState(result.max),
      result.max.configured
        ? result.max.running
          ? 'Бот доступен, обработчик работает'
          : 'Бот настроен, обработчик остановлен'
        : 'Бот не подключён',
    );
  }
  function timeZoneSelect(current) {
    const russian = [
      ['Europe/Kaliningrad', 'Калининград'],
      ['Europe/Moscow', 'Москва, Санкт-Петербург'],
      ['Europe/Samara', 'Самара'],
      ['Asia/Yekaterinburg', 'Екатеринбург'],
      ['Asia/Omsk', 'Омск'],
      ['Asia/Novosibirsk', 'Новосибирск, Красноярск'],
      ['Asia/Irkutsk', 'Иркутск'],
      ['Asia/Yakutsk', 'Якутск'],
      ['Asia/Vladivostok', 'Владивосток'],
      ['Asia/Magadan', 'Магадан'],
      ['Asia/Kamchatka', 'Петропавловск-Камчатский'],
    ];
    const known = new Set(russian.map(([id]) => id));
    const option = (id, name) => {
      const offset =
        new Intl.DateTimeFormat('ru-RU', { timeZone: id, timeZoneName: 'longOffset' })
          .formatToParts(new Date())
          .find((p) => p.type === 'timeZoneName')
          ?.value.replace('GMT', 'UTC') || '';
      return `<option value="${actions.esc(id)}" ${id === current ? 'selected' : ''}>${actions.esc(name + ' · ' + offset)}</option>`;
    };
    return (
      '<select id="telegram-time-zone" name="timeZone" required>' +
      (!known.has(current)
        ? '<option value="" selected disabled>Выберите российский часовой пояс</option>'
        : '') +
      russian.map(([id, name]) => option(id, name)).join('') +
      '</select>'
    );
  }
  function telegramSettingsHtml() {
    if (!actions.canManageTeam()) return '';
    return actions.settingsSectionHtml(
      'Напоминания клиентам',
      'telegram-settings',
      [
        '<div class="telegram-settings-groups">',
        actions.canManageTeam()
          ? [
              '<section class="telegram-settings-block" aria-labelledby="telegram-clients-heading">',
              '<div class="settings-label-row"><h3 id="telegram-clients-heading">Уведомления клиентам</h3>',
              actions.settingsHelpHtml(
                'Уведомления клиентам',
                'Общий период и примеры напоминаний для Telegram и MAX. Отправляем в каждый готовый подключённый канал клиента. Подключение выполняется из карточки. Само напоминание не подтверждает приход.',
              ),
              '</div>',
              '<div id="telegram-client-settings"><p role="status">Загружаем настройки…</p></div></section>',
            ].join('')
          : '',
        '</div>',
      ].join(''),
    );
  }
  function eventOptions(settings) {
    const items = [
      ['created', 'Запись создана'],
      ['moved', 'Запись перенесена'],
      ['cancelled', 'Запись отменена'],
      ['reminder', 'Напоминание о приёме'],
    ];
    const selected = settings.events || ['reminder'];
    return (
      '<fieldset class="client-notification-events"><legend>Какие сообщения отправлять</legend><div class="staff-push-events">' +
      items
        .map(
          ([id, label]) =>
            '<label><input type="checkbox" name="notificationEvent" value="' +
            id +
            '" ' +
            (selected.includes(id) ? 'checked' : '') +
            '><span>' +
            label +
            '</span></label>',
        )
        .join('') +
      '</div></fieldset>'
    );
  }
  function values(form, resumeRestored = false) {
    return {
      leadMinutes: Number(form.elements.leadMinutes.value),
      events: [...form.querySelectorAll('[name="notificationEvent"]:checked')].map(
        (field) => field.value,
      ),
      expectedEvents: JSON.parse(form.dataset.notificationEvents || '["reminder"]'),
      expectedLeadMinutes: Number(form.dataset.leadMinutes),
      ...(resumeRestored ? { resumeRestored: true } : {}),
    };
  }
  async function loadTelegramSettings({ statusOnly = false, force = true } = {}) {
    actions.mountStaffNotifications();
    const section = actions.$('#telegram-settings');
    if (!actions.settingsSectionVisible(section)) return;
    const root = section.querySelector('#telegram-client-settings');
    if (!root || !actions.canManageTeam()) return;
    const key = scope();
    if (checkedRoot !== root || checkedScope !== key) {
      checkedRoot = root;
      checkedScope = key;
      checkedAt = -Infinity;
    }
    if (loading?.root === root && loading.key === key) {
      // A form save needs a fresh full snapshot after any earlier status read.
      if (!statusOnly && loading.statusOnly) {
        await loading.task;
        return loadTelegramSettings({ statusOnly, force });
      }
      return loading.task;
    }
    if (!force && Date.now() - checkedAt < 30000) return;
    const current = () =>
      root.isConnected && checkedRoot === root && checkedScope === key && scope() === key;
    const pending = { root, key, statusOnly, task: null };
    loading = pending;
    pending.task = readSettings();
    return pending.task;
    async function readSettings() {
      try {
        const result = await actions.readBackground('/api/notifications/reminders');
        if (!current() || !actions.settingsSectionVisible(section)) return;
        const { settings } = result,
          form = root.querySelector('#telegram-settings-form');
        if (statusOnly && form) {
          updateChannels(root, result);
          return;
        }
        const periods = reminderPeriods.includes(settings.leadMinutes)
          ? reminderPeriods
          : [...reminderPeriods, settings.leadMinutes];
        root.innerHTML = [
          '<div class="reminder-channel-statuses" aria-label="Доступность сервисов уведомлений">',
          channelHtml('telegram'),
          channelHtml('max'),
          '</div>',
          '<section id="client-notification-settings" aria-label="Содержимое уведомлений"><p class="form-hint">Загрузка настройки названий услуг…</p></section>',
          `<form id="telegram-settings-form" `,
          `class="telegram-settings-form" `,
          `data-lead-minutes="${settings.leadMinutes}" data-notification-events="${actions.esc(JSON.stringify(settings.events || ['reminder']))}">
        <p class="form-hint">Напоминания отправляются автоматически в подключённые сервисы клиента.</p>
        ${eventOptions(settings)}<div class="form-grid">`,
          `<label class="field">Напоминать за<select name="leadMinutes">${periods.map((n) => `<option value="${n}" ${n === settings.leadMinutes ? 'selected' : ''}>${n >= 1440 ? n / 1440 + ' дн.' : n >= 60 ? n / 60 + ' ч.' : n + ' мин.'}</option>`).join('')}</select>`,
          '</label>',
          `</div>
        <details class="telegram-message-preview">`,
          `<summary>Предпросмотр сообщения</summary>`,
          '<div class="settings-label-row"><span>Примеры уведомлений</span>',
          actions.settingsHelpHtml(
            'Предпросмотр сообщения',
            'Пример записи, не данные клиента. Название берётся из «Мой профиль». Специалист — из самой записи. Если клиент выбрал скрытие услуг, их названия не отправляются.',
          ),
          '</div><small>Telegram</small><pre id="telegram-message-preview" ',
          `aria-live="polite">${actions.esc(result.preview || '')}</pre>`,
          `<small>MAX</small><pre id="max-message-preview">${actions.esc(result.maxPreview || '')}</pre></details><button class="primary" `,
          `type="submit">Сохранить уведомления</button>`,
          `<p id="telegram-settings-message" `,
          `role="status">`,
          `</p>`,
          settings.restoredPaused
            ? '<p class="error">После восстановления из копии отправка приостановлена. Сначала проверьте записи и подключения.</p><button type="submit" class="secondary" data-reminder-resume>Возобновить после восстановления</button>'
            : '',
          `</form>`,
        ].join('');
        updateChannels(root, result);
        void actions.mountClientNotificationSettings();
      } catch (e) {
        if (current() && actions.settingsSectionVisible(section)) {
          const message = root.querySelector('#telegram-bot-status');
          if (message) {
            updateChannel(root, 'telegram', 'checking', e.message, 'Не проверен');
            updateChannel(root, 'max', 'checking', e.message, 'Не проверен');
          } else
            root.innerHTML = `<p class="error" role="alert">${actions.esc(e.message)}</p><button type="button" class="secondary" data-telegram-settings-retry>Повторить загрузку</button>`;
        }
      } finally {
        if (current()) checkedAt = Date.now();
        if (loading === pending) loading = null;
      }
    }
  }
  async function refreshPreview(form, sequence) {
    const preview = form.querySelector('#telegram-message-preview');
    if (!preview || !actions.settingsSectionVisible(form)) return;
    try {
      // Explicit edits must not reuse a status snapshot begun before the save.
      const result = await actions.request('/api/notifications/reminders');
      if (form.isConnected && sequence === previewSequence) {
        preview.textContent = result.preview;
        form.querySelector('#max-message-preview').textContent = result.maxPreview;
      }
    } catch (e) {
      if (form.isConnected && sequence === previewSequence)
        preview.textContent = 'Предпросмотр недоступен: ' + e.message;
    }
  }
  function bindTelegramSettingsEvents() {
    document.addEventListener('client-notification-visibility-saved', (e) => {
      const form = e.target.closest('#telegram-settings')?.querySelector('#telegram-settings-form');
      if (form) void refreshPreview(form, ++previewSequence);
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-telegram-settings-retry]')) void actions.loadTelegramSettings();
    });
    const changed = (e) => {
      const form = e.target.closest('#telegram-settings-form');
      if (!form) return;
      clearTimeout(previewTimer);
      const sequence = ++previewSequence;
      previewTimer = setTimeout(() => {
        void refreshPreview(form, sequence);
      }, 200);
    };
    document.addEventListener('input', changed);
    document.addEventListener('change', changed);
    window.addEventListener('pagehide', () => {
      clearTimeout(previewTimer);
      previewSequence++;
    });
    document.addEventListener('submit', async (e) => {
      if (e.target.id !== 'telegram-settings-form') return;
      e.preventDefault();
      if (state.busy) return;
      const form = e.target,
        expectedAccount = state.account,
        expectedScope = scope(),
        button = e.submitter || form.querySelector('[type="submit"]'),
        resumeRestored = Boolean(button.matches('[data-reminder-resume]'));
      if (
        resumeRestored &&
        !(await actions.confirmAction(
          'Возобновить напоминания после восстановления?',
          'Убедитесь, что записи и подключения проверены. Автоматическая отправка возобновится в готовые каналы клиентов.',
          'Возобновить напоминания',
        ))
      )
        return;
      if (
        state.busy ||
        !form.isConnected ||
        state.account !== expectedAccount ||
        scope() !== expectedScope
      )
        return;
      state.busy = true;
      button.disabled = true;
      try {
        const submitted = values(form, resumeRestored);
        const result = await actions.request('/api/notifications/reminders', {
          method: 'POST',
          body: JSON.stringify(submitted),
        });
        if (!form.isConnected || state.account !== expectedAccount || scope() !== expectedScope)
          return;
        const unchanged =
          JSON.stringify(values(form, resumeRestored)) === JSON.stringify(submitted);
        form.dataset.leadMinutes = String(result.settings?.leadMinutes ?? submitted.leadMinutes);
        form.dataset.notificationEvents = JSON.stringify(
          result.settings?.events || submitted.events,
        );
        if (unchanged) actions.markSettingsSaved(form);
        actions.toast('Настройки уведомлений сохранены для Telegram и MAX');
        if (unchanged) await actions.loadTelegramSettings();
        else
          form.querySelector('#telegram-settings-message').textContent =
            'Сохранено. Новые изменения ещё не сохранены.';
      } catch (e) {
        const message = form.querySelector('#telegram-settings-message');
        if (
          message &&
          form.isConnected &&
          state.account === expectedAccount &&
          scope() === expectedScope
        )
          message.textContent = e.message;
      } finally {
        state.busy = false;
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  return { telegramSettingsHtml, loadTelegramSettings, bindTelegramSettingsEvents, timeZoneSelect };
}
