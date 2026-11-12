function createAdminVoiceBehaviorView({ records }) {
  const { esc, date } = records;
  const intents = {
    help: 'Показать помощь',
    calendar: 'Открыть календарь',
    clients: 'Найти клиента',
    clientCard: 'Открыть карточку клиента',
    availability: 'Найти свободные окна',
    prepareAppointment: 'Подготовить форму записи',
    moveAppointment: 'Перенести существующую запись',
    cancelAppointment: 'Отменить существующую запись',
    editAppointment: 'Открыть существующую запись',
  };
  const outputs = {
    query: 'Клиент: строка поиска',
    date: 'Дата результата / начало периода',
    endDate: 'Конец периода',
    mode: 'Период календаря',
    time: 'Время результата / начало интервала',
    endTime: 'Конец интервала времени',
    staffQuery: 'Специалист: строка поиска',
    serviceQuery: 'Услуга: строка поиска',
    duration: 'Длительность, минут',
  };
  const applicable = {
    help: [],
    calendar: ['date', 'mode', 'staffQuery'],
    clients: ['query'],
    clientCard: ['query'],
    availability: ['date', 'endDate', 'time', 'endTime', 'staffQuery', 'serviceQuery', 'duration'],
    prepareAppointment: ['query', 'date', 'time', 'staffQuery', 'serviceQuery', 'duration'],
    moveAppointment: ['query', 'date', 'time', 'staffQuery', 'serviceQuery'],
    cancelAppointment: ['query', 'date', 'time', 'staffQuery', 'serviceQuery'],
    editAppointment: ['query', 'date', 'time', 'staffQuery', 'serviceQuery'],
  };
  const field = (label, name, value, attributes = '') =>
    '<label class="field">' +
    esc(label) +
    '<input name="' +
    esc(name) +
    '" value="' +
    esc(value ?? '') +
    '" ' +
    attributes +
    '></label>';
  const options = (entries, selected) =>
    Object.entries(entries)
      .map(
        ([value, label]) =>
          '<option value="' +
          esc(value) +
          '"' +
          (String(selected) === value ? ' selected' : '') +
          '>' +
          esc(label) +
          '</option>',
      )
      .join('');
  function enabledLabel(selection) {
    return selection === 'automatic'
      ? 'Допускать к автоматическому отбору'
      : 'Использовать в запросах к модели';
  }
  function examples(items, selection = 'manual') {
    if (!items.length)
      return selection === 'automatic'
        ? '<p>Встроенная библиотека участвует в подборе. Дополнительных пользовательских примеров пока нет.</p>'
        : '<p>Примеров пока нет. Добавьте вымышленные фразы и ожидаемые действия.</p>';
    return items
      .map(
        (item, index) =>
          '<article class="admin-behavior-example"><h4>Пример ' +
          (index + 1) +
          '</h4><p>' +
          esc(item.text) +
          '</p><p>Контекст: ' +
          esc(item.referenceDate) +
          ' ' +
          esc(item.referenceTime) +
          '. ' +
          esc(intents[item.expected.intent]) +
          '</p>' +
          '<label class="admin-check"><input type="checkbox" data-behavior-enabled="' +
          esc(item.id) +
          '"' +
          (item.enabled ? ' checked' : '') +
          '> ' +
          enabledLabel(selection) +
          '</label>' +
          '<div class="admin-voice-actions"><button type="button" class="secondary" data-behavior-edit="' +
          esc(item.id) +
          '">Изменить пример</button><button type="button" class="text-btn" data-behavior-remove="' +
          esc(item.id) +
          '">Удалить из черновика</button></div></article>',
      )
      .join('');
  }
  function rules(data) {
    const limits = data.limits;
    return (
      '<p data-behavior-provider></p><form data-behavior-rules data-admin-voice-draft>' +
      '<fieldset data-behavior-fields><label class="field">Дополнительные инструкции' +
      '<textarea name="instructions" rows="5" maxlength="' +
      limits.maxInstructionsChars +
      '">' +
      esc(data.rules.instructions) +
      '</textarea></label>' +
      '<label class="field">Словарь произношения и терминов<textarea name="dictionary" rows="5" maxlength="' +
      limits.maxDictionaryChars +
      '">' +
      esc(data.rules.dictionary) +
      '</textarea></label>' +
      '<label class="field">Отбор примеров команд и уточнений<select name="exampleSelection">' +
      options(
        { manual: 'Фиксированный набор', automatic: 'Автоматически по запросу' },
        data.rules.exampleSelection || 'manual',
      ) +
      '</select></label>' +
      '<details class="admin-explanation"><summary>Отбор примеров и ограничения</summary><p>Автоматический отбор использует встроенный каталог и одобренные пользовательские примеры: до ' +
      limits.maxEnabledExamples +
      ' на начальный запрос; это подсказки для модели, не обучение.</p>' +
      '<p>Уточнения новой записи используют другой JSON-контракт: до 6 примеров. Одобренные примеры подготовки записи преобразуются только после проверки исходной фразы и полей; остальные действия относятся к начальной команде. В фиксированном режиме используются применимые преобразования, при их отсутствии — встроенные уточнения. Автоматический режим подбирает из обоих наборов. Выбор номера требует текущих вариантов; выключенные команды исключаются.</p>' +
      '<p>Для переноса, отмены и открытия serviceQuery и staffQuery уточняют исходный приём; они не меняют его услугу или сотрудника. date/time для переноса задают новое время, для отмены и открытия — исходное.</p>' +
      '<p>Всего до ' +
      limits.maxExamples +
      ' пользовательских примеров; в запрос модели — до ' +
      limits.maxEnabledExamples +
      ', суммарно до ' +
      limits.maxEnabledExamplesBytes +
      ' байт после подготовки сервером. ' +
      'Общий объём правил — до ' +
      limits.maxRulesBytes +
      ' байт; сервер проверяет ограничения при просмотре. ' +
      '</p></details><p>Используйте только вымышленные имена и ситуации: включённые примеры передаются выбранной модели.</p>' +
      '<p data-behavior-count></p><div data-behavior-examples></div>' +
      '<button type="button" class="secondary" data-behavior-add>Добавить пример</button></fieldset>' +
      '<div class="admin-voice-actions"><button type="submit" class="primary">Просмотреть изменения</button>' +
      '<button type="button" class="secondary" data-behavior-reload>Заменить черновик текущей версией</button>' +
      '<button type="button" class="secondary" data-behavior-rebase>Перечитать версии, сохранив черновик</button></div></form>' +
      '<div data-behavior-example-editor></div><div data-behavior-review></div>' +
      '<details class="admin-voice-options"><summary>История и сравнение версий</summary>' +
      '<div data-behavior-versions></div><div data-behavior-comparison></div></details>'
    );
  }
  function exampleForm(item, limits, selection = 'manual') {
    const expected = item.expected || { intent: 'help' };
    return (
      '<form data-behavior-example data-admin-voice-draft class="admin-behavior-edit">' +
      '<fieldset data-behavior-fields><h4>' +
      (item.id ? 'Изменить пример' : 'Новый пример') +
      '</h4>' +
      '<label class="field">Фраза пользователя<textarea name="text" rows="3" required maxlength="' +
      limits.maxExampleTextChars +
      '">' +
      esc(item.text || '') +
      '</textarea></label>' +
      '<div class="admin-voice-fields">' +
      field(
        'Дата, относительно которой сказана фраза',
        'referenceDate',
        item.referenceDate,
        'type="date" required',
      ) +
      field(
        'Время, когда сказана фраза',
        'referenceTime',
        item.referenceTime,
        'type="time" required step="60"',
      ) +
      '</div><label class="field">Ожидаемое действие<select name="intent">' +
      options(intents, expected.intent) +
      '</select></label><div class="admin-voice-fields">' +
      Object.entries(outputs)
        .map(([name, label]) => {
          const attrs = ['date', 'endDate'].includes(name)
            ? 'type="date"'
            : ['time', 'endTime'].includes(name)
              ? 'type="time" step="60"'
              : name === 'duration'
                ? 'type="number" min="5" max="1440" step="5"'
                : 'maxlength="160" autocomplete="off"';
          return (
            '<div data-behavior-output="' +
            name +
            '">' +
            (name === 'mode'
              ? '<label class="field">' +
                esc(label) +
                '<select name="mode">' +
                options(
                  { '': 'Не задан', day: 'День', week: 'Неделя', month: 'Месяц' },
                  expected.mode || '',
                ) +
                '</select></label>'
              : field(label, name, expected[name], attrs)) +
            '</div>'
          );
        })
        .join('') +
      '</div><label class="admin-check"><input name="enabled" type="checkbox"' +
      (item.enabled ? ' checked' : '') +
      '> <span data-behavior-enabled-label>' +
      enabledLabel(selection) +
      '</span></label>' +
      '<p>Незаполненные поля результата не задаются. Сохранение записи выполняет пользователь в обычной форме.</p>' +
      '<div class="admin-voice-actions"><button type="submit" class="secondary">Применить к черновику</button>' +
      '<button type="button" class="text-btn" data-behavior-cancel-example>Отменить редактирование примера</button>' +
      '</div></fieldset></form>'
    );
  }
  function versions(data) {
    const entries = Object.fromEntries(
      data.versions.map((item) => [
        item.version,
        'Версия ' +
          item.version +
          (item.current ? ' (текущая)' : '') +
          (item.time ? ' · ' + date(item.time) : ''),
      ]),
    );
    const previous = data.versions.find((item) => !item.current)?.version;
    return (
      '<form data-behavior-compare><div class="admin-voice-fields"><label class="field">Сравнить версию' +
      '<select name="fromVersion">' +
      options(entries, previous ?? data.version) +
      '</select></label>' +
      '<label class="field">С версией<select name="toVersion">' +
      options(entries, data.version) +
      '</select></label></div><button type="submit" class="secondary">Сравнить тексты и действия</button></form>' +
      '<form data-behavior-restore><label class="field">Версия для восстановления<select name="sourceVersion" required>' +
      '<option value="">Выберите предыдущую версию</option>' +
      options(
        Object.fromEntries(
          Object.entries(entries).filter(([value]) => Number(value) !== data.version),
        ),
        '',
      ) +
      '</select></label><button type="submit" class="secondary"' +
      (previous === undefined ? ' disabled' : '') +
      '>Просмотреть восстановление</button></form><p>Сравнение показывает сохранённые тексты и ожидаемые действия. ' +
      'Оно не запускает модель и не оценивает качество её ответов.</p>' +
      data.versions
        .map(
          (item) =>
            '<p><strong>Версия ' +
            esc(item.version) +
            '</strong>' +
            (item.actorId ? ' · Администратор: ' + esc(item.actorId) : '') +
            (item.reason ? ' · Причина: ' + esc(item.reason) : '') +
            '</p>',
        )
        .join('')
    );
  }
  function provider(data) {
    const value = data.llmProvider;
    return value.provider === 'demo'
      ? 'Сейчас выбран демонстрационный обработчик. Его правила статичны; он не использует примеры. Утверждённые примеры будут передаваться реальной модели при выборе Timeweb или локального Codex.'
      : 'Примеры из утверждённых правил передаются выбранной модели: ' +
          value.provider +
          ' · ' +
          value.model +
          '. Они задают предпочтения и не расширяют разрешённые действия или права.' +
          (value.provider === 'codex'
            ? ' Общий вход Codex — до ' +
              data.limits.maxCodexInputBytes +
              ' байт: инструкции, словарь, включённые примеры и текст команды вместе. При превышении их нужно сократить.'
            : '');
  }
  return {
    rules,
    examples,
    exampleForm,
    enabledLabel,
    versions,
    provider,
    intents,
    outputs,
    applicable,
  };
}
