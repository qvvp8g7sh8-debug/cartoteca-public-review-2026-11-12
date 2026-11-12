function createClientServiceSummary(state, actions) {
  const labels = {
    linked: 'подключён',
    unlinked: 'не подключён',
    checking: 'проверяем',
    unavailable: 'недоступен',
    reconnect: 'нужно переподключить',
  };
  function updateClientServiceSummary(patientId, channel, status) {
    const root = actions.$('.patient-connections');
    if (!root || root.dataset.patientId !== patientId || !labels[status]) return;
    if (!['telegram', 'max'].includes(channel)) return;
    const summary = root.querySelector('.patient-connections-status');
    if (!summary) return;
    summary.dataset[channel] = status;
    const states = [
      ['Telegram', summary.dataset.telegram],
      ['MAX', summary.dataset.max],
    ];
    const connected = states.filter(([, value]) => value === 'linked').map(([name]) => name);
    const message = connected.length
      ? 'Подключены: ' + connected.join(', ')
      : states.some(([, value]) => value === 'checking')
        ? 'Проверяем подключение…'
        : states.some(([, value]) => value === 'reconnect')
          ? 'Нужно переподключить сервис'
          : states.some(([, value]) => value === 'unavailable')
            ? 'Проверьте доступность сервисов'
            : 'Не подключено';
    if (summary.textContent !== message) summary.textContent = message;
    summary.title = states.map(([name, value]) => name + ': ' + labels[value]).join('; ');
    summary.classList.toggle('is-linked', Boolean(connected.length));
    root.dataset.connectionState = connected.length
      ? 'linked'
      : states.some(([, value]) => value === 'checking')
        ? 'checking'
        : 'unlinked';
  }
  return { updateClientServiceSummary };
}
