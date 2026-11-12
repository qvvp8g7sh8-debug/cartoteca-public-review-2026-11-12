function createAdminAuditView({ $, records }) {
  const { esc, date } = records;
  const money = createAdminBillingMoney();
  const billingEvents = {
    billing_financial_action: 'Обновлено финансовое действие',
    billing_package_saved: 'Изменён пакет услуги',
    billing_package_trial_granted: 'Выдан пробный пакет',
    billing_package_paid_granted: 'Подключён оплаченный пакет',
    billing_service_connected: 'Подключена услуга кабинета',
    billing_service_disconnected: 'Отключена услуга кабинета',
    billing_payment_settings_changed: 'Изменены настройки оплаты',
    billing_payment_review: 'Выполнена сверка заказа',
  };
  const events = {
    ...billingEvents,
    global_admin_created: 'Создан главный администратор',
    admin_mfa_setup_started: 'Начата настройка подтверждения входа',
    admin_mfa_enabled: 'Включено подтверждение входа',
    admin_mfa_disabled: 'Отключено подтверждение входа',
    admin_mfa_recovery_rotated: 'Заменены резервные коды',
    login_succeeded: 'Вход в аккаунт',
    login_failed: 'Неудачная попытка входа',
    organization_profile_admin_updated: 'Изменён профиль организации',
    organization_access_admin_updated: 'Изменён доступ организации',
    subscription_terms_admin_updated: 'Изменены условия картотеки',
    account_access_admin_updated: 'Изменён доступ пользователя',
    account_email_recovery_prepared: 'Запрошена смена почты',
    account_email_changed: 'Изменена почта',
    account_sessions_admin_revoked: 'Завершены сеансы',
    account_email_recovery_cancelled: 'Отменена смена почты',
    support_case_updated: 'Изменено состояние обращения',
    support_reply_queued: 'Ответ поставлен в очередь',
    support_internal_note_added: 'Добавлена внутренняя заметка',
  };
  const fields = {
    title: 'Название',
    priceKopecks: 'Цена',
    taskLimit: 'Лимит задач / единиц',
    receiptPolicy: 'Параметры чека',
    serviceCode: 'Услуга',
    serviceTitle: 'Название услуги',
    periodMonths: 'Срок в месяцах',
    quotaUnit: 'Единицы пакета',
    enabled: 'Доступ включён',
    version: 'Версия',
    grantId: 'Выдача пакета',
    packageId: 'Пакет',
    packageVersion: 'Версия пакета',
    source: 'Основание выдачи',
    sourceOrderId: 'Заказ',
    startsAt: 'Начало срока',
    endsAt: 'Окончание срока',
    testMode: 'Тестовый режим',
    service: 'Услуга',
    kind: 'Действие',
    status: 'Состояние',
    amountKopecks: 'Сумма',
    revision: 'Версия',
    configured: 'Приём оплат настроен',
    fiscalProvider: 'Провайдер чека',
    purchaseModel: 'Модель покупки',
    paymentMode: 'Способ расчёта',
    vatCode: 'Код НДС',
    taxSystemCode: 'Код налогообложения',
    paymentSubject: 'Предмет расчёта',
    description: 'Описание в чеке',
    action: 'Действие',
    resultCode: 'Результат',
    paymentState: 'Состояние заказа',
    paidConfirmed: 'Оплата подтверждена',
    packageIssued: 'Пакет выдан',
    reconciliationStatus: 'Сверка',
    refundStatus: 'Проверка возврата',
    closingReceiptStatus: 'Закрывающий чек',
    knownRefundedKopecks: 'Подтверждённые возвраты',
  };
  const actions = {
    reconcile: 'Сверка оплаты',
    retry_create: 'Повтор создания отключён',
    request_refund_review: 'Заявка на проверку возврата',
    request_receipt_review: 'Заявка на проверку закрывающего чека',
    check_refund: 'Проверка существующего возврата',
    check_receipt: 'Проверка существующего чека',
  };
  const codes = {
    safe_retry_disabled: 'Создание платежа администратором отключено',
    merchant_unavailable: 'Сверка недоступна в текущем режиме',
    payment_id_required: 'Нужен ID существующего платежа',
    payment_id_mismatch: 'ID платежа не совпал',
    restored_requires_reconcile: 'Нужна сверка восстановленного заказа',
    provider_unavailable: 'Провайдер не подтвердил результат',
    payment_mismatch: 'Условия платежа не совпали',
    reference_mismatch: 'Возврат или чек не относится к платежу',
    payment_not_confirmed: 'Исходная оплата не подтверждена',
    order_changed: 'Заказ изменился',
    refund_review_required: 'Сохранена заявка по возврату',
    receipt_review_required: 'Сохранена заявка по чеку',
    paid_access_blocked: 'Оплата подтверждена, выдача пакета требует проверки',
    provider_verified: 'Результат сверки подтверждён',
    reporting_unavailable: 'Проверка объекта недоступна',
  };
  const states = {
    creating: 'Создаётся',
    pending: 'Ожидается результат',
    uncertain: 'Результат уточняется',
    paid: 'Оплачено',
    canceled: 'Отменено',
    rejected: 'Не создано',
    review: 'Нужна сверка',
    required: 'Нужна сверка',
    not_required: 'Сверка не требуется',
    blocked: 'Проверка приостановлена',
    checked: 'Проверено',
    review_required: 'Заявка на проверку',
    observed_succeeded: 'Подтверждён существующий возврат',
    not_requested: 'Заявок нет',
    not_checked: 'Не проверялся',
    succeeded: 'Подтверждено',
  };
  const filter = $('#admin-audit-event');
  if (filter)
    for (const [event, label] of Object.entries(billingEvents)) {
      if ([...filter.options].some((option) => option.value === event)) continue;
      const option = document.createElement('option');
      option.value = event;
      option.textContent = label;
      filter.append(option);
    }
  function value(field, item) {
    if (item == null) return '—';
    if (typeof item === 'boolean') return item ? 'Да' : 'Нет';
    if (['priceKopecks', 'knownRefundedKopecks'].includes(field) && Number.isSafeInteger(item))
      return money.format(String(item), 100n);
    if (['startsAt', 'endsAt'].includes(field) && Number.isSafeInteger(item)) return date(item);
    if (field === 'action') return actions[item] || item;
    if (field === 'resultCode') return codes[item] || item;
    if (field === 'source')
      return { paid: 'Подтверждённая оплата', trial: 'Пробный доступ' }[item] || item;
    if (field === 'service') return item === 'voice-assistant' ? 'Голосовой помощник' : item;
    const receiptValues = {
      external: 'Внешняя касса',
      yookassa: 'ЮKassa',
      package: 'Месячный пакет',
      full_payment: 'Полный расчёт',
      full_prepayment: 'Полная предоплата',
      payment: 'Платёж',
      service: 'Услуга',
      kind: 'Действие',
      status: 'Состояние',
      amountKopecks: 'Сумма',
      property_right: 'Имущественное право',
      intellectual_activity: 'Результат интеллектуальной деятельности',
    };
    if (['fiscalProvider', 'purchaseModel', 'paymentMode', 'paymentSubject'].includes(field))
      return receiptValues[item] || item || 'Не задано';
    if (
      ['paymentState', 'reconciliationStatus', 'refundStatus', 'closingReceiptStatus'].includes(
        field,
      )
    )
      return states[item] || item;
    return typeof item === 'object' ? JSON.stringify(item) : String(item);
  }
  function renderAudit(items, append = false) {
    const html = items
      .map((item) => {
        const detail = item.detail || {},
          billing = Object.hasOwn(billingEvents, item.event);
        const changes = Object.entries(detail.after || {})
          .filter(
            ([field, next]) =>
              !billing ||
              (Object.hasOwn(fields, field) &&
                JSON.stringify(next) !== JSON.stringify(detail.before?.[field])),
          )
          .map(
            ([field, next]) =>
              '<li>' +
              esc(fields[field] || field) +
              ': ' +
              esc(value(field, detail.before?.[field])) +
              ' → ' +
              esc(value(field, next)) +
              '</li>',
          )
          .join('');
        return (
          '<details class="admin-audit-item"><summary><time>' +
          date(item.time) +
          '</time><strong>' +
          esc(events[item.event] || item.event) +
          '</strong><span>' +
          esc(item.actorName || 'Система') +
          '</span></summary><p>' +
          esc(
            item.organizationName ||
              {
                billing_package: 'Пакет услуги',
                billing_payment: 'Заказ пакета',
                billing_settings: 'Настройки оплаты',
                billing_connection: 'Подключение услуги',
              }[item.targetType] ||
              item.targetId ||
              'Платформа',
          ) +
          '</p>' +
          (billing && item.targetId
            ? '<p class="form-hint">ID: ' + esc(item.targetId) + '</p>'
            : '') +
          (detail.reason ? '<p>Причина: ' + esc(detail.reason) + '</p>' : '') +
          (changes
            ? '<ul>' + changes + '</ul>'
            : '<p>Подробные изменения не записаны для этого события.</p>') +
          '</details>'
        );
      })
      .join('');
    if (append) $('#admin-audit').insertAdjacentHTML('beforeend', html);
    else $('#admin-audit').innerHTML = html || '<p>Действий пока нет.</p>';
  }
  return { renderAudit };
}
