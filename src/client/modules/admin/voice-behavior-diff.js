function createAdminVoiceBehaviorDiff({ records }) {
  const { esc } = records;
  const labels = {
    help: 'Показать помощь',
    calendar: 'Открыть календарь',
    clients: 'Найти клиента',
    clientCard: 'Открыть карточку клиента',
    availability: 'Найти свободные окна',
    prepareAppointment: 'Подготовить форму записи',
    moveAppointment: 'Перенести существующую запись',
    cancelAppointment: 'Отменить существующую запись',
    editAppointment: 'Открыть существующую запись',
    query: 'Клиент',
    date: 'Дата / начало периода',
    endDate: 'Конец периода',
    mode: 'Период календаря',
    time: 'Время / начало интервала',
    endTime: 'Конец интервала',
    staffQuery: 'Специалист',
    serviceQuery: 'Услуга',
    duration: 'Длительность, мин',
  };
  const text = (value) => '<p class="admin-behavior-text">' + esc(value || '(пусто)') + '</p>';
  function example(item) {
    return (
      '<div class="admin-behavior-diff-example">' +
      text(item.text) +
      '<p>Контекст: ' +
      esc(item.referenceDate) +
      ' ' +
      esc(item.referenceTime) +
      '. ' +
      (item.enabled ? 'Разрешён для запросов к модели' : 'Не использовать в запросах к модели') +
      '</p><dl>' +
      '<dt>Действие</dt><dd>' +
      esc(labels[item.expected.intent]) +
      '</dd>' +
      Object.entries(item.expected)
        .filter(([key]) => key !== 'intent')
        .map(
          ([key, value]) => '<dt>' + esc(labels[key] || key) + '</dt><dd>' + esc(value) + '</dd>',
        )
        .join('') +
      '</dl></div>'
    );
  }
  function pair(before, after) {
    return (
      '<div class="admin-behavior-diff-pair"><section><h5>Было</h5>' +
      before +
      '</section><section><h5>После</h5>' +
      after +
      '</section></div>'
    );
  }
  function render(changes) {
    const parts = [];
    if (changes.exampleSelection?.changed) {
      const names = { manual: 'Фиксированный набор', automatic: 'Автоматически по запросу' };
      parts.push(
        '<section><h4>Отбор примеров</h4>' +
          pair(
            text(names[changes.exampleSelection.before || 'manual']),
            text(names[changes.exampleSelection.after || 'manual']),
          ) +
          '</section>',
      );
    }
    for (const [key, label] of [
      ['instructions', 'Инструкции'],
      ['dictionary', 'Словарь'],
    ]) {
      if (changes[key].changed)
        parts.push(
          '<section><h4>' +
            label +
            '</h4>' +
            pair(text(changes[key].before), text(changes[key].after)) +
            '</section>',
        );
    }
    for (const item of changes.examples.added)
      parts.push('<section><h4>Добавлен пример</h4>' + example(item) + '</section>');
    for (const item of changes.examples.removed)
      parts.push('<section><h4>Удалён пример</h4>' + example(item) + '</section>');
    for (const item of changes.examples.changed)
      parts.push(
        '<section><h4>Изменён пример</h4>' +
          pair(example(item.before), example(item.after)) +
          '</section>',
      );
    if (changes.examples.orderChanged) parts.push('<p>Изменён порядок примеров.</p>');
    return parts.join('') || '<p>Изменений в правилах нет.</p>';
  }
  function review(data) {
    return (
      '<section class="admin-behavior-review"><h4>' +
      (data.sourceVersion === null
        ? 'Предварительный просмотр'
        : 'Восстановление версии ' + esc(data.sourceVersion)) +
      '</h4><p>Сервер проверил формат. Изменения ещё не сохранены; модель не запускалась.</p>' +
      (data.promptBudget?.limit
        ? '<p>Бюджет Codex: команда ' +
          esc(data.promptBudget.initial.bytes) +
          ', уточнение ' +
          esc(data.promptBudget.continuation.bytes) +
          ' из ' +
          esc(data.promptBudget.limit) +
          ' байт с резервом на реплику до ' +
          esc(data.promptBudget.reservedTextChars) +
          ' символов. Примеры подбираются в оставшийся объём.</p>'
        : '') +
      (data.sourceVersion === null
        ? ''
        : '<p>Утверждение восстановления заменит текущие правила и локальный черновик поведения выбранной версией. Провайдеры, ключи и персональный доступ сохранятся.</p>') +
      render(data.changes) +
      '<form data-behavior-approve data-admin-voice-draft><fieldset data-behavior-fields>' +
      '<label class="field">Причина изменения<input name="reason" required minlength="3" maxlength="300" autocomplete="off"></label>' +
      '<label class="admin-check"><input name="confirmed" type="checkbox" required> Я просмотрел изменения и подтверждаю применение</label>' +
      '</fieldset><button type="submit" class="primary">' +
      (data.sourceVersion === null ? 'Утвердить изменения' : 'Утвердить восстановление') +
      '</button></form></section>'
    );
  }
  return { render, review };
}
