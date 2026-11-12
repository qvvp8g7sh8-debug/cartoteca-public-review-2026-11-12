function createNotificationHistory(state, actions) {
  const pending = new WeakSet();
  const labels = { telegram: 'Telegram', max: 'MAX', push: 'Push', manual: 'Сотрудник' };
  const kinds = {
    reminder: 'Напоминание',
    'booking-confirmed': 'Запись создана',
    created: 'Запись создана',
    moved: 'Перенос',
    cancelled: 'Отмена',
    confirmation: 'Подтверждение записи',
  };
  const statuses = {
    queued: 'В очереди',
    sending: 'Отправляется',
    accepted: 'Принято сервисом',
    failed: 'Ошибка отправки',
    unknown: 'Результат неизвестен',
    cancelled: 'Отменено',
    'client-confirmed': 'Клиент подтвердил',
    'staff-confirmed': 'Подтверждено сотрудником',
  };
  function notificationHistoryHtml(patientId, appointmentId) {
    return (
      '<details class="appointment-notification-history" data-notification-history data-patient-id="' +
      actions.esc(patientId) +
      '" data-notification-appointment-id="' +
      actions.esc(appointmentId) +
      '"><summary>История уведомлений</summary><div data-notification-history-content role="status">Откройте историю для загрузки.</div></details>'
    );
  }
  async function loadHistory(section) {
    if (!section?.open || pending.has(section)) return;
    const account = state.account,
      expectedScope = JSON.stringify([state.account?.id, state.account?.organizationId]),
      patientId = section.dataset.patientId,
      appointmentId = section.dataset.notificationAppointmentId;
    const current = () =>
      section.isConnected &&
      state.account === account &&
      JSON.stringify([state.account?.id, state.account?.organizationId]) === expectedScope &&
      section.open;
    pending.add(section);
    const content = section.querySelector('[data-notification-history-content]');
    content.textContent = 'Загружаем историю…';
    try {
      const result = await actions.request(
        '/api/notifications/history?' + new URLSearchParams({ patientId, appointmentId }),
      );
      if (!current()) return;
      const rows = result.items
        .map((item) => {
          const at =
            item.confirmedAt || item.acceptedAt || item.updatedAt || item.createdAt || item.eventAt;
          const time = Number.isFinite(at)
            ? new Date(at).toLocaleString('ru-RU', { timeZone: state.timeZone })
            : 'Время не сохранено';
          return (
            '<li><strong>' +
            actions.esc(kinds[item.kind] || 'Уведомление') +
            '</strong><span>' +
            actions.esc(labels[item.channel] || 'Картотека') +
            ' · ' +
            actions.esc(statuses[item.status] || 'Состояние уточняется') +
            '</span><small>' +
            actions.esc(time) +
            '</small></li>'
          );
        })
        .join('');
      content.innerHTML =
        (rows
          ? '<ul class="notification-history-list">' + rows + '</ul>'
          : '<p>История отправок пока пуста.</p>') +
        (result.limited ? '<p class="form-hint">Показана доступная часть истории.</p>' : '') +
        '<p class="form-hint">Принятие сообщения сервисом не подтверждает его прочтение.</p><button type="button" class="text-btn" data-notification-history-retry>Обновить</button>';
    } catch (error) {
      if (current())
        content.innerHTML =
          '<p class="error">' +
          actions.esc(error.message) +
          '</p><button type="button" class="secondary" data-notification-history-retry>Повторить</button>';
    } finally {
      pending.delete(section);
    }
  }
  function bindNotificationHistoryEvents() {
    document.addEventListener(
      'toggle',
      (event) => {
        if (event.target.matches?.('[data-notification-history]') && event.target.open)
          void loadHistory(event.target);
      },
      true,
    );
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-notification-history-retry]'))
        void loadHistory(event.target.closest('[data-notification-history]'));
    });
  }
  return { notificationHistoryHtml, bindNotificationHistoryEvents };
}
