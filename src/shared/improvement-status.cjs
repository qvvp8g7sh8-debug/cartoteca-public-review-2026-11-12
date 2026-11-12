function improvementStatuses() {
  return {
    received: 'Получено',
    discussion: 'Обсуждаем',
    planned: 'Запланировано',
    done: 'Сделано',
    declined: 'Пока не планируем',
  };
}
function improvementStatusLabel(value = 'received') {
  const statuses = improvementStatuses();
  return Object.hasOwn(statuses, value) ? statuses[value] : statuses.received;
}
function createImprovementStatuses() {
  return { improvementStatuses, improvementStatusLabel };
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = { improvementStatuses, improvementStatusLabel, createImprovementStatuses };
