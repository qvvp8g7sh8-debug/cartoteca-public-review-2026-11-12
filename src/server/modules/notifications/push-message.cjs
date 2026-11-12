// Lock-screen copy is a fixed allowlist: never interpolate client or appointment data.
const changes = Object.freeze({
  created: 'Создана новая запись.',
  moved: 'Запись перенесена.',
  cancelled: 'Запись отменена.',
  completed: 'Приём завершён.',
  no_show: 'Отмечена неявка.',
  restored: 'Запись восстановлена.',
  removed: 'Запись удалена.',
});
function pushMessage(event, reference = {}) {
  if (event === 'new-request') {
    if (reference.notice === 'new-classic-booking') return 'Новая онлайн-запись.';
    if (reference.notice === 'other-time') return 'Запрос другого времени. Согласуйте запись.';
    if (reference.notice === 'new-request') return 'Новая заявка на запись. Требует согласования.';
    return 'Новая онлайн-запись. Откройте подробности.';
  }
  if (event === 'confirmation') {
    if (reference.notice === 'client-agreed') return 'Клиент согласовал время. Примите заявку.';
    if (reference.notice === 'client-declined') return 'Клиент отказался от предложенного времени.';
    return reference.kind === 'request' ? 'Получен ответ на заявку.' : 'Запись подтверждена.';
  }
  if (event === 'change') {
    if (reference.removed) return changes.removed;
    return Object.hasOwn(changes, reference.notice)
      ? changes[reference.notice]
      : 'Запись изменена.';
  }
  if (event === 'reminder') return 'Скоро начало рабочего дня.';
  if (event === 'test') return 'Уведомления включены.';
  return 'Новое уведомление.';
}
module.exports = { pushMessage };
