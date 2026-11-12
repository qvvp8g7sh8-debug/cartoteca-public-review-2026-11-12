function createClientNotificationSettings(state, actions) {
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const confirming = new WeakSet();
  let sequence = 0;
  async function mountClientNotificationSettings() {
    const root = actions.$('#client-notification-settings'),
      key = scope(),
      id = ++sequence;
    if (!root || confirming.has(root.querySelector('form'))) return;
    try {
      const result = await actions.request('/api/notifications/service-visibility');
      if (!root.isConnected || key !== scope() || id !== sequence) return;
      root.innerHTML = [
        '<form id="client-notification-settings-form" class="client-notification-settings-form">',
        '<div class="settings-label-row">',
        '<label class="checkbox-hit-area"><input type="checkbox" name="showServices" aria-labelledby="client-services-label" ',
        result.showServices ? 'checked' : '',
        '></label><span id="client-services-label">Показывать названия услуг в уведомлениях</span>',
        actions.settingsHelpHtml(
          'Названия услуг в уведомлениях',
          'Общая настройка для Telegram, MAX и будущих сервисов. Названия могут быть видны на экране блокировки. Отказ клиента от показа услуг в подключённом Telegram учитывается и при отправке в MAX. Имя клиента, заметки и фотографии не передаются.',
        ),
        '</div><p role="status" data-notification-message></p>',
        '<button type="button" class="secondary" data-notification-retry hidden>Обновить состояние</button></form>',
      ].join('');
      root.querySelector('form').dataset.showServices = String(result.showServices);
    } catch (error) {
      if (!root.isConnected || key !== scope() || id !== sequence) return;
      root.innerHTML =
        '<p role="alert"></p><button type="button" class="secondary" data-notification-retry>Повторить загрузку</button>';
      root.querySelector('p').textContent = error.message;
    }
  }
  function bindClientNotificationSettingsEvents() {
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-notification-retry]') && !state.busy)
        void mountClientNotificationSettings();
    });
    // There is no save button; Enter must not submit another settings form.
    document.addEventListener('submit', (event) => {
      if (event.target.id === 'client-notification-settings-form') event.preventDefault();
    });
    document.addEventListener('change', async (event) => {
      const field = event.target;
      if (!field.matches('#client-notification-settings-form input[name="showServices"]')) return;
      const form = field.form,
        key = scope(),
        message = form.querySelector('[data-notification-message]');
      const showServices = field.checked,
        expectedShowServices = form.dataset.showServices === 'true';
      field.checked = expectedShowServices;
      if (
        state.busy ||
        confirming.has(form) ||
        showServices === expectedShowServices ||
        field.disabled
      )
        return;
      confirming.add(form);
      field.disabled = true;
      let saving = false,
        unknown = false;
      try {
        const accepted = await actions.confirmAction(
          showServices ? 'Показывать услуги в уведомлениях?' : 'Скрыть услуги в уведомлениях?',
          showServices
            ? 'Названия услуг появятся в уведомлениях всех подключённых сервисов, включая MAX. Они могут быть видны на экране блокировки.'
            : 'Уведомления продолжат приходить, но без названий услуг. Это действует для всех сервисов.',
          showServices ? 'Показывать услуги' : 'Скрыть услуги',
        );
        if (!accepted || state.busy || !form.isConnected || key !== scope()) return;
        state.busy = true;
        saving = true;
        const result = await actions.request('/api/notifications/service-visibility', {
          method: 'POST',
          body: JSON.stringify({ showServices, expectedShowServices }),
        });
        if (!form.isConnected || key !== scope()) return;
        field.checked = result.showServices;
        form.dataset.showServices = String(result.showServices);
        actions.markSettingsSaved(form);
        message.textContent = 'Настройка уведомлений сохранена';
        form.dispatchEvent(
          new CustomEvent('client-notification-visibility-saved', { bubbles: true }),
        );
      } catch (error) {
        if (!form.isConnected || key !== scope()) return;
        unknown = Boolean(error.outcomeUnknown);
        field.checked = expectedShowServices;
        message.textContent = unknown
          ? 'Результат неизвестен. Обновите состояние перед повторным изменением.'
          : error.message;
        form.querySelector('[data-notification-retry]').hidden = false;
      } finally {
        confirming.delete(form);
        if (saving) state.busy = false;
        if (form.isConnected && key === scope()) {
          field.disabled = unknown;
          if (!unknown) field.focus({ preventScroll: true });
        }
      }
    });
  }
  return { mountClientNotificationSettings, bindClientNotificationSettingsEvents };
}
