// Only explicitly allowed appointment fields enter the external message.
const clean = (value, max = 160) =>
  String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
function senderTitle(identity) {
  return clean(identity.organization?.name) || 'Ваш специалист';
}
function invitationMessage(identity) {
  const name = clean(identity.organization?.name);
  const lines = [name ? 'Здравствуйте! Это ' + name + '.' : 'Здравствуйте!'];
  const specialist = clean(identity.specialist);
  const specialty = clean(identity.specialty, 120);
  if (specialist && specialist.toLocaleLowerCase('ru') !== name.toLocaleLowerCase('ru'))
    lines.push('Ваш специалист — ' + specialist + (specialty ? ' — ' + specialty : '') + '.');
  else if (specialist && specialty) lines.push('Специальность: ' + specialty + '.');
  else if (!specialist && clean(identity.organization?.specialty, 120))
    lines.push('Специальность: ' + clean(identity.organization.specialty, 120) + '.');
  lines.push(
    '',
    'Пожалуйста, подключите уведомления о записи в Telegram, чтобы получать напоминания о приёме и подтверждать, что придёте.',
    '',
    'Откройте ссылку и нажмите «Запустить»:',
  );
  return lines.join('\n');
}
function serviceNames(appointment) {
  return Array.isArray(appointment.serviceItems) && appointment.serviceItems.length
    ? appointment.serviceItems.map((item) => clean(item.name)).filter(Boolean)
    : [clean(appointment.service, 1200)].filter(Boolean);
}
function appointmentMessage(
  identity,
  appointment,
  settings,
  { showServices = false, confirmed = false } = {},
) {
  const lines = [
    senderTitle(identity),
    confirmed ? 'Ваша запись подтверждена' : 'Напоминаем о вашей записи',
    '',
    `${String(appointment.date).split('-').reverse().join('.')} в ${clean(appointment.time, 5)}`,
  ];
  const specialist = clean(identity.specialist);
  const specialty = clean(identity.specialty, 120);
  if (specialist && specialist !== clean(identity.organization?.name))
    lines.push(`Специалист: ${specialist}${specialty ? ' — ' + specialty : ''}`);
  else if (specialist && specialty) lines.push(`Специальность: ${specialty}`);
  if (showServices) {
    const names = serviceNames(appointment);
    if (names.length)
      lines.push(
        `Услуги: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ` (и ещё ${names.length - 12})` : ''}`,
      );
  }
  const duration = Number(appointment.duration) || 60;
  lines.push(`Продолжительность: ${duration} минут`);
  if (!confirmed) lines.push('', 'Подтвердите, пожалуйста, что придёте.');
  lines.push('', 'Показ услуг: /privacy', 'Отключить уведомления: /stop');
  return lines.join('\n');
}
function previewMessage(identity, settings) {
  return appointmentMessage(
    identity,
    {
      date: '2030-01-08',
      time: '14:30',
      duration: 90,
      serviceItems: [{ name: 'Консультация' }, { name: 'Уход' }],
    },
    settings,
    { showServices: settings.showServices },
  );
}
module.exports = {
  senderTitle,
  serviceNames,
  appointmentMessage,
  previewMessage,
  invitationMessage,
};
