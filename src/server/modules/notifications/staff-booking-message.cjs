function staffNotificationTarget(job, origin) {
  const url = new URL('/', origin);
  if (job.decoded.kind === 'test') return { text: 'Открыть картотеку', url: url.href };
  const reference =
    job.decoded.kind === 'appointment'
      ? {
          kind: 'appointment',
          patientId: job.decoded.reference.patientId,
          id: job.decoded.reference.id,
        }
      : { kind: 'request', id: job.decoded.requestId };
  url.hash =
    'staff-push=' +
    encodeURIComponent(JSON.stringify({ organizationId: job.organization_id, ...reference }));
  return {
    text: reference.kind === 'appointment' ? 'Открыть запись' : 'Открыть заявку',
    url: url.href,
  };
}
const appointmentLabels = Object.freeze({
  created: 'Создана новая запись',
  moved: 'Запись перенесена',
  cancelled: 'Запись отменена',
  completed: 'Приём завершён',
  no_show: 'Отмечена неявка',
  restored: 'Запись восстановлена',
  removed: 'Запись удалена',
  updated: 'Запись изменена',
  confirmation: 'Запись подтверждена',
});
// Shared text intentionally excludes client names, phone numbers, comments, visits and photos.
function staffBookingMessage(platform, job, record, channel = 'telegram', origin = '') {
  const title = platform.organization(job.organization_id).name || 'Организация';
  const footer =
    channel === 'max'
      ? 'Подробности доступны после входа. Отключить сообщения можно, остановив бота MAX.'
      : 'Подробности доступны после входа. Отключить сообщения: /stop';
  if (job.decoded.kind === 'test')
    return [title, 'Проверочное уведомление. Канал подключён.', footer].join('\n\n');
  if (job.decoded.kind === 'appointment')
    return [
      title,
      appointmentLabels[job.decoded.event],
      `${record.date.split('-').reverse().join('.')} · ${record.time} · ${record.duration} мин.`,
      footer,
    ]
      .join('\n\n')
      .slice(0, 3900);
  const event = {
    'new-request':
      record.kind === 'other-time' ? 'Запрос другого времени' : 'Новая заявка на запись',
    'client-agreed': 'Клиент согласовал предложенное время',
    'client-declined': 'Клиент отказался от предложенного времени',
  }[job.decoded.event];
  return [
    title,
    event,
    `${record.date.split('-').reverse().join('.')} · ${record.time} · ${record.duration} мин.`,
    record.services.map((s) => s.name).join(', '),
    job.decoded.event === 'new-request' && record.kind === 'reserve'
      ? 'Время временно зарезервировано. Заявку нужно принять в картотеке.'
      : job.decoded.event === 'client-agreed'
        ? 'Резерва нет. Проверьте и примите заявку в картотеке.'
        : job.decoded.event === 'client-declined'
          ? 'Заявка отклонена. Резерв не создавался.'
          : 'Без резерва. Согласуйте время в картотеке.',
    channel === 'max'
      ? 'Контакты и подробности доступны только после входа. Отключить сообщения можно, остановив бота MAX.'
      : 'Контакты и подробности доступны только после входа. Отключить сообщения: /stop',
  ]
    .join('\n\n')
    .slice(0, 3900);
}
module.exports = { staffBookingMessage, staffNotificationTarget };
