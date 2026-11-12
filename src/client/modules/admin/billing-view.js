function createAdminBillingView({ records }) {
  const { esc, date } = records;
  const summary = createAdminBillingSummaryView({ records });
  const pages = createAdminBillingPagesView({ records, subscriptionHtml: subscription });
  const money = createAdminBillingMoney();
  const amount = (value) => (Number.isSafeInteger(value) ? String(value / 100) : '');
  const reason = () =>
    field('Причина изменения', 'reason', '', 'required minlength="3" maxlength="300"');
  function field(label, name, value, attributes = '') {
    return (
      '<label class="field">' +
      esc(label) +
      '<input name="' +
      name +
      '" value="' +
      esc(value ?? '') +
      '" ' +
      attributes +
      '></label>'
    );
  }
  function select(label, name, value, choices) {
    return (
      '<label class="field">' +
      esc(label) +
      '<select name="' +
      name +
      '">' +
      [['', 'Выберите по схеме кассы'], ...choices]
        .map(
          ([code, title]) =>
            '<option value="' +
            esc(code) +
            '"' +
            (code === value ? ' selected' : '') +
            '>' +
            esc(title) +
            '</option>',
        )
        .join('') +
      '</select></label>'
    );
  }
  function check(label, name, enabled) {
    return (
      '<label class="admin-check"><input type="checkbox" name="' +
      name +
      '"' +
      (enabled ? ' checked' : '') +
      '> ' +
      esc(label) +
      '</label>'
    );
  }
  function result() {
    return '<p role="status" aria-live="polite" data-admin-billing-message></p>';
  }
  function packageForm(data, item = null) {
    return (
      '<details class="admin-package-editor"' +
      (!item && !data.packages?.length ? ' open' : '') +
      '><summary><span><strong>' +
      esc(item?.title || 'Создать пакет') +
      '</strong><small>' +
      (item
        ? esc(
            money.format(String(item.priceKopecks), 100n) +
              ' · ' +
              item.taskLimit +
              ' ' +
              (item.quotaUnit === 'access'
                ? 'доступ'
                : item.quotaUnit === 'units'
                  ? 'единиц'
                  : 'задач') +
              ' · ' +
              (item.periodMonths || 1) +
              ' мес. · ' +
              (item.enabled ? 'Доступен для покупки' : 'Черновик'),
          )
        : 'Услуга, срок, цена и лимит') +
      '</small></span></summary>' +
      '<form class="admin-billing-form" data-admin-package-form data-package-id="' +
      esc(item?.id || '') +
      '" data-revision="' +
      esc(item?.version || 0) +
      '">' +
      '<fieldset><legend>' +
      (item ? 'Параметры пакета' : 'Новый пакет') +
      '</legend>' +
      '<input type="hidden" name="id" value="' +
      esc(item?.id || '') +
      '">' +
      (data.multipleServices
        ? select('Услуга', 'serviceCode', item?.serviceCode || 'voice-assistant', [
            ...(data.services || []).map((service) => [service.code, service.title]),
            ...(!item ? [['new', 'Создать другую услугу']] : []),
          ]) +
          (!item
            ? field(
                'Название новой услуги',
                'serviceTitle',
                '',
                'maxlength="120" placeholder="Если выбрана другая услуга"',
              )
            : '') +
          field(
            'Срок пакета, месяцев',
            'periodMonths',
            item?.periodMonths || 1,
            'type="number" min="1" max="36" required',
          ) +
          select('Что включает пакет', 'quotaUnit', item?.quotaUnit || 'tasks', [
            ['tasks', 'Количество задач'],
            ['units', 'Количество единиц'],
            ['access', 'Доступ на срок без расходуемого лимита'],
          ])
        : '') +
      field('Название пакета', 'title', item?.title, 'required maxlength="120"') +
      field(
        'Цена за весь срок, ₽',
        'priceRub',
        amount(item?.priceKopecks),
        'type="number" inputmode="decimal" min="0.01" max="100000000" step="0.01" required',
      ) +
      field(
        'Лимит задач / единиц',
        'taskLimit',
        item?.taskLimit,
        'type="number" min="1" max="1000000" step="1" required',
      ) +
      (data.multipleServices
        ? '<details><summary>Данные чека для этого пакета</summary><p class="form-hint">Пустое значение использует настройку магазина. Выберите параметры по вашей договорной и налоговой схеме.</p>' +
          field(
            'Название позиции в чеке',
            'receiptDescription',
            item?.receipt?.description,
            'maxlength="128"',
          ) +
          select('Способ расчёта', 'receiptPaymentMode', item?.receipt?.paymentMode || '', [
            ['full_payment', 'Полный расчёт'],
            ['full_prepayment', 'Полная предоплата'],
          ]) +
          select('Предмет расчёта', 'receiptPaymentSubject', item?.receipt?.paymentSubject || '', [
            ['service', 'Услуга'],
            ['property_right', 'Имущественное право'],
            ['intellectual_activity', 'Результат интеллектуальной деятельности'],
            ['payment', 'Платёж'],
          ]) +
          field(
            'Код НДС по схеме кассы',
            'receiptVatCode',
            item?.receipt?.vatCode,
            'type="number" min="1" max="12"',
          ) +
          '</details>'
        : '') +
      check('Показывать пакет клиентам', 'enabled', item?.enabled) +
      '<p class="form-hint">Услуги подключаются независимо. Остаток не переносится; продление — новой оплатой. ' +
      'У помощника — месячный пакет задач, уточнения внутри одной задачи бесплатны.</p>' +
      reason() +
      '</fieldset><button class="secondary" type="submit">' +
      (item ? 'Сохранить пакет' : 'Добавить пакет') +
      '</button>' +
      result() +
      '</form></details>'
    );
  }
  function trialForm(data, organization) {
    const packages = (data.packages || []).filter((item) => item.taskLimit > 0),
      organizations = organization ? [organization] : data.organizations || [];
    return (
      '<form class="admin-billing-form" data-admin-package-trial data-organization-id="' +
      esc(organization?.id || '') +
      '"><fieldset' +
      (!packages.length || !organizations.length ? ' disabled' : '') +
      '><legend>Пробное подключение</legend><p class="form-hint">Бесплатный доступ выбранному ' +
      'кабинету на срок и с лимитом выбранного пакета. Другие услуги сохраняются. Оплата не создаётся.</p>' +
      '<label class="field">Кабинет<select name="organizationId" required>' +
      organizations
        .map(
          (item) =>
            '<option value="' +
            esc(item.organizationId || item.id) +
            '">' +
            esc(item.organizationName || item.name) +
            '</option>',
        )
        .join('') +
      '</select></label>' +
      (!organization
        ? '<p class="form-hint" data-billing-trial-list-hint></p>' +
          '<button type="button" class="text-btn" data-billing-organization-more' +
          (data.nextOffset == null ? ' hidden' : '') +
          '>Загрузить ещё кабинеты для выбора</button>'
        : '') +
      '<label class="field">Пакет<select name="packageId" required>' +
      packages
        .map(
          (item) =>
            '<option value="' +
            esc(item.id) +
            '">' +
            esc(
              (item.serviceTitle || 'Голосовой помощник') +
                ' · ' +
                item.title +
                ' · ' +
                (item.periodMonths || 1) +
                ' мес.',
            ) +
            '</option>',
        )
        .join('') +
      '</select></label>' +
      reason() +
      '</fieldset><button type="submit" class="secondary"' +
      (!packages.length || !organizations.length ? ' disabled' : '') +
      '>Включить пробный пакет</button>' +
      result() +
      '</form>'
    );
  }
  function paymentSettings(data) {
    const config = data.paymentConfiguration || {},
      receipt = config.receiptConfig || {};
    return (
      '<details class="admin-package-payment-settings"><summary>Настройки приёма оплат</summary>' +
      '<p class="form-hint">' +
      esc(config.notice || 'Приём оплат ещё не настроен.') +
      '</p>' +
      '<form class="admin-billing-form" data-admin-package-payments data-revision="' +
      esc(config.revision ?? 0) +
      '"><fieldset><legend>ЮKassa и кассовый чек</legend>' +
      check('Разрешить приём оплат', 'configured', config.configured) +
      check('Тестовый режим — без реальных списаний', 'testMode', config.testMode !== false) +
      field(
        'Идентификатор магазина',
        'shopId',
        config.shopId,
        'maxlength="80" autocomplete="off"',
      ) +
      '<label class="field">Секретный ключ' +
      (config.secretConfigured ? ' (сохранён; оставьте пустым, чтобы не менять)' : '') +
      '<input type="password" name="secretKey" autocomplete="new-password" maxlength="512"></label>' +
      (config.secretConfigured ? check('Удалить сохранённый ключ', 'clearSecret', false) : '') +
      field(
        'Адрес сайта для возврата после оплаты',
        'returnOrigin',
        config.returnOrigin,
        'type="url" maxlength="300" placeholder="https://адрес-сайта"',
      ) +
      select('Провайдер кассового чека', 'fiscalProvider', receipt.fiscalProvider, [
        ['external', 'Внешняя касса'],
        ['yookassa', 'Чеки через ЮKassa'],
      ]) +
      '<p class="form-hint">Способ расчёта и налоговые параметры задаются по согласованной ' +
      'схеме вашей кассы. Значения не подставляются автоматически.</p>' +
      select('Признак способа расчёта', 'paymentMode', receipt.paymentMode, [
        ['full_payment', 'Полный расчёт'],
        ['full_prepayment', 'Полная предоплата'],
      ]) +
      field(
        'Код ставки НДС',
        'vatCode',
        receipt.vatCode,
        'type="number" min="1" max="12" step="1"',
      ) +
      field(
        'Код системы налогообложения',
        'taxSystemCode',
        receipt.taxSystemCode,
        'type="number" min="1" step="1"',
      ) +
      select('Предмет расчёта', 'paymentSubject', receipt.paymentSubject, [
        ['payment', 'Платёж'],
        ['service', 'Услуга'],
        ['property_right', 'Имущественное право'],
        ['intellectual_activity', 'Результаты интеллектуальной деятельности'],
      ]) +
      field('Описание услуги в чеке', 'description', receipt.description, 'maxlength="128"') +
      reason() +
      '</fieldset><button class="secondary" type="submit">' +
      'Сохранить настройки оплаты</button>' +
      result() +
      '</form></details>'
    );
  }
  function subscription(item) {
    if (item?.subscriptions)
      return (
        item.subscriptions
          .filter((value) => value.active)
          .map(
            (value) =>
              '<section class="paid-package-current"><h4>' +
              esc(value.serviceTitle || value.serviceCode) +
              '</h4>' +
              subscription({ subscription: value }) +
              '</section>',
          )
          .join('') || '<p>Активных услуг нет.</p>'
      );
    const active = item?.subscription;
    if (!active?.active) return '<p>Активного пакета нет.</p>';
    return (
      '<p><strong>' +
      esc(active.title) +
      '</strong> · ' +
      (active.source === 'trial' ? 'пробный' : active.testMode ? 'тестовая оплата' : 'оплачен') +
      '</p><p class="form-hint">До ' +
      esc(date(active.endsAt)) +
      ' · ' +
      (active.quotaUnit === 'access' ? 'Доступ на срок. ' : 'Осталось ') +
      esc(active.quotaUnit === 'access' ? '' : active.remainingTasks) +
      (active.quotaUnit === 'access' ? '' : ' из ') +
      esc(active.quotaUnit === 'access' ? '' : active.taskLimit) +
      (active.quotaUnit === 'access' ? '' : active.quotaUnit === 'units' ? ' единиц.' : ' задач.') +
      '</p>'
    );
  }
  function renderBillingAdminHtml(data, organization = null) {
    if (!data?.available) return '<div class="admin-billing"><p>Пакеты пока недоступны.</p></div>';
    const packages = data.packages || [];
    return (
      '<div class="admin-billing">' +
      summary.render(data, { organization }) +
      '<nav class="admin-billing-tabs" role="tablist" aria-label="Пакеты и оплата">' +
      [
        ['cabinets', organization ? 'Кабинет' : 'Кабинеты'],
        ['payments', 'Платежи'],
        ...(!organization ? [['packages', 'Пакеты']] : []),
      ]
        .map(
          ([key, label]) =>
            '<button type="button" id="admin-billing-tab-' +
            key +
            '" role="tab" data-admin-billing-tab="' +
            key +
            '" aria-controls="admin-billing-panel-' +
            key +
            '" aria-selected="' +
            (key === 'cabinets') +
            '" tabindex="' +
            (key === 'cabinets' ? 0 : -1) +
            '">' +
            label +
            '</button>',
        )
        .join('') +
      '</nav><section id="admin-billing-panel-cabinets" data-admin-billing-panel="cabinets" role="tabpanel" aria-labelledby="admin-billing-tab-cabinets">' +
      (organization ? subscription(data) : '') +
      '<details class="admin-package-trial" data-billing-trial-details' +
      (organization ? ' open' : '') +
      '><summary>Пробный доступ</summary>' +
      trialForm(data, organization) +
      '</details>' +
      (organization ? '' : pages.organizations(data)) +
      '</section>' +
      '<section id="admin-billing-panel-payments" data-admin-billing-panel="payments" role="tabpanel" aria-labelledby="admin-billing-tab-payments" hidden>' +
      (organization ? '' : paymentSettings(data)) +
      pages.orders(data) +
      '</section>' +
      (organization
        ? ''
        : '<section id="admin-billing-panel-packages" data-admin-billing-panel="packages" role="tabpanel" aria-labelledby="admin-billing-tab-packages" hidden>' +
          '<section class="admin-package-catalog"><h4>Пакеты для клиентов</h4>' +
          (packages.length
            ? packages.map((item) => packageForm(data, item)).join('')
            : '<p>Пакеты пока не созданы. Укажите цену и число задач самостоятельно.</p>') +
          packageForm(data) +
          '</section></section>') +
      '</div>'
    );
  }
  return {
    renderBillingAdminHtml,
    summaryHtml: summary.render,
    uncertaintyHtml: summary.uncertaintyHtml,
    orderRowsHtml: pages.orderRowsHtml,
    organizationRowsHtml: pages.organizationRowsHtml,
  };
}
