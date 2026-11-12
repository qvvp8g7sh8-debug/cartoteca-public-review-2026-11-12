function createStaffNotifications(state, actions) {
  let root = null,
    key = '',
    pushCheckedAt = -Infinity;
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const current = () => root?.isConnected && key === scope() && state.currentView === 'settings';
  const channels = [
    { id: 'telegram', name: 'Telegram', prefix: 'staff-notify' },
    { id: 'max', name: 'MAX', prefix: 'staff-max' },
  ].map((channel) => ({
    ...channel,
    snapshot: null,
    invitation: null,
    loading: false,
    busy: false,
    message: '',
    checkedAt: -Infinity,
    retryAt: 0,
    generation: 0,
    refreshQueued: false,
    draftEvents: null,
  }));
  function validInvitation(channel, value) {
    try {
      const url = new URL(value.url);
      return (
        Number.isSafeInteger(value.expiresAt) &&
        value.expiresAt > Date.now() &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.hash &&
        [...url.searchParams.keys()].length === 1 &&
        /^staff_[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('start') || '') &&
        (channel.id === 'telegram'
          ? url.hostname === 't.me' && /^\/[A-Za-z0-9_]{5,32}$/.test(url.pathname)
          : url.hostname === 'max.ru' && url.pathname === '/id000000000000_1_bot')
      );
    } catch {
      return false;
    }
  }
  const eventItems = [
    ['new-request', 'Новая заявка онлайн-записи'],
    ['client-agreed', 'Клиент согласовал время'],
    ['client-declined', 'Клиент отказался от времени'],
    ['created', 'Создана запись'],
    ['moved', 'Запись перенесена'],
    ['cancelled', 'Запись отменена'],
    ['confirmation', 'Запись подтверждена'],
    ['completed', 'Приём завершён'],
    ['no_show', 'Отмечена неявка'],
    ['restored', 'Запись восстановлена'],
    ['removed', 'Запись удалена'],
    ['updated', 'Другие изменения записи'],
  ];
  function eventPreferences(channel, disabled) {
    const events = channel.snapshot.events || eventItems.slice(0, 3).map(([id]) => id);
    return (
      '<form data-' +
      channel.prefix +
      '-events data-staff-binding="' +
      actions.esc(channel.snapshot.bindingId || '') +
      '"><fieldset ' +
      (disabled ? 'disabled' : '') +
      '><legend>Какие уведомления получать</legend><div class="staff-push-events">' +
      eventItems
        .map(
          ([id, label]) =>
            '<label><input type="checkbox" name="event" value="' +
            id +
            '" ' +
            (events.includes(id) ? 'checked' : '') +
            '><span>' +
            label +
            '</span></label>',
        )
        .join('') +
      '</div><button type="submit" class="primary">Сохранить</button>' +
      '<button type="button" class="secondary" data-' +
      channel.prefix +
      '-test>Проверить уведомления</button></fieldset></form>'
    );
  }
  function renderChannel(channel) {
    const { snapshot, prefix, busy, name } = channel,
      esc = actions.esc;
    if (channel.invitation && !validInvitation(channel, channel.invitation))
      channel.invitation = null;
    const invitation = channel.invitation,
      linked = snapshot?.linked,
      ready = snapshot?.available && snapshot?.bot?.connected;
    const stateText = !snapshot
      ? channel.message
        ? 'Не удалось проверить'
        : 'Проверяем…'
      : channel.id === 'max' && !snapshot.prepared
        ? 'Пока недоступен'
        : linked
          ? snapshot.compatible === false
            ? 'Переподключите'
            : snapshot.enabled
              ? ready
                ? snapshot.events?.length === 0
                  ? 'События не выбраны'
                  : 'Включены'
                : 'Подключён · сервис недоступен'
              : 'Подключён · выключены'
          : ready
            ? 'Не подключён'
            : 'Сервис недоступен';
    const body = [
      `<p class="staff-channel-intro">Выберите уведомления для ${name}.</p>`,
      linked
        ? `<div class="telegram-switch"><input id="staff-${channel.id}-enabled" type="checkbox" aria-label="Получать уведомления в ${name}" data-${prefix}-toggle ${snapshot.enabled ? 'checked' : ''} ${busy || !ready || snapshot.compatible === false ? 'disabled' : ''}><span>Получать уведомления</span></div>`
        : '',
      snapshot?.compatible === false
        ? '<p class="form-hint">Чтобы получать уведомления, отключите старое подключение и подключите канал заново.</p>'
        : '',
      !linked && invitation
        ? [
            '<div class="staff-notification-actions">',
            `<a class="primary staff-telegram-open" href="${esc(invitation.url)}" target="_blank" rel="noopener noreferrer">Открыть ${name}</a>`,
            `<button type="button" class="secondary" data-${prefix}-copy>Копировать ссылку</button>`,
            '</div><details class="staff-notification-link"><summary>Личная ссылка · 15 минут</summary>',
            `<input readonly aria-label="Личная ссылка ${name}" value="${esc(invitation.url)}"></details>`,
            `<p class="form-hint">Откройте ${name} по кнопке и запустите уведомления. Личная ссылка действует 15 минут.</p>`,
          ].join('')
        : '',
      !linked && !invitation && (ready || busy)
        ? `<button type="button" class="primary" data-${prefix}-connect ${busy || !ready ? 'disabled' : ''}>Подключить ${name}</button>`
        : '',
      snapshot && !ready
        ? '<p class="staff-channel-unavailable">Подключение сейчас недоступно. Можно проверить доступность позже.</p>'
        : '',
      linked && snapshot.compatible !== false ? eventPreferences(channel, busy || !ready) : '',
      linked
        ? `<button type="button" class="text-btn booking-danger" data-${prefix}-unlink ${busy ? 'disabled' : ''}>Отключить ${name}</button>`
        : '',
      `<button type="button" class="text-btn staff-channel-refresh" data-${prefix}-refresh ${busy ? 'disabled' : ''}>Обновить статус</button>`,
    ].join('');
    return {
      id: channel.id,
      name,
      status: stateText,
      linked: linked && ready && snapshot.compatible !== false && snapshot.enabled,
      loading: !snapshot && !channel.message,
      body,
      message: channel.message,
    };
  }
  function render() {
    if (!current()) return;
    if (!root.querySelector('.staff-notification-channels'))
      root.innerHTML =
        '<div class="staff-notification-heading"><div class="settings-label-row"><h3 id="telegram-staff-heading">Мои уведомления</h3>' +
        actions.settingsHelpHtml(
          'Личные уведомления сотрудников',
          `${actions.canManageTeam() ? 'События заявок и записей всей организации' : 'События ваших заявок и записей'} в Telegram и MAX. Каждый сотрудник подключает себя самостоятельно. Пуши настраиваются отдельно на каждом устройстве.\n\nЭто не подключение клиентов и не настройка их напоминаний. Телефоны, история и фотографии в сообщения не включаются.`,
        ) +
        '</div><p class="staff-notification-account">' +
        actions.esc(state.account?.displayName || 'Мой аккаунт') +
        ' · ' +
        actions.esc(
          state.roleNames[state.account?.role] ||
            state.roleNames[state.teamAccess?.actorRole] ||
            'Мой аккаунт',
        ) +
        '</p></div><div class="staff-notification-channels">' +
        [...channels]
          .reverse()
          .map((channel) => `<div data-staff-slot="${channel.id}"></div>`)
          .join('') +
        '<div id="staff-push"></div></div>';
    for (const channel of channels) {
      const slot = root.querySelector(`[data-staff-slot="${channel.id}"]`);
      const changed = actions.renderStaffChannelPanel(slot, renderChannel(channel));
      const form = slot.querySelector('[data-' + channel.prefix + '-events]');
      if (form && changed) {
        actions.markSettingsSaved(form);
        if (channel.draftEvents)
          for (const field of form.querySelectorAll('[name="event"]'))
            field.checked = channel.draftEvents.includes(field.value);
      }
    }
    if (actions.settingsSectionVisible(root)) actions.mountStaffPush?.({ refresh: false });
  }
  async function syncChannel(channel, { force = true } = {}) {
    if (
      !current() ||
      !actions.settingsSectionVisible(root) ||
      channel.loading ||
      channel.busy ||
      state.busy
    )
      return;
    const interval =
      channel.invitation && validInvitation(channel, channel.invitation) ? 4000 : 30000;
    if (!force && Date.now() < Math.max(channel.checkedAt + interval, channel.retryAt)) return;
    const expectedRoot = root,
      expectedKey = key,
      operation = ++channel.generation;
    channel.loading = true;
    try {
      const result = await actions.readBackground(`/api/${channel.id}/staff`);
      if (
        !current() ||
        root !== expectedRoot ||
        key !== expectedKey ||
        operation !== channel.generation
      )
        return;
      const changed = JSON.stringify(channel.snapshot) !== JSON.stringify(result);
      const expired = channel.invitation && !validInvitation(channel, channel.invitation);
      if (channel.snapshot?.bindingId !== result.bindingId) channel.draftEvents = null;
      channel.snapshot = result;
      channel.retryAt = 0;
      if (result.linked) channel.invitation = null;
      if (changed || expired || channel.message) {
        channel.message = '';
        render();
      }
    } catch (error) {
      if (
        current() &&
        root === expectedRoot &&
        key === expectedKey &&
        operation === channel.generation
      ) {
        channel.retryAt = Date.now() + 30000;
        channel.message = error.message;
        render();
      }
    } finally {
      channel.loading = false;
      if (current() && key === expectedKey && operation === channel.generation)
        channel.checkedAt = Date.now();
      if (current() && (root !== expectedRoot || key !== expectedKey || channel.refreshQueued)) {
        channel.refreshQueued = false;
        void syncChannel(channel);
      }
    }
  }
  async function syncStaffNotifications({ force = true } = {}) {
    if (!current() || !actions.settingsSectionVisible(root)) return;
    render();
    await Promise.all(channels.map((channel) => syncChannel(channel, { force })));
    if (
      current() &&
      actions.settingsSectionVisible(root) &&
      (force || Date.now() - pushCheckedAt >= 30000)
    ) {
      pushCheckedAt = Date.now();
      await actions.syncStaffPush?.();
    }
  }
  function change(channel, action) {
    const expectedRoot = root,
      expectedKey = key;
    return actions.changeStaffNotification(channel, action, {
      root,
      key,
      render,
      syncChannel,
      validInvitation,
      current: () => current() && root === expectedRoot && key === expectedKey,
    });
  }
  function mountStaffNotifications() {
    const nextRoot = actions.$('#staff-notifications'),
      nextKey = scope();
    if (nextRoot && nextRoot === root && nextKey === key) return;
    const sameScope = nextKey === key;
    root = nextRoot;
    key = nextKey;
    if (!sameScope)
      for (const channel of channels) {
        channel.snapshot = null;
        channel.invitation = null;
        channel.message = '';
        channel.draftEvents = null;
        channel.checkedAt = -Infinity;
        channel.retryAt = 0;
        channel.generation++;
        channel.refreshQueued = false;
      }
    if (!sameScope) pushCheckedAt = -Infinity;
    if (!root) return;
    render();
    root.addEventListener('click', async (event) => {
      for (const channel of channels) {
        if (event.target.closest(`[data-staff-channel-open="${channel.id}"]`))
          void syncChannel(channel);
        if (event.target.closest(`[data-${channel.prefix}-refresh]`)) void syncChannel(channel);
        if (event.target.closest(`[data-${channel.prefix}-connect]`))
          void change(channel, 'connect');
        if (event.target.closest(`[data-${channel.prefix}-unlink]`)) void change(channel, 'unlink');
        if (event.target.closest(`[data-${channel.prefix}-test]`)) void change(channel, 'test');
        if (
          event.target.closest(`[data-${channel.prefix}-copy]`) &&
          current() &&
          channel.invitation
        ) {
          const expectedKey = key,
            invitation = channel.invitation;
          try {
            await navigator.clipboard.writeText(invitation.url);
            if (current() && key === expectedKey && channel.invitation === invitation) {
              channel.message = 'Ссылка скопирована';
              render();
            }
          } catch {
            if (!current() || key !== expectedKey || channel.invitation !== invitation) return;
            const section = root.querySelector(`[data-staff-channel="${channel.id}"]`),
              field = section.querySelector('.staff-notification-link input');
            field.closest('details').open = true;
            field.focus();
            field.select();
            section.querySelector('.telegram-settings-result').textContent =
              'Ссылка выделена — скопируйте её вручную.';
          }
        }
      }
    });
    root.addEventListener('change', (event) => {
      for (const channel of channels) {
        if (event.target.matches('[data-' + channel.prefix + '-toggle]'))
          void change(channel, 'toggle');
        const form = event.target.closest('[data-' + channel.prefix + '-events]');
        if (form)
          channel.draftEvents = [...form.querySelectorAll('[name="event"]:checked')].map(
            (field) => field.value,
          );
      }
    });
    root.addEventListener('submit', (event) => {
      for (const channel of channels)
        if (event.target.matches('[data-' + channel.prefix + '-events]')) {
          event.preventDefault();
          channel.draftEvents = [...event.target.querySelectorAll('[name="event"]:checked')].map(
            (field) => field.value,
          );
          void change(channel, 'events');
        }
    });
  }
  return { mountStaffNotifications, syncStaffNotifications };
}
