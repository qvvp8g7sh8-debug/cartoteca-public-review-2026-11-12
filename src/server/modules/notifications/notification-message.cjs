const { appointmentMessage } = require('./telegram-messages.cjs');
function notificationMessage(channel, identity, appointment, settings, options = {}) {
  const title = {
    created: 'Вы записаны на приём',
    moved: 'Ваша запись перенесена',
    cancelled: 'Ваша запись отменена',
  }[options.kind];
  let text = appointmentMessage(identity, appointment, settings, {
    ...options,
    ...(title ? { confirmed: true } : {}),
    showServices: settings.showServices === true && options.showServices === true,
  });
  if (title) text = text.replace('Ваша запись подтверждена', title);
  if (
    options.kind === 'moved' &&
    /^\d{4}-\d{2}-\d{2}$/.test(options.previous?.date || '') &&
    /^\d{2}:\d{2}$/.test(options.previous?.time || '')
  ) {
    const before =
      options.previous.date.split('-').reverse().join('.') + ' в ' + options.previous.time;
    const after =
      String(appointment.date).split('-').reverse().join('.') + ' в ' + appointment.time;
    text = text.replace(after, 'Было: ' + before + '\nСтало: ' + after);
  }
  return channel === 'max'
    ? text.replace(
        '\nПоказ услуг: /privacy\nОтключить уведомления: /stop',
        '\nОтключить уведомления можно, остановив бота MAX.',
      )
    : text;
}
const confirmationReply = (confirmed) =>
  confirmed
    ? 'Спасибо! Вы подтвердили запись.'
    : 'Кнопка больше не действует. Свяжитесь со специалистом.';
function syntheticMessagePreview() {
  const identity = { organization: { name: 'Пример салона' }, specialist: 'Пример специалиста' };
  const appointment = { date: '2030-01-08', time: '14:30', duration: 60 };
  const settings = { showServices: false };
  return {
    telegram: notificationMessage('telegram', identity, appointment, settings),
    max: notificationMessage('max', identity, appointment, settings),
    button: 'Подтвердить запись',
    confirmed: confirmationReply(true),
    expired: confirmationReply(false),
    repeated: 'Подтверждение уже сохранено. Время и источник не меняются.',
  };
}
module.exports = { notificationMessage, confirmationReply, syntheticMessagePreview };
