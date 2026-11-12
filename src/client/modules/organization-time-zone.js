function createOrganizationTimeZoneSettings(state, actions) {
  async function mountOrganizationTimeZone() {
    const root = actions.$('#organization-time-zone-settings');
    if (!root) return;
    const account = state.account;
    try {
      const result = await actions.request('/api/cabinet/time-zone');
      if (!root.isConnected || state.account !== account) return;
      root.innerHTML =
        '<details class="organization-time-zone-panel"><summary>Часовой пояс<span data-zone-current></span></summary><form id="organization-time-zone-form" class="organization-time-zone-form">' +
        '<label class="field" for="telegram-time-zone">Часовой пояс всей организации</label>' +
        actions.timeZoneSelect(result.timeZone) +
        '<p class="form-hint">Единое время календаря, онлайн-записи и напоминаний на всех устройствах.</p>' +
        '<button type="submit" class="secondary">Сохранить часовой пояс</button><p role="status" data-zone-message></p></form></details>';
      root.querySelector('form').dataset.timeZone = result.timeZone;
      root.querySelector('[data-zone-current]').textContent =
        root.querySelector('select').selectedOptions[0]?.textContent || result.timeZone;
      root.querySelector('details').open = window.matchMedia('(min-width: 980px)').matches;
    } catch (error) {
      if (root.isConnected) root.textContent = error.message;
    }
  }
  function bindOrganizationTimeZoneEvents() {
    window.matchMedia('(min-width: 980px)').addEventListener('change', (event) => {
      const panel = actions.$('#organization-time-zone-settings .organization-time-zone-panel');
      if (panel) panel.open = event.matches;
    });
    document.addEventListener('submit', async (event) => {
      if (event.target.id !== 'organization-time-zone-form') return;
      event.preventDefault();
      const form = event.target,
        account = state.account,
        message = form.querySelector('[data-zone-message]');
      const timeZone = form.elements.timeZone.value,
        expectedTimeZone = form.dataset.timeZone;
      if (state.busy || timeZone === expectedTimeZone || !timeZone) return;
      if (
        !(await actions.confirmAction(
          'Изменить часовой пояс организации?',
          'Указанные часы записей останутся прежними, но их фактическое время и время рассылки изменятся. Потребуется заново подтвердить записи. Изменение действует для всех сотрудников.',
          'Изменить часовой пояс',
        ))
      )
        return;
      if (state.busy || state.account !== account || !form.isConnected) return;
      state.busy = true;
      const button = form.querySelector('button'),
        select = form.elements.timeZone;
      button.disabled = true;
      select.disabled = true;
      try {
        const result = await actions.request('/api/cabinet/time-zone', {
          method: 'POST',
          body: JSON.stringify({ timeZone, expectedTimeZone }),
        });
        if (state.account !== account || !form.isConnected) return;
        actions.applyCabinetTimeZone(result.timeZone);
        select.value = result.timeZone;
        form.closest('details').querySelector('[data-zone-current]').textContent =
          select.selectedOptions[0]?.textContent || result.timeZone;
        form.dataset.timeZone = result.timeZone;
        actions.markSettingsSaved(form);
        message.textContent = 'Часовой пояс сохранён';
      } catch (error) {
        if (form.isConnected)
          message.textContent = error.outcomeUnknown
            ? 'Результат неизвестен. Перед повторным сохранением обновите настройки и проверьте часовой пояс.'
            : error.message;
      } finally {
        state.busy = false;
        if (button.isConnected) button.disabled = false;
        if (select.isConnected) select.disabled = false;
      }
    });
  }
  return { mountOrganizationTimeZone, bindOrganizationTimeZoneEvents };
}
