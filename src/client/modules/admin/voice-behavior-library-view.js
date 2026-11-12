function createAdminVoiceBehaviorLibraryView({ records, behaviorView }) {
  const { esc } = records;
  const statuses = {
    supported: 'Поддерживается',
    manual: 'Нужен ручной шаг',
    needs_clarification: 'Нужно уточнение',
    unsupported: 'Пока не поддерживается',
  };
  const families = {
    action: 'Рабочее действие',
    clarification: 'Уточнение',
    boundary: 'Граница возможностей',
    archive: 'Вне рабочего подбора',
  };
  const support = {
    available: 'Серверная функция есть',
    manual_only: 'Доступно вручную',
    not_implemented: 'Нет серверной ветки помощника',
    policy_boundary: 'Ограничение доступа или действия',
    needs_review: 'Нужна проверка по коду',
  };
  const dispositions = {
    declared_behavior: 'Описанный сценарий; результат ещё нужно проверить',
    expected_clarification: 'Штатное уточнение недостающих данных',
    expected_boundary: 'Штатная граница действия',
    defect: 'Расхождение подтверждено данными проверки',
    review_required: 'Причина пока не установлена',
  };
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  function importable(item) {
    if (
      item.assessment &&
      (['archive', 'boundary'].includes(item.assessment.family) ||
        item.assessment.selectionRole === 'continuation' ||
        ['not_implemented', 'policy_boundary', 'needs_review'].includes(item.assessment.support))
    )
      return false;
    return (
      (['supported', 'manual'].includes(item.current?.status) ||
        (item.current?.status === 'needs_clarification' &&
          item.current?.intent?.intent === 'prepareAppointment')) &&
      Object.hasOwn(behaviorView.intents, item.current?.intent?.intent)
    );
  }
  function shell() {
    return (
      '<details class="admin-voice-options" data-library-panel>' +
      '<summary>Библиотека сценариев: календарь, клиенты, карточки и запись</summary>' +
      '<p>Синтетические команды и правильные дальнейшие шаги. Это отдельный справочник, ' +
      'который не отправляется модели целиком. Настройки приложения в него не входят. ' +
      'Добавление переносит пример только в ваш черновик, выключенным. ' +
      'Команды записи с недостающими полями можно добавить как начало диалога уточнений.</p>' +
      '<form data-library-filter><div class="admin-behavior-library-filters">' +
      '<label class="field">Поиск сценария<input name="q" type="search" maxlength="160" autocomplete="off"></label>' +
      '<label class="field">Тема<select name="category"><option value="">Все темы</option></select></label>' +
      '<label class="field">Готовность<select name="status"><option value="">Все варианты</option></select></label>' +
      '</div><button type="submit" class="secondary">Найти сценарии</button></form>' +
      '<div data-library-packs></div><div data-library-coverage></div><p data-library-status role="status" aria-live="polite"></p>' +
      '<div data-library-cases></div><div class="admin-voice-actions">' +
      '<button type="button" class="secondary" data-library-previous disabled>Назад</button>' +
      '<span data-library-page></span>' +
      '<button type="button" class="secondary" data-library-next disabled>Далее</button>' +
      '</div></details>'
    );
  }
  function options(items, selected, first) {
    return (
      '<option value="">' +
      esc(first) +
      '</option>' +
      items
        .map(
          (item) =>
            '<option value="' +
            esc(item.id) +
            '"' +
            (item.id === selected ? ' selected' : '') +
            '>' +
            esc(item.title || statuses[item.id] || item.id) +
            (Number.isInteger(item.count) ? ' (' + item.count + ')' : '') +
            '</option>',
        )
        .join('')
    );
  }
  function packs(items) {
    return items
      .map(
        (item) =>
          '<article class="admin-behavior-library-pack"><h4>' +
          esc(item.title) +
          '</h4><p>' +
          esc(item.description || '') +
          '</p><button type="button" class="secondary" data-library-pack="' +
          esc(item.id) +
          '">Добавить пакет в черновик' +
          (Number.isInteger(item.count) ? ' (' + item.count + ')' : '') +
          '</button></article>',
      )
      .join('');
  }
  function list(values) {
    return values.length
      ? '<ul>' + values.map((value) => '<li>' + esc(value) + '</li>').join('') + '</ul>'
      : '';
  }
  function intent(value) {
    if (!value) return '<p>Допустимый разбор команды пока не определён.</p>';
    return (
      '<dl class="admin-behavior-library-fields"><dt>Разбор команды</dt><dd>' +
      esc(behaviorView.intents[value.intent] || value.intent) +
      '</dd>' +
      Object.entries(value)
        .filter(([key]) => key !== 'intent')
        .map(
          ([key, value]) =>
            '<dt>' + esc(behaviorView.outputs[key] || key) + '</dt><dd>' + esc(value) + '</dd>',
        )
        .join('') +
      '</dl>'
    );
  }
  function assessment(value) {
    if (!value || !families[value.family] || !support[value.support]) return '';
    const gaps = Array.isArray(value.gaps) ? value.gaps : [];
    return (
      '<details class="admin-behavior-assessment"><summary>Возможности и причины уточнения</summary>' +
      '<p>' +
      esc(families[value.family]) +
      ' · ' +
      esc(support[value.support]) +
      '</p>' +
      (behaviorView.intents[value.capabilityId]
        ? '<p>Действие модели: ' + esc(behaviorView.intents[value.capabilityId]) + '.</p>'
        : '') +
      (value.requiresSavingFlag
        ? '<p>Автоматическое выполнение зависит от разрешённого серверного режима.</p>'
        : '') +
      (dispositions[value.disposition]
        ? '<p>' + esc(dispositions[value.disposition]) + '</p>'
        : '') +
      (gaps.length
        ? list(gaps.map((gap) => gap.label || gap.code || 'Нужна проверка'))
        : '<p>Подтверждённых пробелов не указано.</p>') +
      (value.nextStep ? '<p><strong>Следующий шаг:</strong> ' + esc(value.nextStep) + '</p>' : '') +
      '</details>'
    );
  }
  function coverage(value) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.capabilities)) return '';
    return (
      '<details class="admin-behavior-coverage"><summary>Покрытие функций и сценариев</summary>' +
      '<p>Сценариев: ' +
      count(value.totalCases) +
      '. Требуют разбора: ' +
      count(value.needsReview) +
      '.</p>' +
      '<p>Это оценка библиотеки по коду, а не число ошибок в живых диалогах.</p>' +
      '<table><thead><tr><th>Действие</th><th>Рабочие</th><th>Уточнения</th><th>Ограничения</th><th>Вне подбора</th></tr></thead><tbody>' +
      value.capabilities
        .map(
          (capability) =>
            '<tr><th scope="row">' +
            esc(capability.title || capability.id) +
            '</th>' +
            ['action', 'clarification', 'boundary', 'archive']
              .map((family) => '<td>' + count(capability.caseCounts?.[family]) + '</td>')
              .join('') +
            '</tr>',
        )
        .join('') +
      '</tbody></table><p>Нехватка данных для ответа и ошибка потери контекста учитываются отдельно. Эти сведения не запускают модель.</p></details>'
    );
  }
  function cases(items) {
    if (!items.length) return '<p>По этим условиям сценариев нет.</p>';
    return items
      .map((item) => {
        const context = item.context || item;
        return (
          '<article class="admin-behavior-library-case"><h4>' +
          esc(item.title || item.id) +
          '</h4><p><strong>' +
          esc(item.text) +
          '</strong></p><p class="admin-behavior-library-state">' +
          esc(statuses[item.current.status] || item.current.status) +
          '</p>' +
          assessment(item.assessment) +
          '<p>' +
          'Условный контекст: ' +
          esc(context.referenceDate) +
          ' ' +
          esc(context.referenceTime) +
          ' · ' +
          esc(context.timeZone) +
          '</p>' +
          intent(item.current.intent) +
          '<p><strong>Правильный дальнейший шаг:</strong> ' +
          esc(item.current.outcome) +
          '</p>' +
          (item.preconditions?.length
            ? '<details><summary>Условия сценария</summary>' +
              list(item.preconditions) +
              '</details>'
            : '') +
          (item.current.limitations?.length
            ? '<p>Текущие ограничения:</p>' + list(item.current.limitations)
            : '') +
          (item.tags?.length
            ? '<p class="admin-note">Метки: ' + esc(item.tags.join(', ')) + '</p>'
            : '') +
          (importable(item)
            ? '<button type="button" class="secondary" data-library-import="' +
              esc(item.id) +
              '">Добавить в черновик</button>'
            : '<p>Справочный сценарий. Его нельзя включить как пример действующего действия.</p>') +
          '</article>'
        );
      })
      .join('');
  }
  return { shell, options, packs, cases, importable, coverage };
}
