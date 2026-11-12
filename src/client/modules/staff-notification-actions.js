function createStaffNotificationActions(state, actions) {
  async function changeStaffNotification(channel, action, ui) {
    const { root, key, current, render, syncChannel, validInvitation } = ui;
    if (!current() || channel.busy || state.busy || !channel.snapshot) return;
    const expectedKey = key,
      before = channel.snapshot,
      enabled = root.querySelector(`[data-${channel.prefix}-toggle]`)?.checked,
      events = channel.draftEvents ||
        before.events || ['new-request', 'client-agreed', 'client-declined'];
    if (action === 'unlink' || action === 'toggle') {
      channel.busy = true;
      render();
      let accepted = false;
      try {
        accepted = await actions.confirmAction(
          action === 'unlink'
            ? `Отключить мой ${channel.name}?`
            : `${enabled ? 'Включить' : 'Выключить'} мои уведомления ${channel.name}?`,
          'Изменится только ваше подключение. Клиентские напоминания и другой сервис не изменятся. Неотправленные сообщения при отключении будут отменены.',
          action === 'unlink' ? 'Отключить' : 'Подтвердить',
        );
      } catch {
        if (current() && key === expectedKey)
          channel.message = 'Не удалось подтвердить действие. Попробуйте ещё раз.';
      } finally {
        channel.busy = false;
      }
      if (
        !accepted ||
        !current() ||
        key !== expectedKey ||
        state.busy ||
        channel.snapshot !== before
      ) {
        render();
        return;
      }
    }
    channel.generation++;
    channel.busy = true;
    channel.message = '';
    render();
    try {
      const route =
        action === 'connect'
          ? 'link'
          : action === 'unlink'
            ? 'unlink'
            : action === 'test'
              ? 'test'
              : 'settings';
      const result = await actions.request(`/api/${channel.id}/staff/${route}`, {
        method: 'POST',
        body: JSON.stringify(
          action === 'connect'
            ? {}
            : {
                bindingId: before.bindingId,
                ...(action === 'toggle' ? { enabled } : action === 'events' ? { events } : {}),
              },
        ),
      });
      if (!current() || key !== expectedKey) return;
      if (action === 'connect') {
        if (!validInvitation(channel, result))
          throw Error('Не удалось получить безопасную личную ссылку. Повторите подключение.');
        channel.invitation = result;
      } else if (action === 'test') {
        channel.message = 'Пробное сообщение поставлено в очередь. Проверьте ' + channel.name + '.';
      } else if (channel.snapshot?.bindingId === before.bindingId) {
        channel.snapshot = { ...channel.snapshot, ...result };
        if (action === 'events' || action === 'unlink') channel.draftEvents = null;
      }
    } catch (error) {
      if (current() && key === expectedKey) channel.message = error.message;
    } finally {
      channel.busy = false;
      if (current() && key === expectedKey) {
        render();
        if (!channel.message) {
          if (channel.loading) channel.refreshQueued = true;
          else await syncChannel(channel);
        }
      }
    }
  }
  return { changeStaffNotification };
}
