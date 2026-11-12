// Generated from src/client/modules/admin. Edit the source files.
(() => {
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

function createAdminRecords() {
  const improvementStates = improvementStatuses();
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const roles = { owner: 'Владелец', salon_admin: 'Администратор', cosmetologist: 'Сотрудник' };
  const states = {
    new: 'Новое',
    in_progress: 'В работе',
    waiting: 'Ожидает ответа',
    resolved: 'Решено',
  };
  const delivery = {
    pending: 'В очереди',
    waiting: 'Ожидает повтора',
    sending: 'Отправляется',
    sent: 'Доставлено',
    failed: 'Не доставлено',
    cancelled: 'Отменено',
  };
  const date = (value) => (value ? new Date(value).toLocaleString('ru-RU') : 'Нет сведений');
  function record(kind, id, title, subtitle, status) {
    return (
      '<details class="admin-record" data-admin-record data-kind="' +
      kind +
      '" data-id="' +
      esc(id) +
      '"><summary><span class="admin-record-title"><strong>' +
      esc(title) +
      '</strong><small>' +
      esc(subtitle) +
      '</small></span><span class="admin-record-meta"><span class="admin-badge">' +
      esc(status) +
      '</span><span class="admin-chevron" aria-hidden="true"></span></span></summary>' +
      '<div class="admin-detail-body"></div></details>'
    );
  }
  const organizationRecord = (org) =>
    record(
      'organization',
      org.id,
      org.name,
      [org.city || 'Город не указан', org.ownerName].filter(Boolean).join(' · '),
      org.status === 'active' ? 'Доступен' : 'Приостановлен',
    );
  const accountRecord = (account) =>
    record(
      'account',
      account.id,
      account.displayName,
      account.email,
      account.globalAdmin
        ? 'Главный администратор'
        : account.status === 'active'
          ? 'Активен'
          : 'Заблокирован',
    );
  const supportRecord = (item) =>
    record(
      'support',
      item.id,
      (item.kind === 'improvement' ? 'Предложение · ' : '') +
        item.displayName +
        ' · № ' +
        item.id.slice(0, 8),
      item.excerpt,
      item.kind === 'improvement'
        ? improvementStatusLabel(item.improvementState)
        : states[item.state],
    );
  const field = (label, name, value, attributes = '') =>
    '<label class="field">' +
    esc(label) +
    '<input name="' +
    name +
    '" value="' +
    esc(value) +
    '" ' +
    attributes +
    '></label>';
  const reason = () =>
    field('Причина действия', 'reason', '', 'required minlength="3" maxlength="500"');
  const form = (kind, id, revision, route, body) =>
    '<form data-admin-command="' +
    kind +
    '" data-id="' +
    esc(id) +
    '" data-revision="' +
    revision +
    '" data-route="' +
    route +
    '">' +
    body +
    '</form>';
  const heading = (name, body) =>
    '<section class="admin-detail-section"><h3>' + name + '</h3>' + body + '</section>';
  const close =
    '<button class="text-btn admin-detail-close" type="button" data-admin-close>Закрыть карточку</button>';
  const button = (text) => '<button class="secondary" type="submit">' + text + '</button>';
  const supportMessages = (messages) =>
    messages
      .map(
        (m) =>
          '<article class="admin-thread-item"><small>' +
          (m.kind === 'internal'
            ? 'Внутренняя заметка'
            : m.kind === 'author'
              ? 'Ответ пользователя'
              : 'Ответ поддержки') +
          ' · ' +
          date(m.createdAt) +
          '</small><p>' +
          esc(m.text) +
          '</p>' +
          (m.deliveries?.length
            ? '<small>' + esc(delivery[m.deliveries[0].status]) + '</small>'
            : '') +
          '</article>',
      )
      .join('');
  return {
    esc,
    roles,
    states,
    delivery,
    improvementStates,
    date,
    organizationRecord,
    accountRecord,
    supportRecord,
    field,
    reason,
    form,
    heading,
    close,
    button,
    supportMessages,
  };
}

function createAdminDetails(records) {
  const { esc, roles, states, delivery, date, field, reason, form, heading, close, button } =
    records;
  function organization(org) {
    const profile = form(
      'profile',
      org.id,
      org.revision,
      '/api/admin/organizations/update',
      '<div class="admin-profile-controls">' +
        field('Название для клиентов', 'name', org.name, 'required maxlength="120"') +
        field('Город', 'city', org.city, 'maxlength="120"') +
        field('Телефон', 'phone', org.phone, 'type="tel" maxlength="40"') +
        '</div>' +
        button('Сохранить профиль'),
    );
    const access = form(
      'organizationAccess',
      org.id,
      org.revision,
      '/api/admin/organizations/access',
      '<p>Действует только на эту организацию. Статус подписки не изменится.</p>' +
        '<input type="hidden" name="status" value="' +
        (org.status === 'active' ? 'suspended' : 'active') +
        '">' +
        reason() +
        button(org.status === 'active' ? 'Приостановить организацию' : 'Восстановить доступ'),
    );
    const limits = org.limits || {};
    const terms = form(
      'subscription',
      org.id,
      org.subscriptionRevision,
      '/api/admin/subscriptions/update',
      '<p>Ручные условия доступа. Выбор «Платный» не подтверждает оплату.</p><div class="admin-controls">' +
        '<label class="field">План картотеки<select name="plan"><option value="free"' +
        (org.plan === 'free' ? ' selected' : '') +
        '>Бесплатный</option><option value="paid"' +
        (org.plan === 'paid' ? ' selected' : '') +
        '>Платный</option></select></label>' +
        field(
          'Лимит клиентов',
          'patients',
          limits.patients,
          'type="number" min="1" max="100000" required',
        ) +
        field(
          'Лимит фотографий',
          'photos',
          limits.photos,
          'type="number" min="1" max="1000000" required',
        ) +
        '<label class="admin-check"><input type="checkbox" name="publicBooking"' +
        (limits.publicBooking ? ' checked' : '') +
        '> Онлайн-запись доступна</label><label class="admin-check"><input type="checkbox" name="automaticNotifications"' +
        (limits.automaticNotifications ? ' checked' : '') +
        '> Уведомления доступны</label></div>' +
        reason() +
        button('Сохранить условия'),
    );
    const usage = org.usage?.available
      ? org.usage.patients +
        ' / ' +
        limits.patients +
        ' клиентов · ' +
        org.usage.photos +
        ' / ' +
        limits.photos +
        ' фотографий'
      : 'Использование лимитов сейчас недоступно';
    const members = org.members
      .map(
        (member) =>
          '<li>' +
          esc(member.displayName) +
          ' · ' +
          esc(roles[member.role] || member.role) +
          ' · ' +
          esc(member.email) +
          (member.status === 'active' ? '' : ' · доступ приостановлен') +
          '</li>',
      )
      .join('');
    return (
      close +
      '<p class="admin-contact-line">' +
      esc(org.ownerName) +
      ' · ' +
      esc(org.ownerEmail) +
      ' · ' +
      esc(org.timeZone) +
      '</p><p class="admin-note-inline">' +
      esc(usage) +
      '<br>Последняя активность: ' +
      date(org.lastActivityAt) +
      '</p><div class="admin-detail-grid">' +
      heading('Профиль', profile) +
      heading('Доступ организации', access) +
      heading('Условия картотеки', terms) +
      heading(
        'Пакет помощника',
        '<p>Месячный пакет, остаток задач и пробное подключение.</p>' +
          '<button type="button" class="secondary" data-admin-billing-organization="' +
          esc(org.id) +
          '">Открыть пакет помощника</button>',
      ) +
      heading(
        'Сотрудники',
        '<ul class="admin-memberships">' +
          members +
          '</ul>' +
          '<div class="admin-related-actions"><button type="button" class="text-btn" data-admin-related="support" data-organization="' +
          esc(org.id) +
          '">Обращения организации</button><button type="button" class="text-btn" data-admin-related="audit" data-organization="' +
          esc(org.id) +
          '">История организации</button></div>',
      ) +
      '</div>'
    );
  }
  function account(person) {
    let html =
      close +
      '<p class="admin-note-inline">Почта ' +
      (person.emailVerified ? 'подтверждена' : 'не подтверждена') +
      ' · Последний вход: ' +
      date(person.lastLoginAt) +
      ' · Действующих сеансов: ' +
      person.sessions +
      '</p>' +
      '<ul class="admin-memberships">' +
      person.memberships
        .map(
          (m) =>
            '<li>' +
            esc(m.organizationName) +
            ' · ' +
            esc(roles[m.role] || m.role) +
            (m.status === 'active' ? '' : ' · доступ приостановлен') +
            '</li>',
        )
        .join('') +
      '</ul>';
    if (person.globalAdmin)
      return (
        html + '<p>Системная учётная запись. Смена почты и блокировка этим способом недоступны.</p>'
      );
    const access = form(
      'accountAccess',
      person.id,
      person.revision,
      '/api/admin/accounts/update',
      '<p>Влияет на вход этого человека во все его организации.</p><input type="hidden" name="status" value="' +
        (person.status === 'active' ? 'suspended' : 'active') +
        '">' +
        reason() +
        button(person.status === 'active' ? 'Заблокировать пользователя' : 'Восстановить доступ'),
    );
    const sessions = form(
      'sessions',
      person.id,
      person.revision,
      '/api/admin/accounts/sessions/revoke',
      '<p>Завершить сеансы без блокировки аккаунта и смены пароля.</p>' +
        reason() +
        button('Завершить все сеансы'),
    );
    const recovery = person.recovery
      ? '<p>Ожидается подтверждение новой почты: ' +
        esc(person.recovery.email) +
        '. Срок: ' +
        date(person.recovery.expiresAt) +
        '. Прежний адрес продолжает работать.</p><p>Письмо: ' +
        esc(delivery[person.recovery.deliveries?.[0]?.status] || 'В очереди') +
        '</p>' +
        form(
          'cancelRecovery',
          person.id,
          person.revision,
          '/api/admin/accounts/email/cancel',
          reason() + button('Отменить запрос'),
        )
      : person.mailConfigured === false
        ? '<p>Отправка почты не подключена. Восстановление адреса пока недоступно; прежний вход сохраняется.</p>'
        : form(
            'emailRecovery',
            person.id,
            person.revision,
            '/api/admin/accounts/email',
            '<p>Проверьте принадлежность аккаунта. Новая почта станет логином только после подтверждения письма.</p>' +
              field(
                'Новый адрес для входа',
                'email',
                '',
                'type="email" required maxlength="254" autocomplete="off"',
              ) +
              reason() +
              '<label class="admin-check"><input type="checkbox" name="identityConfirmed" required> Принадлежность аккаунта проверена мной</label>' +
              field(
                'Ваш пароль администратора',
                'password',
                '',
                'type="password" required maxlength="128" autocomplete="current-password"',
              ) +
              button('Отправить подтверждение'),
          );
    return (
      html +
      '<div class="admin-detail-grid">' +
      heading('Доступ пользователя', access) +
      heading('Восстановление почты', recovery) +
      heading('Сеансы', sessions) +
      '</div>'
    );
  }
  function support(ticket) {
    const proposal = ticket.kind === 'improvement';
    const statusForm = form(
      'caseState',
      ticket.id,
      ticket.revision,
      '/api/admin/support/update',
      '<label class="field">' +
        (proposal ? 'Состояние предложения' : 'Состояние обращения') +
        '<select name="' +
        (proposal ? 'improvementState' : 'state') +
        '">' +
        Object.entries(proposal ? records.improvementStates : states)
          .map(
            ([value, title]) =>
              '<option value="' +
              value +
              '"' +
              ((proposal ? ticket.improvementState || 'received' : ticket.state) === value
                ? ' selected'
                : '') +
              '>' +
              title +
              '</option>',
          )
          .join('') +
        '</select></label>' +
        (proposal ? '<input type="hidden" name="state" value="' + esc(ticket.state) + '">' : '') +
        '<label class="admin-check"><input name="claim" type="checkbox"> Назначить меня ответственным</label>' +
        button('Сохранить состояние'),
    );
    const messageForm = form(
      'caseMessage',
      ticket.id,
      ticket.revision,
      '/api/admin/support/message',
      '<label class="field">Тип сообщения<select name="kind"><option value="internal">Внутренняя заметка</option><option value="reply"' +
        (ticket.mailConfigured ? '' : ' disabled') +
        '>Ответ пользователю на почту</option></select></label>' +
        '<label class="field">Сообщение<textarea name="text" rows="4" maxlength="1500" required></textarea></label>' +
        '<p class="admin-note-inline">Не включайте пароли и данные клиентов. Внутренняя заметка видна только поддержке.' +
        (ticket.mailConfigured
          ? ' Ответ направим на текущую почту аккаунта.'
          : ' Отправка ответов на почту не подключена.') +
        '</p>' +
        button('Сохранить сообщение'),
    );
    const messages = records.supportMessages(ticket.messages);
    return (
      close +
      '<p>' +
      esc(ticket.displayName) +
      ' · ' +
      esc(ticket.email) +
      ' · ' +
      esc(ticket.organization || 'Без организации') +
      '</p><p class="admin-case-description">' +
      esc(ticket.description) +
      '</p>' +
      '<p class="admin-note-inline">Доставка оператору: ' +
      ticket.deliveries
        .map((item) => esc(item.channel) + ' — ' + esc(delivery[item.status]))
        .join('; ') +
      '. Это не состояние решения проблемы.</p><div class="admin-detail-grid">' +
      heading('Обработка', statusForm) +
      heading('Заметка или ответ', messageForm) +
      '</div>' +
      (ticket.messagesNext
        ? '<button class="text-btn" type="button" data-admin-older-messages data-before="' +
          ticket.messagesNext.before +
          '" data-before-id="' +
          esc(ticket.messagesNext.beforeId) +
          '">Показать прежние сообщения</button>'
        : '') +
      '<div class="admin-thread">' +
      messages +
      '</div>'
    );
  }
  return { organization, account, support };
}

function createAdminBackupView({ records }) {
  const { esc, date } = records;
  const health = {
    unconfigured: 'Не настроено',
    unavailable: 'Состояние недоступно',
    stale: 'Нет свежего отчёта',
    failed: 'Последняя попытка не завершена',
    incomplete: 'Защита неполная',
    protected: 'Копия и восстановление проверены',
  };
  const states = {
    preparing: 'Подготовка',
    copying: 'Создание копии',
    uploading: 'Внешнее хранение',
    drilling: 'Проверка восстановления',
    protected: 'Проверено',
    local_only: 'Только локально',
    failed: 'Ошибка',
    interrupted: 'Прервано',
  };
  const errors = {
    BACKUP_DISK_SPACE: 'Недостаточно свободного места.',
    BACKUP_REMOTE_FAILED: 'Не удалось подтвердить внешнюю копию.',
    BACKUP_REMOTE_RETENTION: 'Не подтверждена защита внешней копии от удаления.',
    BACKUP_REMOTE_CHECKSUM: 'Контрольная сумма внешней копии не совпала.',
    BACKUP_DRILL_FAILED: 'Пробное восстановление не завершилось.',
    BACKUP_LEASE_LOST: 'Задание потеряло блокировку запуска.',
    BACKUP_SOURCE_TOO_LARGE: 'Размер копии превышает возможности текущего переноса.',
  };
  function render(value = { health: 'unconfigured' }) {
    const state = health[value.health] || health.unavailable;
    const row = (label, time) =>
      '<div><dt>' + label + '</dt><dd>' + (time ? date(time) : 'Не подтверждено') + '</dd></div>';
    return (
      '<section class="admin-detail-section admin-backups"><div class="admin-backup-heading"><h3>Резервные копии</h3>' +
      '<span class="admin-backup-state" data-health="' +
      esc(value.health || 'unavailable') +
      '">' +
      esc(state) +
      '</span></div>' +
      (!value.configured
        ? '<p>Процесс резервирования ещё не подключён к панели.</p>'
        : '<dl class="admin-backup-facts">' +
          row('Локальная копия', value.lastLocalAt) +
          row('Независимое хранилище', value.lastRemoteAt) +
          row('Пробное восстановление', value.lastDrillAt) +
          '</dl>' +
          (!value.remoteConfigured
            ? '<p class="admin-backup-warning">Внешнее хранилище не подключено. Локальная копия не защищает от потери сервера.</p>'
            : '') +
          (value.error
            ? '<p class="admin-backup-warning">' +
              esc(errors[value.error] || 'Резервирование завершилось с ошибкой.') +
              '</p>'
            : '') +
          (value.maintenanceError
            ? '<p class="admin-backup-warning">Копия создана, но очистка старых файлов не завершена.</p>'
            : '') +
          (value.health === 'stale'
            ? '<p class="admin-backup-warning">Нужна проверка расписания и отдельного процесса резервирования.</p>'
            : '') +
          (value.recent?.length
            ? '<details><summary>Последние попытки</summary><ul class="admin-backup-history">' +
              value.recent
                .map(
                  (item) =>
                    '<li><time>' +
                    (item.startedAt ? date(item.startedAt) : '—') +
                    '</time><span>' +
                    esc(states[item.state] || 'Неизвестно') +
                    '</span></li>',
                )
                .join('') +
              '</ul></details>'
            : '')) +
      '<p class="hint">Копии и ключи недоступны из веб-панели. Восстановление выполняется отдельно, без перезаписи работающей базы.</p></section>'
    );
  }
  return { render };
}

function createAdminBillingMoney() {
  function integer(value) {
    return typeof value === 'string' && value.length <= 128 && /^-?\d+$/.test(value)
      ? BigInt(value)
      : null;
  }
  function format(value, scale = 1000000n, fallback = null) {
    const parsed = integer(value);
    if (parsed === null)
      return Number.isFinite(fallback)
        ? fallback.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) +
            ' ₽'
        : '—';
    const absolute = parsed < 0n ? -parsed : parsed,
      places = scale.toString().length - 1;
    const whole = (absolute / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    let fraction = (absolute % scale).toString().padStart(places, '0');
    while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
    return (parsed < 0n ? '−' : '') + whole + ',' + fraction + ' ₽';
  }
  function difference(summary) {
    const revenue = integer(summary.netPaidKopecks ?? summary.paidRevenueKopecks),
      cost = integer(summary.providerCostMicrorub);
    return revenue !== null && cost !== null
      ? format((revenue * 10000n - cost).toString())
      : format(
          null,
          1000000n,
          Number.isFinite(summary.paidRevenueRub) && Number.isFinite(summary.providerCostRub)
            ? summary.paidRevenueRub - summary.providerCostRub
            : null,
        );
  }
  return { format, difference };
}

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

function createAdminOverview({ $, records }) {
  const { esc, date } = records;
  const backups = createAdminBackupView({ records });
  const audit = createAdminAuditView({ $, records });
  function renderOverview(data) {
    $('#admin-account-count').textContent = data.accountsActive + '/' + data.accountsTotal;
    $('#admin-org-count').textContent = data.organizationsTotal;
    $('#admin-summary').innerHTML = [
      ['Новые обращения', data.supportNew, 'support', 'new'],
      ['Всего нерешённых', data.supportOpen, 'support', 'open'],
      ['Организации на паузе', data.organizationsSuspended, 'organizations', 'suspended'],
      ['Ошибки доставки', data.failedDeliveries, 'system'],
    ]
      .map(
        ([label, count, target, filter]) =>
          '<button type="button" class="admin-summary-item" data-admin-filter="' +
          (filter || '') +
          '" data-admin-jump="' +
          target +
          '"><strong>' +
          count +
          '</strong><span>' +
          label +
          '</span></button>',
      )
      .join('');
  }
  function renderSystem(system) {
    const labels = {
      telegram_jobs: 'Telegram клиентов',
      staff_notification_jobs: 'Telegram сотрудников',
      support_deliveries: 'Доставка обращений оператору',
      admin_email_jobs: 'Письма поддержки и восстановления',
    };
    $('#admin-system').innerHTML =
      '<p>Данные на ' +
      date(system.observedAt) +
      '. Версия: ' +
      esc(system.version) +
      '</p><div class="admin-system-grid"><article><h3>Почта</h3><p>' +
      (system.mailConfigured ? 'Подключена' : 'Не подключена') +
      '</p></article><article><h3>Поддержка Telegram</h3><p>' +
      (system.support.connected
        ? 'Соединение установлено'
        : system.support.available
          ? 'Настроена · нет подтверждения связи'
          : 'Не подключена') +
      '</p></article><article><h3>Процесс сервера</h3><p>Память: ' +
      system.memoryMegabytes +
      ' МБ · Работает ' +
      Math.floor(system.uptimeSeconds / 60) +
      ' мин.</p></article></div>' +
      backups.render(system.backups) +
      Object.entries(system.queues)
        .map(
          ([queue, rows]) =>
            '<section class="admin-detail-section"><h3>' +
            labels[queue] +
            '</h3><p>' +
            (rows.length
              ? rows
                  .map((row) => esc(records.delivery[row.status] || row.status) + ': ' + row.count)
                  .join(' · ')
              : 'Заданий нет') +
            '</p></section>',
        )
        .join('');
  }
  return { renderOverview, renderAudit: audit.renderAudit, renderSystem };
}

function createAdminLists({ $, request, records, details, message }) {
  const config = {
    organizations: {
      route: 'organizations',
      container: '#admin-organizations',
      search: '#admin-org-search',
      count: '#admin-org-result-count',
      more: '#admin-org-more',
      status: '#admin-org-status',
      plan: '#admin-org-plan',
      render: records.organizationRecord,
    },
    accounts: {
      route: 'accounts',
      container: '#admin-accounts',
      search: '#admin-account-search',
      count: '#admin-account-result-count',
      more: '#admin-account-more',
      status: '#admin-account-status',
      render: records.accountRecord,
    },
    support: {
      route: 'support',
      container: '#admin-support-list',
      count: '#admin-support-count',
      more: '#admin-support-more',
      status: '#admin-support-state',
      render: records.supportRecord,
    },
  };
  const state = Object.fromEntries(
    Object.keys(config).map((key) => [key, { generation: 0, next: null, loaded: 0, filters: {} }]),
  );
  let timer = null;
  function filters(kind) {
    const c = config[kind],
      result = { ...state[kind].filters };
    if (c.search) result.q = $(c.search).value.trim();
    if (c.status) result[kind === 'support' ? 'state' : 'status'] = $(c.status).value;
    if (c.plan) result.plan = $(c.plan).value;
    return result;
  }
  async function load(kind, more = false) {
    const c = config[kind],
      current = state[kind];
    const dirty = $(c.container).querySelector('[data-admin-record][data-dirty]');
    if (!more && dirty) {
      if (!confirm('Обновить список без сохранения открытой карточки?')) return;
      delete dirty.dataset.dirty;
    }
    const generation = ++current.generation;
    const parameters = { ...filters(kind) };
    if (more && current.next)
      Object.assign(
        parameters,
        typeof current.next === 'string' ? { cursor: current.next } : current.next,
      );
    $(c.more).disabled = true;
    $(c.count).textContent = 'Загружаем…';
    try {
      const data = await request('/api/admin/' + c.route + '?' + new URLSearchParams(parameters));
      if (generation !== current.generation) return;
      if (!more) {
        $(c.container).innerHTML = '';
        current.loaded = 0;
      }
      const existing = new Set(
        [...$(c.container).querySelectorAll('[data-id]')].map((row) => row.dataset.id),
      );
      const items = data.items.filter((item) => !existing.has(item.id));
      $(c.container).insertAdjacentHTML('beforeend', items.map(c.render).join(''));
      current.loaded += items.length;
      current.next = data.nextCursor || data.next || null;
      $(c.count).textContent = 'Показано ' + current.loaded + ' из ' + data.total;
      $(c.more).hidden = !current.next;
      if (!current.loaded)
        $(c.container).innerHTML =
          '<p class="admin-no-results">По вашему запросу ничего не найдено.</p>';
      bindRecords($(c.container));
    } catch (error) {
      if (generation === current.generation) {
        $(c.count).textContent = 'Список не обновлён';
        message(error.message, true);
      }
    } finally {
      if (generation === current.generation) $(c.more).disabled = false;
    }
  }
  async function reloadRecord(record) {
    const kind = record.dataset.kind;
    const serial = Number(record.dataset.loading || 0) + 1;
    record.dataset.loading = serial;
    const body = record.querySelector('.admin-detail-body');
    body.setAttribute('aria-busy', 'true');
    try {
      const route = kind === 'support' ? '/api/admin/support/case' : '/api/admin/' + kind;
      const data = await request(route + '?id=' + encodeURIComponent(record.dataset.id));
      if (!record.isConnected || !record.open || Number(record.dataset.loading) !== serial) return;
      const renderer =
        records[
          kind === 'organization'
            ? 'organizationRecord'
            : kind === 'account'
              ? 'accountRecord'
              : 'supportRecord'
        ];
      const template = document.createElement('template');
      template.innerHTML = renderer(
        kind === 'support' ? { ...data, excerpt: data.description.slice(0, 160) } : data,
      );
      record.querySelector('summary').innerHTML =
        template.content.querySelector('summary').innerHTML;
      body.innerHTML = details[kind](data);
      delete record.dataset.dirty;
    } catch (error) {
      if (record.isConnected && Number(record.dataset.loading) === serial) {
        message(error.message, true);
        if (!body.children.length)
          body.innerHTML = '<p>Карточка не загружена. Закройте и откройте её снова.</p>';
      }
    } finally {
      if (Number(record.dataset.loading) === serial) body.removeAttribute('aria-busy');
    }
  }
  function bindRecords(container) {
    container.querySelectorAll('[data-admin-record]').forEach((record) => {
      if (record.dataset.bound) return;
      record.dataset.bound = '1';
      record.addEventListener('toggle', async () => {
        if (!record.open) return;
        const other = container.querySelector(
          '[data-admin-record][open]:not([data-id="' + record.dataset.id + '"])',
        );
        if (other) {
          if (
            other.dataset.dirty &&
            !confirm('Закрыть предыдущую карточку без сохранения изменений?')
          ) {
            record.open = false;
            return;
          }
          other.open = false;
          delete other.dataset.dirty;
        }
        if (!record.dataset.dirty) await reloadRecord(record);
      });
    });
  }
  function search(kind) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void load(kind);
    }, 250);
  }
  function related(kind, organizationId) {
    if (state[kind]) state[kind].filters = organizationId ? { organizationId } : {};
    if (kind === 'support') $('#admin-support-clear').hidden = !organizationId;
  }
  return { load, search, reloadRecord, related, bindRecords, config };
}

function bindAdminEvents({
  $,
  token,
  show,
  request,
  message,
  changeView,
  lists,
  reloadSummary,
  loadAudit,
}) {
  const pending = new window.WeakMap();
  function requestId() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const text = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    return [
      text.slice(0, 8),
      text.slice(8, 12),
      text.slice(12, 16),
      text.slice(16, 20),
      text.slice(20),
    ].join('-');
  }
  function payload(form) {
    const values = new FormData(form),
      kind = form.dataset.adminCommand;
    const body = { expectedRevision: Number(form.dataset.revision) };
    body[
      kind === 'profile' || kind === 'subscription' || kind === 'organizationAccess'
        ? 'organizationId'
        : kind.startsWith('case')
          ? 'caseId'
          : 'accountId'
    ] = form.dataset.id;
    if (values.has('reason')) body.reason = values.get('reason').trim();
    if (kind === 'profile')
      body.changes = Object.fromEntries(
        ['name', 'city', 'phone'].map((key) => [key, values.get(key)]),
      );
    if (kind === 'subscription') {
      body.plan = values.get('plan');
      body.limits = {
        patients: Number(values.get('patients')),
        photos: Number(values.get('photos')),
        publicBooking: values.has('publicBooking'),
        automaticNotifications: values.has('automaticNotifications'),
      };
    }
    if (kind === 'accountAccess' || kind === 'organizationAccess')
      body.status = values.get('status');
    if (kind === 'emailRecovery') {
      body.email = values.get('email').trim();
      body.identityConfirmed = values.has('identityConfirmed');
      body.password = values.get('password');
    }
    if (kind === 'caseState') {
      body.state = values.get('state');
      if (values.has('improvementState')) body.improvementState = values.get('improvementState');
      body.claim = values.has('claim');
    }
    if (kind === 'caseMessage') {
      body.kind = values.get('kind');
      body.text = values.get('text').trim();
    }
    return body;
  }
  async function mutate(form) {
    if (form.dataset.busy) return;
    const body = payload(form),
      { password, ...safe } = body;
    const signature = JSON.stringify([form.dataset.route, safe]);
    let operation = pending.get(form);
    if (operation?.unknown && operation.signature !== signature) {
      message(
        'Результат предыдущего действия неизвестен. Повторите его с прежними данными, прежде чем менять форму.',
        true,
      );
      return;
    }
    if (!operation || operation.signature !== signature) operation = { id: requestId(), signature };
    body.requestId = operation.id;
    pending.set(form, operation);
    const kind = form.dataset.adminCommand;
    if (
      [
        'accountAccess',
        'organizationAccess',
        'subscription',
        'sessions',
        'cancelRecovery',
        'emailRecovery',
      ].includes(kind) &&
      !confirm(
        kind === 'accountAccess'
          ? 'Это действие влияет на все организации пользователя. Выполнить?'
          : kind === 'organizationAccess'
            ? 'Изменить доступ выбранной организации? Подписка не изменится.'
            : kind === 'emailRecovery'
              ? 'Отправить подтверждение новой почте после выполненной вами проверки личности?'
              : 'Выполнить действие для выбранной записи?',
      )
    )
      return;
    form.dataset.busy = '1';
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    message('Выполняем…');
    try {
      let result;
      try {
        result = await request(form.dataset.route, { method: 'POST', body: JSON.stringify(body) });
      } catch (error) {
        if (error.unknown) {
          const saved = await request('/api/admin/operation?requestId=' + operation.id).catch(
            () => null,
          );
          if (!saved?.result) throw error;
          result = saved.result;
        } else throw error;
      }
      pending.delete(form);
      const record = form.closest('[data-admin-record]');
      delete record.dataset.dirty;
      await lists.reloadRecord(record);
      await reloadSummary();
      message(
        result.pending
          ? 'Запрос сохранён. Подтверждение поставлено в почтовую очередь; прежний вход пока действует.'
          : result.queued
            ? 'Ответ сохранён и поставлен в почтовую очередь. Обращение не закрыто автоматически.'
            : 'Изменения сохранены.',
      );
    } catch (error) {
      operation.unknown = Boolean(error.unknown);
      if (!operation.unknown) pending.delete(form);
      message(
        operation.unknown
          ? 'Ответ сервера не получен. Не меняйте данные: повторите действие, дубликат не создастся.'
          : error.message,
        true,
      );
    } finally {
      if (form.querySelector('[name="password"]'))
        form.querySelector('[name="password"]').value = '';
      delete form.dataset.busy;
      button.disabled = false;
    }
  }
  for (const [kind, c] of Object.entries(lists.config)) {
    if (c.search) $(c.search).addEventListener('input', () => lists.search(kind));
    for (const selector of [c.status, c.plan].filter(Boolean))
      $(selector).addEventListener('change', () => lists.load(kind));
    $(c.more).addEventListener('click', () => lists.load(kind, true));
  }
  $('#admin-audit-more').addEventListener('click', () => loadAudit(true));
  $('#admin-audit-event').addEventListener('change', () => loadAudit());
  let auditSearchTimer;
  $('#admin-audit-search').addEventListener('input', () => {
    clearTimeout(auditSearchTimer);
    auditSearchTimer = setTimeout(() => {
      void loadAudit();
    }, 250);
  });
  $('#admin-audit-clear').addEventListener('click', () => loadAudit(false, null));
  $('#admin-support-clear').addEventListener('click', () => {
    lists.related('support', null);
    void lists.load('support');
  });
  $('#admin-setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = form.querySelector('button');
    $('#admin-error').textContent = '';
    if ($('#admin-password').value !== $('#admin-repeat').value) {
      $('#admin-error').textContent = 'Пароли не совпадают.';
      return;
    }
    button.disabled = true;
    try {
      await request('/api/admin/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          token,
          email: $('#admin-email').value.trim(),
          password: $('#admin-password').value,
          displayName: $('#admin-name').value,
        }),
      });
      form.reset();
      show('#admin-created');
    } catch (error) {
      $('#admin-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('#admin-logout').addEventListener('click', async () => {
    try {
      await request('/api/auth/logout', { method: 'POST', body: '{}' });
      location.replace('/');
    } catch (error) {
      message(error.message, true);
    }
  });
  document.addEventListener('input', (event) => {
    const record = event.target.closest('[data-admin-record]');
    if (record) record.dataset.dirty = '1';
  });
  document.addEventListener('change', (event) => {
    const record = event.target.closest('[data-admin-record]');
    if (record) record.dataset.dirty = '1';
  });
  document.addEventListener('click', (event) => {
    const summary = event.target.closest('[data-admin-record]>summary');
    if (!summary) return;
    const record = summary.closest('[data-admin-record]');
    if (record.open && record.dataset.dirty) {
      if (!confirm('Закрыть карточку без сохранения изменений?')) event.preventDefault();
      else delete record.dataset.dirty;
    }
  });
  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-admin-command]');
    if (!form) return;
    event.preventDefault();
    void mutate(form);
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-admin-older-messages]');
    if (!button || button.disabled) return;
    const record = button.closest('[data-admin-record]');
    button.disabled = true;
    try {
      const data = await request(
        '/api/admin/support/messages?' +
          new URLSearchParams({
            id: record.dataset.id,
            before: button.dataset.before,
            beforeId: button.dataset.beforeId,
          }),
      );
      if (!record.isConnected) return;
      record
        .querySelector('.admin-thread')
        .insertAdjacentHTML('afterbegin', createAdminRecords().supportMessages(data.items));
      if (data.next) {
        button.dataset.before = data.next.before;
        button.dataset.beforeId = data.next.beforeId;
      } else button.hidden = true;
    } catch (error) {
      message(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest(
      '[data-admin-view], [data-admin-jump], [data-admin-related], [data-admin-close]',
    );
    if (!button) return;
    if (button.hasAttribute('data-admin-close')) {
      const record = button.closest('[data-admin-record]');
      if (record.dataset.dirty && !confirm('Закрыть карточку без сохранения изменений?')) return;
      delete record.dataset.dirty;
      record.open = false;
      record.querySelector('summary').focus();
      return;
    }
    if (button.dataset.adminRelated === 'support') {
      lists.related('support', button.dataset.organization);
      void changeView('support');
      return;
    }
    if (button.dataset.adminRelated === 'audit') {
      void changeView('audit', button.dataset.organization);
      return;
    }
    if (button.dataset.adminFilter) {
      const target = button.dataset.adminJump;
      $(target === 'support' ? '#admin-support-state' : '#admin-org-status').value =
        button.dataset.adminFilter;
    }
    void changeView(button.dataset.adminView || button.dataset.adminJump);
  });
}

function createAdminVoiceProviders({ records }) {
  const { esc } = records,
    models = new Map(),
    speech = new Map(),
    bound = new WeakSet();
  const defaults = {
    demo: 'deepseek/deepseek-flash',
    timeweb: 'deepseek/deepseek-flash',
    codex: 'codex-default',
  };
  const stages = {
    stt: 'Распознавание речи',
    llm: 'Обработка команды',
    tts: 'Озвучивание ответа',
  };
  const speechModels = {
    stt: {
      'openai/gpt-4o-mini-transcribe': 'GPT-4o mini Transcribe',
      'openai/gpt-4o-transcribe': 'GPT-4o Transcribe',
    },
    tts: { 'openai/gpt-4o-mini-tts': 'GPT-4o mini TTS' },
  };
  const voices = Object.fromEntries(
    [
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'fable',
      'nova',
      'onyx',
      'sage',
      'shimmer',
      'verse',
      'marin',
      'cedar',
    ].map((voice) => [voice, voice]),
  );
  function modelChoices(stage, provider) {
    return provider === 'local'
      ? stage === 'stt'
        ? { 'whisper-base': 'Whisper base (на этом компьютере)' }
        : { 'system-ru': 'Русский голос устройства' }
      : speechModels[stage];
  }
  function voiceChoices(provider) {
    return provider === 'local' ? { 'ru-local': 'Локальный русский голос' } : voices;
  }
  function localStatus(stage, available) {
    if (stage === 'stt')
      return available === true
        ? 'Whisper работает только на текущем компьютере, без отправки аудио в Timeweb.'
        : 'Локальный Whisper пока недоступен. Нужны локальный запуск и установленная модель на текущем компьютере.';
    return available === true
      ? 'Браузер проверит русский локальный голос перед записью. Доступно только на текущем компьютере, без сетевых голосов.'
      : 'Голос устройства доступен только в локальном запуске. Браузер отдельно проверит русский локальный голос перед записью.';
  }
  const modelAttributes =
    'minlength="2" maxlength="120" required pattern="[A-Za-z0-9][A-Za-z0-9._:\\/\\-]{1,119}"';
  function options(selected, entries) {
    return Object.entries(entries)
      .map(
        ([value, label]) =>
          '<option value="' +
          esc(value) +
          '"' +
          (selected === value ? ' selected' : '') +
          '>' +
          esc(label) +
          '</option>',
      )
      .join('');
  }
  function llmModel(data) {
    const codex = data.provider === 'codex';
    models.set(data.provider, data.model || defaults[data.provider]);
    return (
      '<label class="field" data-voice-llm-model="standard"' +
      (codex ? ' hidden' : '') +
      '><span data-voice-llm-model-label>' +
      (data.provider === 'timeweb' ? 'Модель Timeweb' : 'Модель') +
      '</span><input name="model.llm" value="' +
      esc(models.get(codex ? 'timeweb' : data.provider) || defaults.timeweb) +
      '" ' +
      modelAttributes +
      (codex ? ' disabled' : '') +
      '></label>' +
      '<label class="field" data-voice-llm-model="codex"' +
      (codex ? '' : ' hidden') +
      '>Модель локального Codex<input name="model.codex" value="' +
      esc(models.get('codex') || defaults.codex) +
      '" ' +
      modelAttributes +
      (codex ? '' : ' disabled') +
      '></label>'
    );
  }
  function billing(provider) {
    return provider === 'codex'
      ? 'Codex расходует лимиты подписки. Timeweb оплачивается отдельно для выбранных этапов.'
      : 'Распознавание и озвучивание настраиваются отдельно.';
  }
  function codexStatus(status) {
    if (status?.available === true) return 'Codex доступен. Авторизация проверяется при запросе.';
    if (status?.available === false)
      return 'Доступно только в локальном просмотре с установленным Codex.';
    return 'Состояние локального подключения Codex не получено.';
  }
  function provider(stage, data, status) {
    const providers = { demo: 'Демонстрационный', timeweb: 'Timeweb' };
    if (stage === 'llm') providers.codex = 'Локальный Codex';
    else {
      providers.local = stage === 'stt' ? 'Локально (Whisper)' : 'Локальный голос устройства';
      speech.set(stage + ':' + data.provider, {
        model: data.model,
        voice: data.voice,
      });
    }
    const model =
      stage === 'llm'
        ? llmModel(data)
        : '<label class="field">Модель<select name="model.' +
          stage +
          '">' +
          options(data.model, modelChoices(stage, data.provider)) +
          '</select></label>';
    return (
      '<section class="admin-voice-provider" data-voice-provider="' +
      stage +
      '" data-current-provider="' +
      esc(data.provider) +
      '" data-local-available="' +
      (status?.local?.[stage]?.available === true ? 'true' : 'false') +
      '"><h4>' +
      stages[stage] +
      '</h4><label class="field">Провайдер<select name="provider.' +
      stage +
      '">' +
      options(data.provider || 'demo', providers) +
      '</select></label>' +
      model +
      (stage === 'tts'
        ? '<label class="field">Голос<select name="voice.tts">' +
          options(data.voice, voiceChoices(data.provider)) +
          '</select></label>'
        : '') +
      (stage === 'llm'
        ? '<p data-voice-codex-status>' +
          esc(codexStatus(status?.codex)) +
          '</p><p data-voice-llm-billing>' +
          esc(billing(data.provider)) +
          '</p>'
        : '<p data-voice-local-status' +
          (data.provider === 'local' ? '' : ' hidden') +
          '>' +
          esc(localStatus(stage, status?.local?.[stage]?.available)) +
          '</p>') +
      '</section>'
    );
  }
  function render(data) {
    return Object.keys(stages)
      .map((stage) => provider(stage, data.providers[stage], data.providerStatus))
      .join('');
  }
  function remember(section, provider) {
    const input = section.querySelector(
      '[name="' + (provider === 'codex' ? 'model.codex' : 'model.llm') + '"]',
    );
    if (input) models.set(provider, input.value);
  }
  function switchProvider(section) {
    remember(section, section.dataset.currentProvider);
    const provider = section.querySelector('[name="provider.llm"]').value,
      codex = provider === 'codex';
    section.dataset.currentProvider = provider;
    for (const [kind, active] of [
      ['standard', !codex],
      ['codex', codex],
    ]) {
      const label = section.querySelector('[data-voice-llm-model="' + kind + '"]'),
        input = label.querySelector('input');
      label.hidden = !active;
      input.disabled = !active;
      if (active) input.value = models.get(provider) ?? defaults[provider];
    }
    section.querySelector('[data-voice-llm-model-label]').textContent =
      provider === 'timeweb' ? 'Модель Timeweb' : 'Модель';
    section.querySelector('[data-voice-llm-billing]').textContent = billing(provider);
  }
  function rememberSpeech(section) {
    const stage = section.dataset.voiceProvider;
    speech.set(stage + ':' + section.dataset.currentProvider, {
      model: section.querySelector('[name="model.' + stage + '"]').value,
      voice: section.querySelector('[name="voice.tts"]')?.value,
    });
  }
  function switchSpeech(section) {
    rememberSpeech(section);
    const stage = section.dataset.voiceProvider,
      provider = section.querySelector('[name="provider.' + stage + '"]').value,
      saved = speech.get(stage + ':' + provider);
    section.dataset.currentProvider = provider;
    section.querySelector('[name="model.' + stage + '"]').innerHTML = options(
      saved?.model,
      modelChoices(stage, provider),
    );
    if (stage === 'tts')
      section.querySelector('[name="voice.tts"]').innerHTML = options(
        saved?.voice,
        voiceChoices(provider),
      );
    const hint = section.querySelector('[data-voice-local-status]');
    hint.hidden = provider !== 'local';
    hint.textContent = localStatus(stage, section.dataset.localAvailable === 'true');
  }
  function bind(root) {
    if (bound.has(root)) return;
    bound.add(root);
    root.addEventListener('change', (event) => {
      if (event.target.name === 'provider.llm')
        switchProvider(event.target.closest('[data-voice-provider="llm"]'));
      else if (['provider.stt', 'provider.tts'].includes(event.target.name))
        switchSpeech(event.target.closest('[data-voice-provider]'));
      else if (['model.stt', 'model.tts', 'voice.tts'].includes(event.target.name))
        rememberSpeech(event.target.closest('[data-voice-provider]'));
      else if (['model.llm', 'model.codex'].includes(event.target.name))
        remember(
          event.target.closest('[data-voice-provider="llm"]'),
          event.target.closest('[data-voice-provider="llm"]').dataset.currentProvider,
        );
    });
    root.addEventListener('input', (event) => {
      if (!['model.llm', 'model.codex'].includes(event.target.name)) return;
      const section = event.target.closest('[data-voice-provider="llm"]');
      remember(section, section.dataset.currentProvider);
    });
  }
  return {
    render,
    bind,
    reset: () => {
      models.clear();
      speech.clear();
    },
  };
}

function createAdminVoiceView({ records }) {
  const { esc, date } = records;
  const providers = createAdminVoiceProviders({ records });
  const commands = {
    calendar: 'Календарь и свободные окна',
    clients: 'Поиск клиентов и открытие карточек',
    prepareAppointment: 'Подготовка новой записи',
  };
  const limits = {
    monthlyBudgetRub: ['Бюджет на месяц, ₽', 0, 100000, 0.01],
    dailyRequests: ['Запросов в день на пользователя', 1, 1000, 1],
    maxAudioSeconds: ['Голосовой запрос, секунд', 1, 60, 1],
    maxTextChars: ['Текст запроса, символов', 100, 4000, 1],
    maxReplyChars: ['Текст ответа, символов', 100, 1000, 1],
    maxOutputTokens: ['Ответ модели, токенов', 50, 1000, 1],
    requestTimeoutMs: ['Ожидание ответа, мс', 3000, 30000, 1],
  };
  const rates = {
    llmInput: 'Обработка команды: вход',
    llmOutput: 'Обработка команды: выход',
    sttInput: 'Распознавание речи: вход',
    sttOutput: 'Распознавание речи: выход',
    ttsInput: 'Озвучивание: вход',
    ttsOutput: 'Озвучивание: выход',
  };
  function field(label, name, value, attributes = '') {
    return (
      '<label class="field">' +
      esc(label) +
      '<input name="' +
      esc(name) +
      '" value="' +
      esc(value ?? '') +
      '" ' +
      attributes +
      '></label>'
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
  function options(selected, entries) {
    return Object.entries(entries)
      .map(
        ([value, label]) =>
          '<option value="' +
          esc(value) +
          '"' +
          (selected === value ? ' selected' : '') +
          '>' +
          esc(label) +
          '</option>',
      )
      .join('');
  }
  function settings(data) {
    const policy = data.policy,
      usage = data.usage || {};
    const limitFields = Object.entries(limits)
      .map(([key, [label, min, max, step]]) =>
        field(
          label,
          'limit.' + key,
          policy.limits[key],
          'type="number" min="' + min + '" max="' + max + '" step="' + step + '" required',
        ),
      )
      .join('');
    const priceFields = Object.entries(rates)
      .map(([key, label]) =>
        field(
          label,
          'rate.' + key,
          data.rates[key],
          'type="number" min="0.000001" max="1000000" step="any" required',
        ),
      )
      .join('');
    return (
      '<form data-admin-voice-form="settings" data-admin-voice-draft data-revision="' +
      esc(data.revision) +
      '"><fieldset data-voice-fields>' +
      '<section class="admin-detail-section"><h3>Доступ и возможности</h3>' +
      '<label class="field">Режим<select name="mode">' +
      options(policy.mode, {
        off: 'Выключен для всех',
        selected: 'Включён для подключённых кабинетов и участников тестирования',
      }) +
      '</select></label><p>Платное подключение управляется в разделе «Пакеты и оплата». Персональный доступ к тестированию — во вкладке «Доступ пользователей».</p>' +
      '<div class="admin-voice-checks">' +
      Object.entries(commands)
        .map(([key, label]) => check(label, 'command.' + key, policy.commands[key]))
        .join('') +
      '</div>' +
      '<p class="admin-voice-rule">Доступные действия помощника ограничены правами пользователя и настройками платформы.</p></section>' +
      '<details class="admin-voice-options"><summary>Лимиты и бюджет</summary>' +
      '<p>Период: ' +
      esc(usage.month || 'текущий месяц') +
      '. Расчётные расходы: ' +
      esc(usage.spentRub ?? 0) +
      ' ₽; зарезервировано: ' +
      esc(usage.reservedRub ?? 0) +
      ' ₽.</p><details class="admin-explanation"><summary>Как считаются расходы и запросы</summary><p>' +
      'Оценка по ставкам, не счёт Timeweb. Распознавание, обработка и озвучивание ' +
      'считаются отдельными вызовами дневного лимита.</p></details>' +
      '<div class="admin-voice-fields">' +
      limitFields +
      '</div></details>' +
      '<details class="admin-voice-options"><summary>Речь и модель</summary>' +
      '<p>Выберите распознавание, обработку команды и озвучивание.</p>' +
      '<div class="admin-voice-providers">' +
      providers.render(data) +
      '</div>' +
      '<p>Timeweb: ' +
      (data.credentialStatus?.timeweb?.configured ? 'ключ сохранён' : 'ключ не настроен') +
      '. Соединение с провайдером здесь не проверяется.</p>' +
      field(
        'Новый API-ключ Timeweb',
        'timewebApiKey',
        '',
        'type="password" minlength="12" maxlength="512" pattern="\\S{12,512}" autocomplete="new-password" spellcheck="false"',
      ) +
      '<p>Оставьте пустым, чтобы сохранить текущий ключ.</p>' +
      check('Удалить сохранённый ключ Timeweb', 'removeTimewebKey', false) +
      '</details>' +
      '<details class="admin-voice-options"><summary>Ставки для оценки расходов</summary>' +
      '<p>Рубли за миллион токенов Timeweb. Запросы локального Codex используют лимиты подписки вместо этих ставок. Изменение ставок не отправляет запросы провайдерам.</p>' +
      '<div class="admin-voice-fields">' +
      priceFields +
      '</div></details>' +
      '<label class="field">Причина изменения<input name="reason" required minlength="3" maxlength="300" autocomplete="off"></label>' +
      '</fieldset><div class="admin-voice-actions"><button class="primary" type="submit">Сохранить настройки</button>' +
      '<button class="secondary" type="button" data-voice-reload>Обновить</button></div>' +
      '<p class="admin-voice-result" data-voice-result role="status" aria-live="polite"></p></form>'
    );
  }
  function memberLimits(data) {
    return (
      '<details class="admin-voice-options"><summary>Персональные лимиты</summary>' +
      '<p>Пустое поле — общий лимит. Расходы Timeweb ограничены общим бюджетом.</p>' +
      '<div class="admin-voice-fields">' +
      Object.entries(limits)
        .filter(([key]) => key !== 'monthlyBudgetRub')
        .map(([key, [label, min, max, step]]) =>
          field(
            label,
            'memberLimit.' + key,
            data.limits?.[key] ?? '',
            'type="number" min="' +
              min +
              '" max="' +
              max +
              '" step="' +
              step +
              '" placeholder="' +
              esc(data.effectiveLimits?.[key] ?? '') +
              '"',
          ),
        )
        .join('') +
      '</div></details>'
    );
  }
  function membership(data, identity) {
    const reason = data.effective?.reason || 'Состояние доступа не определено';
    return (
      '<form data-admin-voice-form="member" data-admin-voice-draft data-revision="' +
      esc(data.revision) +
      '"><fieldset data-voice-fields><p><strong>' +
      esc(identity.displayName) +
      '</strong> · ' +
      esc(identity.organizationName) +
      '</p><p class="admin-voice-effective" data-enabled="' +
      Boolean(data.effective?.enabled) +
      '">Сейчас: ' +
      (data.effective?.enabled ? 'доступен' : 'недоступен') +
      '. ' +
      esc(reason) +
      '</p>' +
      check('Разрешить помощника этому пользователю в этой организации', 'enabled', data.enabled) +
      '<p>Разрешение действует только для выбранного членства. Общий режим и действующие права ' +
      'могут ограничить доступ.</p>' +
      memberLimits(data) +
      '<label class="field">Причина изменения<input name="reason" required minlength="3" maxlength="300" autocomplete="off"></label>' +
      '</fieldset><button class="primary" type="submit">Сохранить персональный доступ</button>' +
      '<p class="admin-voice-result" data-voice-result role="status" aria-live="polite"></p></form>'
    );
  }
  function history(items, revision) {
    if (!items.length) return '<p>Предыдущих настроек пока нет.</p>';
    return (
      '<form data-admin-voice-form="restore" data-admin-voice-draft data-revision="' +
      esc(revision) +
      '"><fieldset data-voice-fields><p>Восстанавливаются режим, команды, лимиты, ' +
      'провайдеры и ставки. Ключ, персональные разрешения и правила поведения сохраняются.</p>' +
      '<label class="field">Версия настроек<select name="revision" required><option value="">Выберите версию</option>' +
      items
        .map(
          (item) =>
            '<option value="' +
            esc(item.revision) +
            '">Версия ' +
            esc(item.revision) +
            ' · ' +
            esc(date(item.time)) +
            '</option>',
        )
        .join('') +
      '</select></label>' +
      '<label class="field">Причина восстановления<input name="reason" required minlength="3" maxlength="300" autocomplete="off"></label>' +
      '</fieldset><button type="submit" class="secondary">Восстановить настройки</button>' +
      '<p class="admin-voice-result" data-voice-result role="status" aria-live="polite"></p></form>'
    );
  }
  function audit(items) {
    if (!items.length) return '<p>Изменений политики пока нет.</p>';
    const events = {
      assistant_settings_changed: 'Изменены настройки помощника',
      assistant_membership_changed: 'Изменён персональный доступ',
      assistant_policy_restored: 'Восстановлены настройки помощника',
      assistant_behavior_approved: 'Утверждены правила поведения помощника',
      assistant_behavior_restored: 'Восстановлены правила поведения помощника',
    };
    return items
      .map((item) => {
        const detail = item.detail || {},
          parts = [];
        if (detail.reason) parts.push('Причина: ' + detail.reason);
        if (Number.isInteger(detail.revision)) parts.push('Версия: ' + detail.revision);
        if (detail.accountId) parts.push('Пользователь: ' + detail.accountId);
        if (typeof detail.enabled === 'boolean')
          parts.push(detail.enabled ? 'Доступ включён' : 'Доступ выключен');
        if (detail.mode)
          parts.push(detail.mode === 'off' ? 'Выключен для всех' : 'Только выбранным');
        if (Array.isArray(detail.fields)) parts.push('Поля: ' + detail.fields.join(', '));
        return (
          '<article class="admin-audit-item"><strong>' +
          esc(events[item.event] || item.event) +
          '</strong><p>' +
          esc(date(item.time)) +
          ' · Исполнитель: ' +
          esc(item.actorId || '—') +
          (item.organizationId ? ' · Организация: ' + esc(item.organizationId) : '') +
          '</p>' +
          (parts.length ? '<p>' + esc(parts.join(' · ')) + '</p>' : '') +
          '</article>'
        );
      })
      .join('');
  }
  return { settings, membership, history, audit, commands, limits, rates, providers };
}

function createAdminPaymentReviewView({ records }) {
  const { esc, date } = records;
  const money = createAdminBillingMoney();
  const statuses = {
    pending: 'Ожидается результат',
    blocked: 'Нужна настройка или ручная проверка',
    manual_review: 'Нужна ручная проверка',
    requested: 'Заявка на проверку',
    succeeded: 'Подтверждено',
    done: 'Проверено',
    canceled: 'Отменено',
    unknown: 'Результат уточняется',
    required: 'Нужна сверка',
    not_required: 'Сверка не требуется',
    checked: 'Проверено',
    review_required: 'Заявка на проверку',
    observed_succeeded: 'Подтверждён существующий возврат',
    not_requested: 'Заявок нет',
    not_checked: 'Не проверялся',
  };
  const actions = {
    reconcile: 'Сверить оплату с ЮKassa',
    retry_create: 'Повторить создание прежнего заказа',
    request_refund_review: 'Заявка на проверку возврата',
    request_receipt_review: 'Заявка на проверку закрывающего чека',
    check_refund: 'Проверить существующий возврат',
    check_receipt: 'Проверить существующий чек',
  };
  function state(label, value) {
    if (!value) return '';
    return (
      '<p><strong>' +
      label +
      ':</strong> ' +
      esc(statuses[value.status] || value.status || 'Нет сведений') +
      (value.checkedAt ? ' · ' + esc(date(value.checkedAt)) : '') +
      '</p>'
    );
  }
  function financialForm(item) {
    const rows = (item.financialActions || [])
      .map(
        (action) =>
          '<article><p>' +
          esc(action.kind === 'refund' ? 'Возврат' : 'Чек зачёта') +
          ' · ' +
          esc(statuses[action.status] || action.status) +
          ' · ' +
          esc(money.format(String(action.amountKopecks), 100n)) +
          '</p>' +
          (item.canManageFinance && !['succeeded', 'canceled', 'rejected'].includes(action.status)
            ? '<form class="admin-billing-form" data-admin-financial-check data-action-id="' +
              esc(action.id) +
              '"><fieldset><label class="field">ID существующего объекта, если результат неизвестен<input name="referenceId" maxlength="100"></label><label class="field">Причина привязки<input name="reason" minlength="3" maxlength="300"></label></fieldset><button type="submit" class="secondary">Проверить прежнюю операцию</button><p role="status" data-admin-billing-message></p></form>'
            : '') +
          '</article>',
      )
      .join('');
    if (!item.canManageFinance || item.status !== 'succeeded') return rows;
    return (
      rows +
      '<details><summary>Создать возврат или закрывающий чек</summary><form class="admin-billing-form" data-admin-financial-action data-checkout-id="' +
      esc(item.checkoutId || item.id) +
      '" data-revision="' +
      esc(item.revision) +
      '"><fieldset><label class="field">Операция<select name="kind"><option value="refund">Возврат оплаты</option><option value="receipt">Чек зачёта предоплаты</option></select></label>' +
      '<label class="field">Сумма возврата, ₽<input name="amountRub" type="number" min="0.01" step="0.01"></label>' +
      '<label class="field">При частичном возврате<select name="accessPolicy"><option value="keep">Сохранить доступ к этой услуге</option><option value="revoke">Прекратить доступ к этой услуге</option></select></label>' +
      '<p class="form-hint">При полном возврате доступ по этому заказу прекращается. Другие услуги сохраняются.</p><label class="field">Почта для чека<input name="receiptEmail" type="email" required maxlength="254"></label>' +
      '<label class="admin-check"><input type="checkbox" name="serviceProvided">Для чека зачёта подтверждаю оказание услуги по условиям договора</label>' +
      '<label class="field">Основание операции<input name="reason" required minlength="3" maxlength="300"></label>' +
      '</fieldset><button type="submit" class="secondary">Подтвердить операцию</button><p role="status" data-admin-billing-message></p></form></details>'
    );
  }
  function render(item) {
    const id = item.checkoutId || item.id;
    if (!id || !Number.isSafeInteger(item.revision)) return '';
    const choices = Object.entries(actions).filter(
      ([action]) => action !== 'retry_create' || item.canRetryCreate === true,
    );
    return (
      '<details class="admin-payment-review"><summary>Сверка, возврат и чек</summary>' +
      '<div class="admin-payment-review-state">' +
      '<p><strong>Чек оплаты:</strong> ' +
      esc(statuses[item.receiptRegistration] || 'Нет сведений') +
      '</p>' +
      state('Сверка оплаты', item.reconciliation) +
      state('Возврат', item.refund) +
      state('Закрывающий чек', item.closingReceipt) +
      (item.refund?.knownRefundedKopecks > 0
        ? '<p>Подтверждённые возвраты: ' +
          esc(money.format(String(item.refund.knownRefundedKopecks), 100n)) +
          '</p>'
        : '') +
      '<p class="form-hint">Заявки сохраняются для проверки администратором. Они не возвращают деньги и не создают чек.</p>' +
      (item.notice ? '<p class="form-hint">' + esc(item.notice) + '</p>' : '') +
      '</div>' +
      '<form class="admin-billing-form" data-admin-payment-review data-checkout-id="' +
      esc(id) +
      '" data-revision="' +
      esc(item.revision) +
      '"><fieldset><legend>Действие по заказу</legend>' +
      '<label class="field">Действие<select name="action">' +
      choices
        .map(([value, label]) => '<option value="' + value + '">' + label + '</option>')
        .join('') +
      '</select></label>' +
      '<label class="field">ID оплаты в ЮKassa, если он ещё не связан с заказом' +
      '<input name="paymentId" maxlength="100" autocomplete="off"></label>' +
      '<label class="field">ID существующего возврата или чека для проверки' +
      '<input name="referenceId" maxlength="100" autocomplete="off"></label>' +
      '<label class="field">Причина действия<input name="reason" required minlength="3" maxlength="300"></label>' +
      '</fieldset><button type="submit" class="secondary">Выполнить действие</button>' +
      '<p role="status" aria-live="polite" data-admin-billing-message></p></form>' +
      financialForm(item) +
      '</details>'
    );
  }
  function operation(form, common) {
    const values = new FormData(form),
      text = (name) => String(values.get(name) || '').trim(),
      action = text('action');
    if (!actions[action]) throw Error('Выберите действие по заказу.');
    if (['check_refund', 'check_receipt'].includes(action) && !text('referenceId'))
      throw Error('Укажите ID существующего возврата или чека.');
    return {
      route: '/api/admin/billing/payment-review',
      kind: 'review',
      body: {
        ...common,
        checkoutId: form.dataset.checkoutId,
        expectedRevision: Number(form.dataset.revision),
        action,
        ...(action === 'reconcile' && text('paymentId') ? { paymentId: text('paymentId') } : {}),
        ...(['check_refund', 'check_receipt'].includes(action)
          ? { referenceId: text('referenceId') }
          : {}),
      },
    };
  }
  return { render, operation };
}

function createAdminBillingSummaryView({ records }) {
  const { esc } = records;
  const money = createAdminBillingMoney();
  function uncertaintyHtml(summary = {}) {
    const items = [
      ['Неуточнённых обращений', summary.uncertainCalls],
      ['Незакрытых резервов', summary.pendingReservations],
    ].filter(([, count]) => Number.isSafeInteger(count) && count > 0);
    return items.length
      ? '<p class="admin-billing-uncertainty" role="status">Расходы ещё уточняются. ' +
          items.map(([label, count]) => label + ': ' + count).join('. ') +
          '.</p>'
      : '';
  }
  function render(data, { compact = false, organization = null } = {}) {
    if (!data?.available) return '<p>Пакеты пока недоступны.</p>';
    if (
      organization &&
      (data.scope?.type !== 'organization' || data.scope.organizationId !== organization.id)
    )
      return '<p role="status">Финансовые данные этого кабинета пока не загружены.</p>';
    const summary = data.summary || {},
      scope = data.scope?.type === 'organization' ? 'Кабинет: ' + data.scope.name : 'Вся платформа';
    return (
      '<p class="admin-billing-scope"><strong>' +
      esc(scope) +
      '</strong> · ' +
      esc(data.periodLabel || 'С начала учёта пакетов') +
      '</p><dl class="admin-billing-totals">' +
      [
        [
          'Подтверждённые оплаты пакетов',
          money.format(summary.paidRevenueKopecks, 100n, summary.paidRevenueRub),
        ],
        ...(summary.refundedKopecks !== undefined
          ? [
              ['Возвращено', money.format(summary.refundedKopecks, 100n)],
              ['После возвратов', money.format(summary.netPaidKopecks, 100n)],
            ]
          : []),
        [
          'Расчётные расходы',
          money.format(summary.providerCostMicrorub, 1000000n, summary.providerCostRub),
        ],
        ['После возвратов и расчётных расходов', money.difference(summary)],
        ['Действующих пакетов', summary.activePackages ?? '—'],
        ['Пробных выдач за период учёта', summary.trialGrants ?? '—'],
      ]
        .map(
          ([label, value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>',
        )
        .join('') +
      '</dl>' +
      uncertaintyHtml(summary) +
      (!compact && data.serviceTotals?.length
        ? '<div class="admin-table-scroll"><table><caption>Оплата по услугам</caption><thead><tr><th>Услуга</th><th>Подтверждено</th><th>Возвращено</th><th>После возвратов</th><th>Расходы</th></tr></thead><tbody>' +
          data.serviceTotals
            .map(
              (item) =>
                '<tr><th scope="row">' +
                esc(item.title) +
                '</th><td>' +
                esc(money.format(item.paidRevenueKopecks, 100n)) +
                '</td><td>' +
                esc(money.format(item.refundedKopecks, 100n)) +
                '</td><td>' +
                esc(money.format(item.netPaidKopecks, 100n)) +
                '</td><td>' +
                esc(
                  item.providerCostMicrorub === null
                    ? 'Нет учёта расходов'
                    : money.format(item.providerCostMicrorub, 1000000n),
                ) +
                '</td></tr>',
            )
            .join('') +
          '</tbody></table></div>'
        : '') +
      (compact
        ? ''
        : '<p class="form-hint">Показаны подтверждённые оплаты и учтённые возвраты. Расходы по платным и пробным пакетам с начала их учёта рассчитаны по использованию и ставкам. Разница не учитывает налоги и комиссии.</p>')
    );
  }
  return { render, uncertaintyHtml };
}

function createAdminBillingPagesView({ records, subscriptionHtml }) {
  const { esc, date } = records,
    review = createAdminPaymentReviewView({ records });
  const money = createAdminBillingMoney();
  function organizationRowsHtml(items) {
    return items
      .map(
        (item) =>
          '<article class="admin-billing-organization" data-billing-organization-id="' +
          esc(item.organizationId) +
          '"><h4>' +
          esc(item.organizationName) +
          '</h4>' +
          subscriptionHtml(item) +
          '<p>Подтверждённые оплаты: ' +
          esc(money.format(item.paidKopecks, 100n, item.paidRub)) +
          ' · Расчётные расходы: ' +
          esc(money.format(item.costMicrorub, 1000000n, item.costRub)) +
          '</p><button type="button" class="text-btn" data-admin-billing-organization="' +
          esc(item.organizationId) +
          '">Открыть услуги кабинета</button></article>',
      )
      .join('');
  }
  function organizations(data) {
    const items = data.organizations || [];
    return (
      '<section class="admin-billing-directory"><h4>Кабинеты</h4><p class="form-hint" data-billing-organization-count>Показано ' +
      items.length +
      (Number.isSafeInteger(data.organizationTotal) ? ' из ' + data.organizationTotal : '') +
      '</p><div class="admin-billing-organizations" data-billing-organization-list>' +
      (organizationRowsHtml(items) || '<p>Кабинеты пока не созданы.</p>') +
      '</div>' +
      '<p role="status" data-billing-organization-message></p><button type="button" class="secondary" data-billing-organization-more' +
      (data.nextOffset == null ? ' hidden' : '') +
      '>Показать ещё 20 кабинетов</button></section>'
    );
  }
  function orderRowsHtml(items) {
    return items
      .map(
        (item) =>
          '<li data-admin-order-id="' +
          esc(item.checkoutId || item.id) +
          '"><div><strong>' +
          esc(item.title || item.package?.title || 'Пакет') +
          '</strong><small>' +
          esc(item.package?.serviceTitle || '') +
          '</small><small>' +
          esc(date(item.time || item.createdAt)) +
          ' · ' +
          esc(
            {
              succeeded: item.testMode ? 'Тестовая оплата' : 'Оплачено',
              pending: 'Ожидаем оплату',
              creating: 'Создаётся',
              uncertain: 'Результат уточняется',
              review: 'Требует сверки',
              rejected: 'Не создано',
              canceled: 'Отменено',
              trial: 'Пробный доступ',
            }[item.status] ||
              item.status ||
              '',
          ) +
          '</small><small>Заказ: ' +
          esc(item.checkoutId || item.id) +
          '</small></div><span>' +
          esc(
            money.format(
              Number.isSafeInteger(item.priceKopecks ?? item.package?.priceKopecks)
                ? String(item.priceKopecks ?? item.package?.priceKopecks)
                : null,
              100n,
            ),
          ) +
          '</span>' +
          review.render(item) +
          '</li>',
      )
      .join('');
  }
  function orders(data) {
    const items = data.orders || [];
    return (
      '<section class="paid-package-orders"><h4>Заказы и оплаты</h4>' +
      '<form class="admin-billing-history-filter" data-billing-orders-filter><label class="field">Состояние<select name="status">' +
      [
        ['all', 'Все заказы'],
        ['attention', 'Требуют сверки'],
        ['pending', 'Ожидают результата'],
        ['paid', 'Оплата подтверждена'],
        ['canceled', 'Отменённые'],
        ['rejected', 'Не созданные'],
      ]
        .map(([value, label]) => '<option value="' + value + '">' + label + '</option>')
        .join('') +
      '</select></label>' +
      (data.services?.length > 1
        ? '<label class="field">Услуга<select name="serviceCode"><option value="">Все услуги</option>' +
          data.services
            .map(
              (service) =>
                '<option value="' + esc(service.code) + '">' + esc(service.title) + '</option>',
            )
            .join('') +
          '</select></label>'
        : '') +
      '<label class="field">ID заказа или оплаты<input name="q" type="search" maxlength="36" autocomplete="off" placeholder="Полный UUID" ' +
      'pattern="[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}" title="Введите полный идентификатор заказа или оплаты"></label>' +
      '<button type="submit" class="secondary">Найти</button><button type="button" class="text-btn" data-billing-orders-reset>Сбросить фильтры</button></form>' +
      '<p class="form-hint" data-billing-orders-count>Показано заказов: ' +
      items.length +
      '</p>' +
      '<p role="status" data-billing-orders-message></p><ol data-billing-orders-list>' +
      orderRowsHtml(items) +
      '</ol>' +
      '<p class="form-hint" data-billing-orders-empty' +
      (items.length ? ' hidden' : '') +
      '>По этим условиям заказов нет.</p>' +
      '<button type="button" class="secondary" data-billing-orders-more' +
      (data.ordersNextCursor ? '' : ' hidden') +
      '>Показать ещё 50 заказов</button></section>'
    );
  }
  return { organizationRowsHtml, organizations, orderRowsHtml, orders };
}

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

function createAdminVoiceMembers({ $, request, records, canLeave, onSelect }) {
  const organizations = new Map(),
    memberships = new Map();
  let visibleOrganizations = [],
    next = null,
    query = '',
    searchGeneration = 0,
    organizationGeneration = 0;
  let committed = { organizationId: '', accountId: '' };
  const target = () => ({
    organizationId: $('#admin-voice-organization').value,
    accountId: $('#admin-voice-account').value,
  });
  const key = (item) => item.organizationId + '|' + item.accountId;
  const identity = () => memberships.get(key(target()));
  function options(items, placeholder) {
    return (
      '<option value="">' +
      records.esc(placeholder) +
      '</option>' +
      items
        .map(
          ([value, label]) =>
            '<option value="' + records.esc(value) + '">' + records.esc(label) + '</option>',
        )
        .join('')
    );
  }
  function renderOrganizations(organizationId = '') {
    const ids = [...visibleOrganizations];
    if (organizationId && organizations.has(organizationId) && !ids.includes(organizationId))
      ids.unshift(organizationId);
    $('#admin-voice-organization').innerHTML = options(
      ids.map((id) => [id, organizations.get(id)]),
      'Выберите организацию',
    );
    if (organizations.has(organizationId)) $('#admin-voice-organization').value = organizationId;
  }
  function renderMembers(accountId = '') {
    const organizationId = $('#admin-voice-organization').value;
    const members = [...memberships.values()].filter(
      (item) => item.organizationId === organizationId,
    );
    $('#admin-voice-account').innerHTML = options(
      members.map((item) => [
        item.accountId,
        item.displayName +
          ' · ' +
          (records.roles[item.role] || item.role) +
          (item.status === 'active' ? '' : ' · доступ приостановлен'),
      ]),
      'Выберите пользователя',
    );
    $('#admin-voice-account').disabled = !organizationId;
    if (members.some((item) => item.accountId === accountId))
      $('#admin-voice-account').value = accountId;
  }
  function seed(items, truncated) {
    const selected = target();
    for (const item of items || []) {
      organizations.set(item.organizationId, item.organizationName);
      memberships.set(key(item), item);
    }
    if (!visibleOrganizations.length) visibleOrganizations = [...organizations.keys()];
    renderOrganizations(selected.organizationId);
    renderMembers(selected.accountId);
    committed = target();
    $('#admin-voice-search-status').textContent = truncated
      ? 'Чтобы найти другую организацию, используйте поиск по названию, городу или владельцу.'
      : '';
  }
  async function search(more = false) {
    const serial = ++searchGeneration;
    if (!more) {
      query = $('#admin-voice-org-search').value.trim();
      next = null;
      $('#admin-voice-org-more').hidden = true;
    }
    const parameters = { q: query };
    if (more && next) parameters.cursor = next;
    $('#admin-voice-org-more').disabled = true;
    $('#admin-voice-search-status').textContent = 'Ищем организации…';
    try {
      const data = await request('/api/admin/organizations?' + new URLSearchParams(parameters));
      if (serial !== searchGeneration) return;
      const selected = target();
      if (!more) visibleOrganizations = [];
      for (const item of data.items) {
        organizations.set(item.id, item.name);
        if (!visibleOrganizations.includes(item.id)) visibleOrganizations.push(item.id);
      }
      next = data.nextCursor || null;
      renderOrganizations(selected.organizationId);
      $('#admin-voice-org-more').hidden = !next;
      $('#admin-voice-search-status').textContent =
        'Найдено: ' + data.total + '. В списке показано: ' + visibleOrganizations.length + '.';
    } catch (error) {
      if (serial === searchGeneration) $('#admin-voice-search-status').textContent = error.message;
    } finally {
      if (serial === searchGeneration) $('#admin-voice-org-more').disabled = false;
    }
  }
  async function refresh() {
    const selected = target(),
      serial = ++organizationGeneration;
    if (!selected.organizationId) {
      await onSelect();
      return;
    }
    $('#admin-voice-account').disabled = true;
    $('#admin-voice-search-status').textContent = 'Загружаем пользователей организации…';
    try {
      const data = await request(
        '/api/admin/organization?id=' + encodeURIComponent(selected.organizationId),
      );
      if (serial !== organizationGeneration || target().organizationId !== selected.organizationId)
        return;
      organizations.set(data.id, data.name);
      for (const [id, item] of memberships)
        if (item.organizationId === selected.organizationId) memberships.delete(id);
      for (const item of data.members) {
        const member = { ...item, organizationId: data.id, organizationName: data.name };
        memberships.set(key(member), member);
      }
      renderMembers(selected.accountId);
      committed = target();
      $('#admin-voice-search-status').textContent = 'Выберите пользователя выбранной организации.';
      await onSelect();
    } catch (error) {
      if (serial === organizationGeneration) {
        $('#admin-voice-account').innerHTML = options([], 'Не удалось загрузить пользователей');
        committed = target();
        $('#admin-voice-search-status').textContent = error.message;
        await onSelect();
      }
    }
  }
  function restoreSelection() {
    renderOrganizations(committed.organizationId);
    renderMembers(committed.accountId);
  }
  function bind() {
    $('#admin-voice-org-search-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void search();
    });
    $('#admin-voice-org-more').addEventListener('click', () => {
      void search(true);
    });
    $('#admin-voice-organization').addEventListener('change', () => {
      if (!canLeave()) {
        restoreSelection();
        return;
      }
      $('#admin-voice-account').innerHTML = options([], 'Загружаем пользователей…');
      $('#admin-voice-account').disabled = true;
      committed = target();
      void onSelect();
      void refresh();
    });
    $('#admin-voice-account').addEventListener('change', () => {
      if (!canLeave()) {
        restoreSelection();
        return;
      }
      committed = target();
      void onSelect();
    });
  }
  return { seed, target, identity, refresh, bind };
}

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

function createAdminVoiceBehaviorEditor({ root, view, requestId, onChange, status }) {
  let examples = [],
    limits = null,
    editing = null;
  const importedSources = new Map();
  const find = (selector) => root.querySelector(selector);
  const form = () => find('[data-behavior-rules]');
  const selection = () => form()?.elements.exampleSelection?.value || 'manual';
  function list() {
    const automatic = selection() === 'automatic',
      count = examples.filter((item) => item.enabled).length;
    find('[data-behavior-examples]').innerHTML = view.examples(examples, selection());
    find('[data-behavior-count]').textContent = automatic
      ? count +
        ' доступных пользовательских кандидатов из ' +
        examples.length +
        '; до ' +
        limits.maxEnabledExamples +
        ' примеров на один запрос, вместе со встроенным каталогом.'
      : examples.length + ' примеров, включено ' + count + ' из ' + limits.maxEnabledExamples + '.';
    find('[data-behavior-add]').disabled = examples.length >= limits.maxExamples;
  }
  function render(data) {
    limits = data.limits;
    examples = data.rules.examples.map((item) => ({ ...item, expected: { ...item.expected } }));
    editing = null;
    root.innerHTML = view.rules(data);
    find('[data-behavior-provider]').textContent = view.provider(data);
    list();
  }
  function change() {
    form().dataset.dirty = '1';
    onChange();
  }
  function cancelExample() {
    editing = null;
    find('[data-behavior-example-editor]').textContent = '';
  }
  function syncIntent() {
    const editor = find('[data-behavior-example]');
    if (!editor) return;
    const allowed = view.applicable[editor.elements.intent.value];
    editor.querySelectorAll('[data-behavior-output]').forEach((node) => {
      node.hidden = !allowed.includes(node.dataset.behaviorOutput);
      node.querySelector('input,select').disabled = node.hidden;
    });
  }
  function openExample(value) {
    if (
      find('[data-behavior-example][data-dirty]') &&
      !confirm('Отменить несохранённое редактирование примера?')
    )
      return;
    editing = value.id || '';
    find('[data-behavior-example-editor]').innerHTML = view.exampleForm(value, limits, selection());
    syncIntent();
    find('[data-behavior-example] textarea').focus();
  }
  function allowedEnabled(item, replacedId = null) {
    const maximum =
      selection() === 'automatic'
        ? limits.maxCandidateExamples || limits.maxExamples
        : limits.maxEnabledExamples;
    if (
      item.enabled &&
      examples.filter((value) => value.enabled && value.id !== replacedId).length >= maximum
    )
      throw Error(
        selection() === 'automatic'
          ? 'В автоматический отбор можно включить не более ' +
              maximum +
              ' пользовательских примеров.'
          : 'В запросы к модели можно включить не более ' + maximum + ' примеров.',
      );
  }
  function saveExample(editor) {
    if (!editor.reportValidity()) return;
    const values = new FormData(editor),
      expected = { intent: values.get('intent') };
    for (const key of view.applicable[expected.intent]) {
      const value = String(values.get(key) || '').trim();
      if (value) expected[key] = key === 'duration' ? Number(value) : value;
    }
    const item = {
      id: editing || requestId(),
      text: values.get('text').trim(),
      referenceDate: values.get('referenceDate'),
      referenceTime: values.get('referenceTime'),
      enabled: values.has('enabled'),
      expected,
    };
    if (!item.text) throw Error('Введите непустую фразу пользователя.');
    allowedEnabled(item, editing);
    if (editing) examples = examples.map((value) => (value.id === editing ? item : value));
    else {
      if (examples.length >= limits.maxExamples)
        throw Error('Достигнуто максимальное число примеров.');
      examples.push(item);
    }
    cancelExample();
    list();
    change();
    status('Пример изменён только в локальном черновике.');
  }
  function click(event) {
    if (!form() || form().querySelector('fieldset').disabled) return;
    const button = event.target.closest(
      '[data-behavior-add],[data-behavior-edit],[data-behavior-remove],[data-behavior-cancel-example]',
    );
    if (!button) return;
    if (button.hasAttribute('data-behavior-add')) {
      if (examples.length >= limits.maxExamples) return;
      const now = new Date();
      openExample({
        referenceDate:
          now.getFullYear() +
          '-' +
          String(now.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(now.getDate()).padStart(2, '0'),
        referenceTime:
          String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
        enabled: false,
      });
    } else if (button.hasAttribute('data-behavior-edit')) {
      const item = examples.find((value) => value.id === button.dataset.behaviorEdit);
      if (item) openExample(item);
    } else if (button.hasAttribute('data-behavior-remove')) {
      const id = button.dataset.behaviorRemove;
      if (editing === id) cancelExample();
      examples = examples.filter((value) => value.id !== id);
      list();
      change();
    } else cancelExample();
  }
  function importCases(items) {
    if (find('[data-behavior-example]'))
      throw Error(
        'Примените к черновику или отмените редактируемый пример перед добавлением из библиотеки.',
      );
    const signature = (value) =>
      JSON.stringify([
        value.text.trim(),
        value.referenceDate,
        value.referenceTime,
        Object.entries(value.expected).sort(([left], [right]) => left.localeCompare(right)),
      ]);
    const known = new Map(examples.map((item) => [signature(item), item.id]));
    const additions = [],
      sources = [];
    for (const item of items) {
      const context = item.context || item;
      if (
        !(
          ['supported', 'manual'].includes(item.current?.status) ||
          (item.current?.status === 'needs_clarification' &&
            item.current?.intent?.intent === 'prepareAppointment')
        ) ||
        !Object.hasOwn(view.intents, item.current?.intent?.intent)
      )
        throw Error('Этот справочный сценарий пока нельзя использовать как действующее действие.');
      const value = {
        id: '',
        text: item.text.trim(),
        referenceDate: context.referenceDate,
        referenceTime: context.referenceTime,
        enabled: false,
        expected: { ...item.current.intent },
      };
      const sourceId = importedSources.get(item.id);
      const existing =
        sourceId && examples.some((entry) => entry.id === sourceId)
          ? sourceId
          : known.get(signature(value));
      if (existing) {
        sources.push([item.id, existing]);
        continue;
      }
      value.id = requestId();
      known.set(signature(value), value.id);
      sources.push([item.id, value.id]);
      additions.push(value);
    }
    if (examples.length + additions.length > limits.maxExamples)
      throw Error(
        'В черновике осталось мест: ' +
          (limits.maxExamples - examples.length) +
          '. Выберите меньше примеров или удалите ненужные; пакет не добавлен.',
      );
    for (const [sourceId, exampleId] of sources) importedSources.set(sourceId, exampleId);
    if (additions.length) {
      examples.push(...additions);
      list();
      change();
    }
    return { added: additions.length, existing: items.length - additions.length };
  }
  function bind() {
    root.addEventListener('click', click);
    root.addEventListener('submit', (event) => {
      const editor = event.target.closest('[data-behavior-example]');
      if (!editor) return;
      event.preventDefault();
      try {
        saveExample(editor);
      } catch (error) {
        status(error.message, true);
      }
    });
    root.addEventListener('input', (event) => {
      const target = event.target.closest('[data-behavior-rules],[data-behavior-example]');
      if (target) {
        target.dataset.dirty = '1';
        onChange();
      }
    });
    root.addEventListener('change', (event) => {
      const target = event.target.closest('[data-behavior-rules],[data-behavior-example]');
      if (!target) return;
      target.dataset.dirty = '1';
      onChange();
      if (event.target.name === 'intent') syncIntent();
      if (event.target.name === 'exampleSelection') {
        list();
        const label = find('[data-behavior-enabled-label]');
        if (label) label.textContent = view.enabledLabel(selection());
      }
      if (event.target.hasAttribute('data-behavior-enabled')) {
        const item = examples.find((value) => value.id === event.target.dataset.behaviorEnabled);
        if (!item) return;
        try {
          allowedEnabled({ enabled: event.target.checked }, item.id);
          item.enabled = event.target.checked;
        } catch (error) {
          event.target.checked = item.enabled;
          status(error.message, true);
        }
        list();
      }
    });
  }
  function rules() {
    if (find('[data-behavior-example]'))
      throw Error('Примените к черновику или отмените редактируемый пример.');
    const values = new FormData(form());
    if (
      selection() === 'manual' &&
      examples.filter((item) => item.enabled).length > limits.maxEnabledExamples
    )
      throw Error(
        'Для фиксированного набора оставьте не более ' +
          limits.maxEnabledExamples +
          ' включённых примеров. Черновик сохранён.',
      );
    return {
      exampleSelection: selection(),
      instructions: values.get('instructions'),
      dictionary: values.get('dictionary'),
      examples: examples.map((item) => ({ ...item, expected: { ...item.expected } })),
    };
  }
  return { render, bind, rules, importCases };
}

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

function createAdminVoiceBehaviorLibrary({
  root,
  request,
  records,
  behaviorView,
  addCases,
  canEdit,
  onDenied,
}) {
  const view = createAdminVoiceBehaviorLibraryView({ records, behaviorView });
  const route = '/api/admin/voice-assistant/behavior/library';
  let snapshot = null,
    generation = 0,
    busy = false,
    initialized = false;
  const find = (selector) => root.querySelector(selector);
  function status(text, error = false) {
    const node = find('[data-library-status]');
    if (!node) return;
    node.textContent = text;
    node.dataset.status = error ? 'error' : 'success';
  }
  function available() {
    if (!initialized) {
      root.innerHTML = view.shell();
      initialized = true;
    }
  }
  function clear() {
    generation++;
    busy = false;
    initialized = false;
    snapshot = null;
    root.textContent = '';
  }
  function lock(value) {
    root.querySelectorAll('button,input,select').forEach((item) => {
      item.disabled = value;
    });
    if (!value && snapshot) {
      find('[data-library-previous]').disabled = snapshot.offset <= 0;
      find('[data-library-next]').disabled =
        snapshot.offset + snapshot.cases.length >= snapshot.total;
    }
  }
  function filters(offset = 0) {
    const values = new FormData(find('[data-library-filter]'));
    const query = new URLSearchParams({ offset: String(offset), limit: '20' });
    for (const key of ['q', 'category', 'status']) {
      const value = String(values.get(key) || '').trim();
      if (value) query.set(key, value);
    }
    return query;
  }
  function render(data) {
    snapshot = data;
    const form = find('[data-library-filter]');
    form.elements.category.innerHTML = view.options(
      data.categories,
      form.elements.category.value,
      'Все темы',
    );
    form.elements.status.innerHTML = view.options(
      data.statuses,
      form.elements.status.value,
      'Все варианты',
    );
    find('[data-library-packs]').innerHTML = view.packs(data.packs || []);
    find('[data-library-coverage]').innerHTML = view.coverage(data.coverage);
    find('[data-library-cases]').innerHTML = view.cases(data.cases);
    find('[data-library-page]').textContent = data.total
      ? data.offset + 1 + '–' + (data.offset + data.cases.length) + ' из ' + data.total
      : '0 сценариев';
  }
  async function load(offset = 0) {
    if (busy || !initialized) return;
    const serial = ++generation;
    busy = true;
    const query = filters(offset);
    lock(true);
    status('Загружаем библиотеку сценариев…');
    try {
      const data = await request(route + '?' + query);
      if (serial !== generation || !initialized) return;
      render(data);
      status('Библиотека описывает возможности и ограничения кода. Модель и тесты не запускались.');
    } catch (error) {
      if (serial === generation && !onDenied(error)) status(error.message, true);
    } finally {
      if (serial === generation) {
        busy = false;
        lock(false);
      }
    }
  }
  function importCases(items) {
    if (!canEdit()) throw Error('Дождитесь завершения текущей операции с правилами.');
    if (items.some((item) => !view.importable(item)))
      throw Error('Пакет содержит сценарии, которые нельзя перенести в действующие примеры.');
    const result = addCases(items);
    status(
      result.added
        ? 'В черновик добавлено ' +
            result.added +
            ' примеров, все выключены. Проверьте их, выберите нужные и просмотрите изменения.'
        : 'Эти примеры уже есть в черновике.',
    );
  }
  async function addPack(id) {
    if (busy || !canEdit()) return;
    const serial = ++generation;
    busy = true;
    lock(true);
    status('Загружаем выбранный пакет в черновик…');
    try {
      const query = new URLSearchParams({ pack: id, limit: '40' });
      const data = await request(route + '?' + query);
      if (serial !== generation || !initialized) return;
      if (data.total !== data.cases.length)
        throw Error('Пакет слишком велик для одного добавления. Выберите отдельные примеры.');
      importCases(data.cases);
    } catch (error) {
      if (serial === generation && !onDenied(error)) status(error.message, true);
    } finally {
      if (serial === generation) {
        busy = false;
        lock(false);
      }
    }
  }
  root.addEventListener(
    'toggle',
    (event) => {
      if (event.target.matches('[data-library-panel]') && event.target.open && !snapshot)
        void load();
    },
    true,
  );
  root.addEventListener('submit', (event) => {
    if (!event.target.matches('[data-library-filter]')) return;
    event.preventDefault();
    void load();
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    if (button.hasAttribute('data-library-previous'))
      void load(Math.max(0, snapshot.offset - snapshot.limit));
    else if (button.hasAttribute('data-library-next')) void load(snapshot.offset + snapshot.limit);
    else if (button.hasAttribute('data-library-pack')) void addPack(button.dataset.libraryPack);
    else if (button.hasAttribute('data-library-import')) {
      const item = snapshot?.cases.find((value) => value.id === button.dataset.libraryImport);
      if (!item) return;
      try {
        importCases([item]);
      } catch (error) {
        status(error.message, true);
      }
    }
  });
  return { available, clear };
}

function createAdminVoiceBehavior({ root, request, records, requestId, onCommitted }) {
  if (!root) return { load: async () => {}, refresh: async () => {}, bind() {} };
  root.innerHTML =
    '<p data-behavior-status role="status" aria-live="polite"></p><div data-behavior-body></div><div data-behavior-library></div>';
  const body = root.querySelector('[data-behavior-body]');
  const view = createAdminVoiceBehaviorView({ records });
  const diff = createAdminVoiceBehaviorDiff({ records });
  const route = '/api/admin/voice-assistant/behavior';
  const identity = () => document.querySelector('#admin-identity')?.textContent || '';
  let snapshot = null,
    reviewed = null,
    pending = null,
    busy = false,
    bound = false,
    revoked = false;
  let generation = 0,
    previewGeneration = 0,
    compareGeneration = 0,
    editGeneration = 0;
  let knownIdentity = identity();
  const disabled = new Map();
  const node = (selector) => root.querySelector(selector);
  function status(text, error = false) {
    const area = node('[data-behavior-status]');
    area.textContent = text;
    area.dataset.status = error ? 'error' : 'success';
  }
  const hasDraft = () => Boolean(root.querySelector('[data-admin-voice-draft][data-dirty]'));
  function lock(value) {
    if (value)
      root.querySelectorAll('button,input,select,textarea').forEach((item) => {
        if (!disabled.has(item)) disabled.set(item, item.disabled);
        item.disabled = true;
      });
    else {
      for (const [item, previous] of disabled) if (item.isConnected) item.disabled = previous;
      disabled.clear();
    }
  }
  function invalidateReview() {
    editGeneration++;
    previewGeneration++;
    reviewed = null;
    const area = node('[data-behavior-review]');
    if (area)
      area.textContent = 'Черновик изменён. Повторите предварительный просмотр перед утверждением.';
  }
  const editor = createAdminVoiceBehaviorEditor({
    root: body,
    view,
    requestId,
    onChange: invalidateReview,
    status,
  });
  const library = createAdminVoiceBehaviorLibrary({
    root: node('[data-behavior-library]'),
    request,
    records,
    behaviorView: view,
    addCases: editor.importCases,
    canEdit: () => Boolean(snapshot) && !busy && !pending && !revoked,
    onDenied: denied,
  });
  function revoke() {
    generation++;
    previewGeneration++;
    compareGeneration++;
    snapshot = reviewed = pending = null;
    busy = false;
    revoked = true;
    disabled.clear();
    body.textContent = '';
    library.clear();
    status('Доступ или сессия изменились. Откройте раздел заново после входа.', true);
  }
  function active(serial, key) {
    if (identity() !== key) {
      revoke();
      return false;
    }
    return serial === generation && !revoked;
  }
  function denied(error) {
    if ([401, 403].includes(error.status)) {
      revoke();
      return true;
    }
    return false;
  }
  function apply(data, preserveDraft = false) {
    snapshot = data;
    library.available();
    reviewed = null;
    previewGeneration++;
    if (!preserveDraft || !node('[data-behavior-rules]')) editor.render(data);
    else {
      node('[data-behavior-provider]').textContent = view.provider(data);
      node('[data-behavior-review]').textContent =
        'Текущая версия перечитана. Черновик сохранён; повторите просмотр изменений.';
    }
    node('[data-behavior-versions]').innerHTML = view.versions(data);
  }
  async function load({ preserveDraft = false, discard = false } = {}) {
    if (busy || pending) return;
    if (
      hasDraft() &&
      !preserveDraft &&
      !discard &&
      !confirm('Заменить несохранённый черновик поведения текущей версией сервера?')
    )
      return;
    const serial = ++generation,
      key = identity(),
      edits = editGeneration;
    knownIdentity = key;
    revoked = false;
    busy = true;
    status('Загружаем правила поведения…');
    lock(true);
    try {
      const data = await request(route);
      if (!active(serial, key)) return;
      apply(data, preserveDraft || edits !== editGeneration);
      status(
        'Текущая версия поведения: ' +
          data.version +
          '. Изменения в редакторе сохраняются только после утверждения.',
      );
    } catch (error) {
      if (active(serial, key) && !denied(error)) status(error.message, true);
    } finally {
      if (serial === generation) {
        busy = false;
        lock(false);
      }
    }
  }
  async function refresh() {
    await load({ preserveDraft: hasDraft() || Boolean(node('[data-behavior-example]')) });
  }
  async function preview(sourceVersion = null) {
    if (busy || pending || !snapshot) return;
    let payload;
    try {
      payload = {
        expectedRevision: snapshot.revision,
        ...(sourceVersion === null ? { rules: editor.rules() } : { sourceVersion }),
      };
    } catch (error) {
      status(error.message, true);
      return;
    }
    const serial = generation,
      previewSerial = ++previewGeneration,
      key = identity();
    reviewed = null;
    busy = true;
    lock(true);
    node('[data-behavior-review]').textContent = '';
    status('Проверяем черновик и готовим сравнение…');
    try {
      const data = await request(route + '/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!active(serial, key) || previewSerial !== previewGeneration) return;
      reviewed = data;
      node('[data-behavior-review]').innerHTML = diff.review(data);
      status('Просмотрите изменения, укажите причину и подтвердите применение.');
    } catch (error) {
      if (active(serial, key) && !denied(error))
        status(
          error.status === 409
            ? 'Версия уже изменилась. Черновик сохранён: перечитайте версии, затем повторите просмотр.'
            : error.message,
          true,
        );
    } finally {
      if (serial === generation) {
        busy = false;
        lock(false);
      }
    }
  }
  async function approve(form) {
    if (busy || (!pending && !reviewed)) return;
    if (!pending && !form.reportValidity()) return;
    let operation = pending;
    if (!operation) {
      const values = new FormData(form),
        reason = String(values.get('reason') || '').trim();
      if (reason.length < 3 || reason.length > 300 || !values.has('confirmed')) {
        status(
          'Просмотрите изменения, подтвердите их и укажите причину от 3 до 300 символов.',
          true,
        );
        return;
      }
      const restore = reviewed.sourceVersion !== null;
      const payload = {
        expectedRevision: reviewed.revision,
        requestId: requestId(),
        reason,
        ...(restore ? { sourceVersion: reviewed.sourceVersion } : { rules: reviewed.rules }),
        reviewHash: reviewed.reviewHash,
        confirmed: true,
      };
      operation = {
        route: route + (restore ? '/restore' : '/approve'),
        body: JSON.stringify(payload),
      };
    }
    const serial = generation,
      key = identity(),
      button = form.querySelector('[type="submit"]');
    pending = operation;
    busy = true;
    lock(true);
    status('Утверждаем изменения…');
    try {
      const data = await request(operation.route, { method: 'POST', body: operation.body });
      if (!active(serial, key)) return;
      pending = null;
      apply(data);
      status(
        'Версия ' +
          data.version +
          ' утверждена. Правила применяются к следующим запросам реальной модели.',
      );
      await onCommitted?.();
    } catch (error) {
      if (!active(serial, key) || denied(error)) return;
      if (error.unknown || error.outcomeUnknown) {
        status(
          'Ответ не получен. Повторите утверждение: будет отправлена та же команда с тем же идентификатором.',
          true,
        );
        button.textContent = 'Повторить утверждение';
      } else {
        pending = null;
        if (error.status === 409) {
          reviewed = null;
          node('[data-behavior-review]').textContent =
            'Версия изменилась. Черновик сохранён. Перечитайте версии и снова просмотрите изменения.';
        }
        status(error.message, true);
      }
    } finally {
      if (serial === generation) {
        busy = false;
        if (pending) button.disabled = false;
        else lock(false);
      }
    }
  }
  async function compare(form) {
    if (busy || pending || !snapshot) return;
    const values = new FormData(form),
      serial = generation,
      key = identity();
    const compareSerial = ++compareGeneration;
    const query = new URLSearchParams({
      fromVersion: values.get('fromVersion'),
      toVersion: values.get('toVersion'),
    });
    const area = node('[data-behavior-comparison]');
    area.textContent = 'Загружаем сравнение…';
    try {
      const data = await request(route + '/compare?' + query);
      if (!active(serial, key) || compareSerial !== compareGeneration) return;
      area.innerHTML =
        '<h4>Сравнение версий ' +
        records.esc(data.fromVersion) +
        ' → ' +
        records.esc(data.toVersion) +
        '</h4>' +
        diff.render(data.changes);
    } catch (error) {
      if (active(serial, key) && compareSerial === compareGeneration && !denied(error))
        area.textContent = error.message;
    }
  }
  function bind() {
    if (bound) return;
    bound = true;
    editor.bind();
    root.addEventListener('submit', (event) => {
      const form = event.target.closest('form');
      if (!form || !root.contains(form)) return;
      if (form.hasAttribute('data-behavior-rules')) {
        event.preventDefault();
        void preview();
      }
      if (form.hasAttribute('data-behavior-approve')) {
        event.preventDefault();
        void approve(form);
      }
      if (form.hasAttribute('data-behavior-compare')) {
        event.preventDefault();
        void compare(form);
      }
      if (form.hasAttribute('data-behavior-restore')) {
        event.preventDefault();
        if (form.reportValidity()) void preview(Number(new FormData(form).get('sourceVersion')));
      }
    });
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-behavior-reload]')) void load();
      if (event.target.closest('[data-behavior-rebase]')) void load({ preserveDraft: true });
    });
    for (const type of ['input', 'change'])
      root.addEventListener(type, (event) => {
        const form = event.target.closest('[data-admin-voice-draft]');
        if (form) form.dataset.dirty = '1';
        if (type === 'change' && event.target.closest('[data-behavior-restore]'))
          invalidateReview();
      });
    window.addEventListener('beforeunload', (event) => {
      if (!hasDraft()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    const identityNode = document.querySelector('#admin-identity');
    if (identityNode)
      new window.MutationObserver(() => {
        if (knownIdentity !== identity()) {
          knownIdentity = identity();
          revoke();
        }
      }).observe(identityNode, { childList: true, subtree: true, characterData: true });
  }
  return { load, refresh, bind };
}

function createAdminVoice({ $, request, records, message }) {
  const view = createAdminVoiceView({ records }),
    pending = new WeakMap();
  const root = $('#admin-voice-assistant');
  let snapshot = null,
    member = null,
    identity = null,
    generation = 0,
    memberGeneration = 0;
  const result = (form, text, error = false) => {
    const node = form.querySelector('[data-voice-result]');
    node.textContent = text;
    node.dataset.status = error ? 'error' : 'success';
  };
  const dirty = (form) => Boolean(form?.dataset.dirty);
  const currentForm = (kind) => root.querySelector('[data-admin-voice-form="' + kind + '"]');
  const picker = createAdminVoiceMembers({
    $,
    request,
    records,
    canLeave: discardMember,
    onSelect: () => loadMember(),
  });
  const selected = () => picker.target();
  const behavior = createAdminVoiceBehavior({
    root: $('#admin-voice-behavior'),
    request,
    records,
    requestId: id,
    onCommitted: () => refreshAfterSave('behavior'),
  });
  function id() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const value = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    return [
      value.slice(0, 8),
      value.slice(8, 12),
      value.slice(12, 16),
      value.slice(16, 20),
      value.slice(20),
    ].join('-');
  }
  function applySnapshot(data, replaceSettings = true) {
    snapshot = data;
    if (replaceSettings) $('#admin-voice-settings').innerHTML = view.settings(data);
    if (!dirty(currentForm('restore')))
      $('#admin-voice-history').innerHTML = view.history(data.history || [], data.revision);
    picker.seed(data.memberships, data.membershipsTruncated);
    if (!$('#admin-voice-account').value) {
      memberGeneration++;
      member = null;
      identity = null;
      $('#admin-voice-member').textContent = 'Выберите организацию и пользователя.';
    }
  }
  async function loadAudit() {
    const serial = generation;
    try {
      const data = await request('/api/admin/voice-assistant/audit');
      if (serial === generation) $('#admin-voice-audit').innerHTML = view.audit(data.items || []);
    } catch (error) {
      if (serial === generation) $('#admin-voice-audit').textContent = error.message;
    }
  }
  async function load({ discard = false } = {}) {
    if (
      !discard &&
      root.querySelector('[data-admin-voice-draft][data-dirty]') &&
      !confirm('Перечитать настройки без сохранения введённых изменений?')
    )
      return;
    const serial = ++generation;
    $('#admin-voice-loading').textContent = 'Загружаем настройки помощника…';
    root.setAttribute('aria-busy', 'true');
    try {
      const data = await request('/api/admin/voice-assistant');
      if (serial !== generation) return;
      view.providers.reset();
      applySnapshot(data);
      $('#admin-voice-loading').textContent = '';
      void behavior.load({ discard: true });
      const target = selected();
      if (target.organizationId) await picker.refresh();
      void loadAudit();
    } catch (error) {
      if (serial === generation) $('#admin-voice-loading').textContent = error.message;
    } finally {
      if (serial === generation) root.removeAttribute('aria-busy');
    }
  }
  async function loadMember() {
    const serial = ++memberGeneration,
      target = selected();
    member = null;
    identity = picker.identity();
    const area = $('#admin-voice-member');
    area.textContent = identity
      ? 'Загружаем персональный доступ…'
      : 'Выберите организацию и пользователя.';
    if (!identity) return;
    const expectedIdentity = identity;
    try {
      const data = await request(
        '/api/admin/voice-assistant/member?' + new URLSearchParams(target),
      );
      if (serial !== memberGeneration || identity !== expectedIdentity) return;
      member = data;
      area.innerHTML = view.membership(data, identity);
    } catch (error) {
      if (serial === memberGeneration) area.textContent = error.message;
    }
  }
  function settingsPayload(form) {
    const values = new FormData(form),
      policy = {
        mode: values.get('mode'),
        commands: {},
        limits: {},
      };
    for (const key of Object.keys(view.commands))
      policy.commands[key] = values.has('command.' + key);
    for (const key of Object.keys(view.limits))
      policy.limits[key] = Number(values.get('limit.' + key));
    const providers = {};
    for (const stage of ['stt', 'llm', 'tts']) {
      providers[stage] = {
        provider: values.get('provider.' + stage),
        model: values
          .get(
            stage === 'llm' && values.get('provider.llm') === 'codex'
              ? 'model.codex'
              : 'model.' + stage,
          )
          .trim(),
      };
      if (stage === 'tts') providers[stage].voice = values.get('voice.tts').trim();
    }
    const rates = Object.fromEntries(
      Object.keys(view.rates).map((key) => [key, Number(values.get('rate.' + key))]),
    );
    const body = { policy, providers, rates },
      key = values.get('timewebApiKey').trim();
    if (key && values.has('removeTimewebKey'))
      throw Error('Введите новый ключ или выберите удаление ключа.');
    if (key) body.timewebApiKey = key;
    else if (values.has('removeTimewebKey')) body.timewebApiKey = null;
    return body;
  }
  function memberPayload(values) {
    const limits = {};
    for (const key of Object.keys(view.limits)) {
      if (key === 'monthlyBudgetRub') continue;
      const value = values.get('memberLimit.' + key);
      if (value !== null && value.trim() !== '') limits[key] = Number(value);
    }
    return {
      ...selected(),
      enabled: values.has('enabled'),
      limits: Object.keys(limits).length ? limits : null,
    };
  }
  async function refreshAfterSave(kind, form) {
    const serial = ++generation;
    try {
      const data = await request('/api/admin/voice-assistant');
      if (serial !== generation) return;
      applySnapshot(
        data,
        kind === 'settings' || kind === 'restore' || !dirty(currentForm('settings')),
      );
      if (!dirty(currentForm('member'))) await loadMember();
      void loadAudit();
      if (kind !== 'behavior') await behavior.refresh();
    } catch {
      if (form)
        result(
          form,
          'Изменения сохранены. Перечитайте настройки, чтобы увидеть актуальное состояние.',
        );
    }
  }
  async function submit(form) {
    if (form.dataset.busy) return;
    const kind = form.dataset.adminVoiceForm;
    let operation = pending.get(form);
    if (!operation && !form.reportValidity()) return;
    try {
      if (!operation) {
        const values = new FormData(form);
        const body =
          kind === 'settings'
            ? settingsPayload(form)
            : kind === 'restore'
              ? { revision: Number(values.get('revision')) }
              : memberPayload(values);
        if (
          kind === 'restore' &&
          !confirm(
            'Восстановить выбранные настройки? Несохранённые общие настройки будут заменены. Правила поведения, ключ и персональные разрешения сохранятся.',
          )
        )
          return;
        Object.assign(body, {
          expectedRevision: Number(form.dataset.revision),
          requestId: id(),
          reason: values.get('reason').trim(),
        });
        if (body.reason.length < 3 || body.reason.length > 300)
          throw Error('Укажите причину длиной от 3 до 300 символов.');
        operation = {
          body,
          route:
            '/api/admin/voice-assistant/' +
            (kind === 'settings' ? 'settings' : kind === 'restore' ? 'restore' : 'member'),
        };
      }
    } catch (error) {
      result(form, error.message, true);
      return;
    }
    pending.set(form, operation);
    form.dataset.busy = '1';
    form.dataset.dirty = '1';
    const fieldset = form.querySelector('[data-voice-fields]'),
      button = form.querySelector('[type="submit"]');
    fieldset.disabled = true;
    button.disabled = true;
    form.querySelector('[data-voice-reload]')?.setAttribute('disabled', '');
    result(form, 'Сохраняем…');
    try {
      const saved = await request(operation.route, {
        method: 'POST',
        body: JSON.stringify(operation.body),
      });
      operation.unknown = false;
      pending.delete(form);
      delete form.dataset.dirty;
      if (kind === 'restore' && currentForm('settings'))
        delete currentForm('settings').dataset.dirty;
      if (saved.revision !== undefined) form.dataset.revision = saved.revision;
      result(form, 'Изменения сохранены.');
      message('Настройки помощника сохранены.');
      await refreshAfterSave(kind, form);
    } catch (error) {
      operation.unknown = Boolean(error.unknown);
      if (!operation.unknown) pending.delete(form);
      result(
        form,
        operation.unknown
          ? 'Ответ не получен. Повторите сохранение: будет отправлена та же команда.'
          : error.status === 409
            ? 'Настройки уже изменились. Перечитайте их перед сохранением.'
            : error.message,
        true,
      );
    } finally {
      const key = form.querySelector('[name="timewebApiKey"]');
      if (key) key.value = '';
      delete form.dataset.busy;
      fieldset.disabled = Boolean(operation.unknown);
      button.disabled = false;
      if (operation.unknown) button.textContent = 'Повторить сохранение';
      else form.querySelector('[data-voice-reload]')?.removeAttribute('disabled');
    }
  }
  function discardMember() {
    const form = currentForm('member');
    return (
      !dirty(form) ||
      confirm('Перейти к другому пользователю без сохранения персонального доступа?')
    );
  }
  function bind() {
    view.providers.bind(root);
    picker.bind();
    behavior.bind();
    root.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-admin-voice-form]');
      if (!form) return;
      event.preventDefault();
      void submit(form);
    });
    root.addEventListener('input', (event) => {
      const form = event.target.closest('[data-admin-voice-draft]');
      if (form) form.dataset.dirty = '1';
    });
    root.addEventListener('change', (event) => {
      const form = event.target.closest('[data-admin-voice-draft]');
      if (form) form.dataset.dirty = '1';
    });
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-voice-reload]')) {
        if (
          !root.querySelector('[data-admin-voice-draft][data-dirty]') ||
          confirm('Перечитать настройки без сохранения введённых изменений?')
        )
          void load({ discard: true });
      }
      if (event.target.closest('[data-voice-member-reload]') && discardMember())
        void picker.refresh();
      if (event.target.closest('[data-voice-audit-reload]')) void loadAudit();
    });
    window.addEventListener('beforeunload', (event) => {
      if (!root.querySelector('[data-admin-voice-draft][data-dirty]')) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }
  return { load, bind };
}

function createAdminNavigation({ $ }) {
  const root = $('#admin-voice-assistant');
  let bound = false;
  const tabs = () => [...root.querySelectorAll('[data-admin-voice-tab]')];
  function activate(button, focus = false) {
    const key = button.dataset.adminVoiceTab;
    for (const tab of tabs()) {
      const selected = tab === button;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of root.querySelectorAll('[data-admin-voice-panel]'))
      panel.hidden = panel.dataset.adminVoicePanel !== key;
    if (focus) button.focus();
  }
  function bind() {
    if (bound) return;
    bound = true;
    root.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-admin-voice-tab]');
      if (tab) activate(tab);
    });
    root.addEventListener('keydown', (event) => {
      const tab = event.target.closest('[data-admin-voice-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = tabs(),
        index = buttons.indexOf(tab);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      activate(buttons[next], true);
    });
    // Keep native validation usable even when an advanced group is collapsed.
    root.addEventListener(
      'invalid',
      (event) => {
        const panel = event.target.closest('[data-admin-voice-panel]');
        if (panel) {
          const tab = tabs().find(
            (item) => item.dataset.adminVoiceTab === panel.dataset.adminVoicePanel,
          );
          if (tab) activate(tab);
        }
        let detail = event.target.closest('details');
        while (detail && root.contains(detail)) {
          detail.open = true;
          detail = detail.parentElement.closest('details');
        }
      },
      true,
    );
  }
  return { bind };
}

function createAdminBillingPages({ request, view, content, isCurrent, restorePending, message }) {
  const remembered = new Map();
  let organizationId = null,
    token = 0,
    organizationSerial = 0,
    orderSerial = 0,
    nextOffset = null,
    nextCursor = null,
    total = null,
    applied = { status: 'all', q: '' };
  const scopeKey = () => organizationId || 'platform';
  const current = (node, capturedToken) =>
    node?.isConnected && content()?.contains(node) && isCurrent(capturedToken);
  function controls(selector, disabled) {
    content()
      ?.querySelectorAll(selector)
      .forEach((node) => {
        node.disabled = disabled;
      });
  }
  function setOrganizationState(data = {}) {
    if (Number.isSafeInteger(data.total)) total = data.total;
    const root = content(),
      count = root?.querySelectorAll('[data-billing-organization-id]').length || 0,
      text = 'Показано ' + count + (Number.isSafeInteger(total) ? ' из ' + total : '');
    const label = root?.querySelector('[data-billing-organization-count]');
    if (label) label.textContent = text;
    for (const button of root?.querySelectorAll('[data-billing-organization-more]') || [])
      button.hidden = nextOffset == null;
    const hint = root?.querySelector('[data-billing-trial-list-hint]');
    if (hint)
      hint.textContent =
        nextOffset == null
          ? ''
          : 'В выборе кабинета показаны загруженные записи. Остальные можно загрузить здесь.';
  }
  function setOrderState() {
    const root = content(),
      count = root?.querySelectorAll('[data-admin-order-id]').length || 0;
    const label = root?.querySelector('[data-billing-orders-count]');
    if (label) label.textContent = 'Показано заказов: ' + count;
    const empty = root?.querySelector('[data-billing-orders-empty]');
    if (empty) {
      empty.hidden = count > 0;
      empty.textContent = nextCursor
        ? 'В этой части истории совпадений пока нет. Продолжите поиск.'
        : 'По этим условиям заказов нет.';
    }
    const more = root?.querySelector('[data-billing-orders-more]');
    if (more) {
      more.hidden = !nextCursor;
      more.textContent = nextCursor && !count ? 'Продолжить поиск' : 'Показать ещё 50 заказов';
    }
  }
  function permitReplacement(section) {
    if (section.querySelector('[data-busy]')) {
      message('Дождитесь результата действия по заказу.');
      return false;
    }
    const dirty = [...section.querySelectorAll('[data-admin-payment-review][data-dirty]')];
    if (dirty.length && !confirm('Обновить список заказов без сохранения введённых изменений?'))
      return false;
    return true;
  }
  async function loadOrganizations() {
    if (nextOffset == null) return;
    const root = content(),
      list = root?.querySelector('[data-billing-organization-list]');
    if (!list || list.hasAttribute('aria-busy')) return;
    const serial = ++organizationSerial,
      capturedToken = token,
      offset = nextOffset;
    const result = root.querySelector('[data-billing-organization-message]');
    controls('[data-billing-organization-more]', true);
    list.setAttribute('aria-busy', 'true');
    result.textContent = 'Загружаем кабинеты…';
    try {
      const data = await request(
        '/api/admin/billing/organizations?offset=' + encodeURIComponent(offset),
      );
      if (!current(list, capturedToken) || serial !== organizationSerial) return;
      const ids = new Set(
        [...list.querySelectorAll('[data-billing-organization-id]')].map(
          (node) => node.dataset.billingOrganizationId,
        ),
      );
      const items = (data.organizations || []).filter((item) => {
        if (ids.has(item.organizationId)) return false;
        ids.add(item.organizationId);
        return true;
      });
      list.insertAdjacentHTML('beforeend', view.organizationRowsHtml(items));
      const select = root.querySelector('[data-admin-package-trial] [name="organizationId"]');
      if (select)
        for (const item of items) {
          if ([...select.options].some((option) => option.value === item.organizationId)) continue;
          const option = document.createElement('option');
          option.value = item.organizationId;
          option.textContent = item.organizationName;
          select.append(option);
        }
      nextOffset = data.nextOffset ?? null;
      setOrganizationState(data);
      result.textContent = '';
    } catch (error) {
      if (current(list, capturedToken) && serial === organizationSerial)
        result.textContent = 'Список не дополнен. ' + error.message;
    } finally {
      if (current(list, capturedToken) && serial === organizationSerial) {
        list.removeAttribute('aria-busy');
        controls('[data-billing-organization-more]', false);
      }
    }
  }
  async function loadOrders(more = false, initial = false) {
    const root = content(),
      section = root?.querySelector('.paid-package-orders'),
      form = section?.querySelector('[data-billing-orders-filter]');
    if (!form || section.hasAttribute('aria-busy')) return;
    form.elements.q.value = form.elements.q.value.trim();
    if (!form.reportValidity()) return;
    const filters = {
      status: form.elements.status.value,
      q: form.elements.q.value,
      ...(form.elements.serviceCode ? { serviceCode: form.elements.serviceCode.value } : {}),
    };
    if (
      filters.status !== applied.status ||
      filters.q !== applied.q ||
      filters.serviceCode !== applied.serviceCode
    )
      more = false;
    if (!more && !initial && !permitReplacement(section)) {
      form.elements.status.value = applied.status;
      form.elements.q.value = applied.q;
      if (form.elements.serviceCode) form.elements.serviceCode.value = applied.serviceCode || '';
      return;
    }
    if (more && !nextCursor) return;
    const serial = ++orderSerial,
      capturedToken = token,
      parameters = {
        ...filters,
        ...(organizationId ? { organizationId } : {}),
        ...(more ? { before: nextCursor } : {}),
      };
    const result = section.querySelector('[data-billing-orders-message]'),
      list = section.querySelector('[data-billing-orders-list]');
    const locks = new Map();
    if (!more)
      for (const control of section.querySelectorAll(
        '[data-admin-payment-review] fieldset, [data-admin-payment-review] [type="submit"]',
      )) {
        locks.set(control, control.disabled);
        control.disabled = true;
      }
    controls(
      '[data-billing-orders-filter] input, [data-billing-orders-filter] select, [data-billing-orders-filter] button, [data-billing-orders-more]',
      true,
    );
    section.setAttribute('aria-busy', 'true');
    result.textContent = 'Загружаем заказы…';
    try {
      const data = await request('/api/admin/billing/orders?' + new URLSearchParams(parameters));
      if (!current(section, capturedToken) || serial !== orderSerial) return;
      if (!more) list.innerHTML = '';
      const ids = new Set(
        [...list.querySelectorAll('[data-admin-order-id]')].map(
          (node) => node.dataset.adminOrderId,
        ),
      );
      list.insertAdjacentHTML(
        'beforeend',
        view.orderRowsHtml(
          (data.orders || []).filter((item) => {
            const id = item.checkoutId || item.id;
            if (ids.has(id)) return false;
            ids.add(id);
            return true;
          }),
        ),
      );
      applied = filters;
      remembered.set(scopeKey(), filters);
      nextCursor = data.nextCursor || null;
      setOrderState();
      restorePending();
      result.textContent = '';
    } catch (error) {
      if (current(section, capturedToken) && serial === orderSerial)
        result.textContent = 'Список заказов не обновлён. ' + error.message;
    } finally {
      if (current(section, capturedToken) && serial === orderSerial) {
        section.removeAttribute('aria-busy');
        for (const [control, disabled] of locks)
          if (control.isConnected) control.disabled = disabled;
        controls(
          '[data-billing-orders-filter] input, [data-billing-orders-filter] select, [data-billing-orders-filter] button, [data-billing-orders-more]',
          false,
        );
      }
    }
  }
  function init(data, target, generation) {
    organizationId = target;
    token = generation;
    organizationSerial++;
    orderSerial++;
    nextOffset = data.nextOffset ?? null;
    total = data.organizationTotal ?? null;
    nextCursor = data.ordersNextCursor || null;
    applied = { status: 'all', q: '' };
    setOrganizationState();
    setOrderState();
    const filters = remembered.get(scopeKey()),
      form = content()?.querySelector('[data-billing-orders-filter]');
    if (filters && form && (filters.status !== 'all' || filters.q || filters.serviceCode)) {
      form.elements.status.value = filters.status;
      form.elements.q.value = filters.q;
      if (form.elements.serviceCode) form.elements.serviceCode.value = filters.serviceCode || '';
      void loadOrders(false, true);
    }
  }
  function bind() {
    document.addEventListener('submit', (event) => {
      if (!event.target.matches?.('[data-billing-orders-filter]')) return;
      event.preventDefault();
      void loadOrders();
    });
    document.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-billing-organization-more]')) void loadOrganizations();
      if (event.target.closest?.('[data-billing-orders-more]')) void loadOrders(true);
      if (event.target.closest?.('[data-billing-orders-reset]')) {
        const form = content()?.querySelector('[data-billing-orders-filter]');
        if (!form) return;
        form.elements.status.value = 'all';
        form.elements.q.value = '';
        if (form.elements.serviceCode) form.elements.serviceCode.value = '';
        void loadOrders();
      }
    });
  }
  return { init, bind };
}

function createAdminBillingNavigation({ content, scope }) {
  const selected = new Map();
  function activate(key, focus = false) {
    const root = content(),
      tabs = [...(root?.querySelectorAll('[data-admin-billing-tab]') || [])],
      target = tabs.find((tab) => tab.dataset.adminBillingTab === key) || tabs[0];
    if (!target) return;
    key = target.dataset.adminBillingTab;
    for (const tab of tabs) {
      const active = tab === target;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of root.querySelectorAll('[data-admin-billing-panel]'))
      panel.hidden = panel.dataset.adminBillingPanel !== key;
    selected.set(scope() || 'platform', key);
    if (focus) target.focus();
  }
  function restore() {
    activate(selected.get(scope() || 'platform') || 'cabinets');
  }
  function bind() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest?.('[data-admin-billing-tab]');
      if (target && content()?.contains(target)) activate(target.dataset.adminBillingTab);
    });
    document.addEventListener('keydown', (event) => {
      const target = event.target.closest?.('[data-admin-billing-tab]');
      if (
        !target ||
        !content()?.contains(target) ||
        !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
      )
        return;
      event.preventDefault();
      const tabs = [...content().querySelectorAll('[data-admin-billing-tab]')],
        index = tabs.indexOf(target);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activate(tabs[next].dataset.adminBillingTab, true);
    });
    document.addEventListener(
      'invalid',
      (event) => {
        if (!content()?.contains(event.target)) return;
        const panel = event.target.closest('[data-admin-billing-panel]');
        if (panel) activate(panel.dataset.adminBillingPanel);
        for (
          let detail = event.target.closest('details');
          detail && content().contains(detail);
          detail = detail.parentElement.closest('details')
        )
          detail.open = true;
      },
      true,
    );
  }
  return { restore, bind };
}

function createAdminBilling({ $, request, records, message, changeView }) {
  const view = createAdminBillingView({ records }),
    review = createAdminPaymentReviewView({ records }),
    pending = new Map(),
    readLocks = new Map(),
    forms =
      '[data-admin-package-form], [data-admin-package-trial], [data-admin-package-payments], [data-admin-payment-review], [data-admin-financial-action], [data-admin-financial-check]';
  let generation = 0,
    overviewGeneration = 0,
    organizationId = null,
    bound = false;
  const content = () => $('#admin-billing-content');
  const active = () => !content()?.closest('[hidden]');
  const dirty = () => content()?.querySelector('[data-dirty]');
  const navigation = createAdminBillingNavigation({ content, scope: () => organizationId });
  const pages = createAdminBillingPages({
    request,
    view,
    content,
    isCurrent: (serial) => serial === generation && active(),
    restorePending,
    message,
  });
  function key(form) {
    if (form.hasAttribute('data-admin-financial-action'))
      return 'finance:' + form.dataset.checkoutId;
    if (form.hasAttribute('data-admin-financial-check'))
      return 'finance-check:' + form.dataset.actionId;
    if (form.hasAttribute('data-admin-payment-review')) return 'review:' + form.dataset.checkoutId;
    if (form.hasAttribute('data-admin-package-payments')) return 'payments';
    if (form.hasAttribute('data-admin-package-trial'))
      return 'trial:' + (form.dataset.organizationId || 'all');
    return 'package:' + (form.dataset.packageId || 'new');
  }
  function result(form, text, error = false) {
    const node = form.querySelector('[data-admin-billing-message]');
    node.textContent = text;
    node.dataset.status = error ? 'error' : 'success';
  }
  function restorePending() {
    for (const form of content().querySelectorAll(forms)) {
      const operation = pending.get(key(form));
      if (!operation?.unknown) continue;
      for (const [name, value] of Object.entries({
        ...operation.body,
        ...operation.body.receiptConfig,
      })) {
        if (name === 'secretKey') continue;
        const field = form.elements.namedItem(name);
        if (!field) continue;
        if (field.type === 'checkbox') field.checked = value === true;
        else field.value = value ?? '';
      }
      form.dataset.dirty = '1';
      form.querySelector('fieldset').disabled = true;
      form.querySelector('[type="submit"]').textContent = 'Повторить прежнее действие';
      form.closest('details')?.setAttribute('open', '');
      result(form, 'Ответ не получен. Повтор сохранит прежний номер операции.', true);
    }
  }
  async function loadOverview() {
    const node = $('#admin-overview-billing'),
      serial = ++overviewGeneration;
    if (!node || node.closest('[hidden]')?.dataset.adminSection) return;
    try {
      const data = await request('/api/admin/billing/summary');
      if (serial === overviewGeneration && node.isConnected)
        node.innerHTML = view.summaryHtml(data, { compact: true });
    } catch (error) {
      if (serial === overviewGeneration && node.isConnected) node.textContent = error.message;
    }
  }
  async function load({ organizationId: target = null, discard = false } = {}) {
    const root = content();
    if (!root) return;
    if (root.querySelector('[data-busy]')) {
      message('Дождитесь результата выполняющегося действия.');
      return;
    }
    if (dirty() && !discard && !confirm('Перечитать пакеты без сохранения введённых изменений?'))
      return;
    const serial = ++generation;
    organizationId = target || null;
    for (const field of root.querySelectorAll('fieldset')) {
      if (!readLocks.has(field)) readLocks.set(field, field.disabled);
      field.disabled = true;
    }
    root.setAttribute('aria-busy', 'true');
    $('#admin-billing-summary').textContent = 'Загружаем пакеты…';
    try {
      const data = await request(
        '/api/admin/billing' +
          (organizationId ? '?organizationId=' + encodeURIComponent(organizationId) : ''),
      );
      if (serial !== generation || !root.isConnected || !active()) return;
      const item = data.organizations?.find((entry) => entry.organizationId === organizationId);
      const organization = organizationId
        ? data.organization || {
            id: organizationId,
            name: item?.organizationName || 'Выбранный кабинет',
          }
        : null;
      root.innerHTML =
        (organizationId
          ? '<button type="button" class="text-btn" data-admin-billing-back>← Все пакеты и кабинеты</button>'
          : '') +
        view.renderBillingAdminHtml(
          {
            ...data,
            subscription: data.subscription || item?.subscription,
          },
          organization,
        );
      $('#admin-billing-summary').textContent = organization
        ? 'Кабинет: ' + organization.name
        : data.paymentConfiguration?.notice ||
          (data.paymentConfiguration?.ready
            ? 'Приём оплат настроен. Клиенты покупают месячные пакеты без автоматического продления.'
            : 'Приём оплат ещё не подключён. Можно создать пакеты и предоставить пробный доступ.');
      for (const form of root.querySelectorAll('[data-admin-package-form]'))
        updatePackageFields(form);
      restorePending();
      pages.init(data, organizationId, serial);
      navigation.restore();
    } catch (error) {
      if (serial === generation && root.isConnected)
        $('#admin-billing-summary').textContent = error.message;
    } finally {
      if (serial === generation && root.isConnected) {
        root.removeAttribute('aria-busy');
        for (const [field, disabled] of readLocks) if (field.isConnected) field.disabled = disabled;
        readLocks.clear();
      }
    }
  }
  function operationFor(form) {
    const existing = pending.get(key(form));
    if (existing?.unknown) return existing;
    const values = new FormData(form),
      text = (name) => String(values.get(name) || '').trim(),
      common = { requestId: window.crypto.randomUUID(), reason: text('reason') };
    if (form.hasAttribute('data-admin-financial-check'))
      return {
        route: '/api/admin/billing/financial-action-check',
        kind: 'review',
        body: {
          id: form.dataset.actionId,
          ...(text('referenceId')
            ? { referenceId: text('referenceId'), reason: common.reason }
            : {}),
        },
      };
    if (form.hasAttribute('data-admin-financial-action')) {
      const amount = text('amountRub');
      if (text('kind') === 'refund' && !/^\d+(?:[.,]\d{1,2})?$/.test(amount))
        throw Error('Укажите сумму возврата с точностью до копеек.');
      const [whole = '0', part = ''] = amount.replace(',', '.').split('.');
      const kopecks = BigInt(whole || '0') * 100n + BigInt(part.padEnd(2, '0'));
      if (kopecks > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Сумма слишком велика.');
      return {
        route: '/api/admin/billing/financial-action',
        kind: 'review',
        body: {
          ...common,
          checkoutId: form.dataset.checkoutId,
          expectedRevision: Number(form.dataset.revision),
          kind: text('kind'),
          amountKopecks: Number(kopecks),
          receiptEmail: text('receiptEmail'),
          accessPolicy: text('accessPolicy'),
          serviceProvided: values.has('serviceProvided'),
        },
      };
    }
    if (form.hasAttribute('data-admin-payment-review')) return review.operation(form, common);
    if (form.hasAttribute('data-admin-package-trial'))
      return {
        route: '/api/admin/billing/trial',
        kind: 'trial',
        body: {
          ...common,
          organizationId: text('organizationId'),
          packageId: text('packageId'),
        },
      };
    if (form.hasAttribute('data-admin-package-payments')) {
      const secret = text('secretKey');
      if (secret && values.has('clearSecret'))
        throw Error('Введите новый ключ или выберите удаление.');
      return {
        route: '/api/admin/billing/payment-settings',
        kind: 'payments',
        body: {
          ...common,
          expectedRevision: Number(form.dataset.revision),
          configured: values.has('configured'),
          testMode: values.has('testMode'),
          shopId: text('shopId'),
          returnOrigin: text('returnOrigin'),
          ...(secret ? { secretKey: secret } : {}),
          ...(values.has('clearSecret') ? { clearSecret: true } : {}),
          receiptConfig: {
            fiscalProvider: text('fiscalProvider'),
            purchaseModel: 'package',
            paymentMode: text('paymentMode'),
            paymentSubject: text('paymentSubject'),
            vatCode: text('vatCode') === '' ? null : Number(text('vatCode')),
            taxSystemCode: text('taxSystemCode') === '' ? null : Number(text('taxSystemCode')),
            description: text('description'),
          },
        },
      };
    }
    return {
      route: '/api/admin/billing/package',
      kind: 'package',
      body: {
        ...common,
        expectedRevision: Number(form.dataset.revision),
        id: text('id') || window.crypto.randomUUID(),
        title: text('title'),
        priceRub: text('priceRub'),
        taskLimit: text('quotaUnit') === 'access' ? 1 : Number(text('taskLimit')),
        ...(values.has('serviceCode')
          ? {
              serviceCode:
                text('serviceCode') === 'new'
                  ? 'service-' + window.crypto.randomUUID()
                  : text('serviceCode'),
              serviceTitle: text('serviceTitle'),
              periodMonths: Number(text('periodMonths')),
              quotaUnit: text('quotaUnit'),
              receipt: {
                description: text('receiptDescription'),
                paymentMode: text('receiptPaymentMode'),
                paymentSubject: text('receiptPaymentSubject'),
                vatCode: text('receiptVatCode') === '' ? null : Number(text('receiptVatCode')),
              },
            }
          : {}),
        enabled: values.has('enabled'),
      },
    };
  }
  async function submit(form) {
    if (
      form.dataset.busy ||
      content()?.hasAttribute('aria-busy') ||
      form.closest('.paid-package-orders[aria-busy]')
    )
      return;
    const known = pending.get(key(form));
    if (!known?.unknown && !form.reportValidity()) return;
    let operation;
    try {
      operation = operationFor(form);
    } catch (error) {
      result(form, error.message, true);
      return;
    }
    if (
      !known?.unknown &&
      !confirm(
        operation.kind === 'review'
          ? form.hasAttribute('data-admin-financial-action')
            ? 'Подтвердить финансовую операцию? Возврат отправит указанную сумму, чек — данные в кассу. Другие услуги не изменятся.'
            : 'Выполнить выбранное действие по заказу? Заявка на проверку сама не возвращает деньги и не создаёт чек.'
          : operation.kind === 'trial'
            ? 'Предоставить этому кабинету выбранный пробный пакет без оплаты?'
            : operation.kind === 'payments'
              ? 'Сохранить настройки приёма оплат? Проверьте тестовый или рабочий режим.'
              : 'Сохранить услугу, срок, цену и лимит пакета для последующих покупок?',
      )
    )
      return;
    const capturedGeneration = generation,
      capturedOrganization = organizationId,
      button = form.querySelector('[type="submit"]'),
      fields = form.querySelector('fieldset');
    pending.set(key(form), operation);
    form.dataset.busy = '1';
    form.dataset.dirty = '1';
    fields.disabled = true;
    button.disabled = true;
    result(form, 'Сохраняем…');
    try {
      const response = await request(operation.route, {
        method: 'POST',
        body: JSON.stringify(operation.body),
      });
      const financial =
        form.hasAttribute('data-admin-financial-action') ||
        form.hasAttribute('data-admin-financial-check');
      if (
        response.operation?.status === 'pending' ||
        (financial && ['creating', 'uncertain', 'review'].includes(response.operation?.status))
      ) {
        operation.unknown = true;
        if (form.isConnected && capturedGeneration === generation)
          result(
            form,
            response.operation.notice ||
              (financial && response.operation.status === 'review'
                ? 'Нужна сверка существующего объекта в ЮKassa. Новый возврат не создавайте.'
                : '') ||
              response.notice ||
              'Действие ещё выполняется. Повтор проверьте прежним номером операции.',
            true,
          );
        return;
      }
      pending.delete(key(form));
      operation.unknown = false;
      if (!form.isConnected || capturedGeneration !== generation) return;
      delete form.dataset.dirty;
      result(
        form,
        operation.kind === 'trial' ? 'Пробный пакет подключён.' : 'Изменения сохранены.',
      );
      message(
        operation.kind === 'review'
          ? response.operation?.notice ||
              (financial
                ? {
                    succeeded: 'Финансовая операция подтверждена.',
                    canceled: 'Финансовая операция отменена провайдером.',
                    rejected: 'Провайдер отклонил финансовую операцию.',
                  }[response.operation?.status] || 'Статус финансовой операции обновлён.'
                : 'Проверка заказа завершена.')
          : operation.kind === 'trial'
            ? 'Пробный пакет подключён.'
            : 'Настройки пакетов сохранены.',
      );
      if (!dirty() && active()) {
        delete form.dataset.busy;
        await load({ organizationId: capturedOrganization, discard: true });
      }
    } catch (error) {
      operation.unknown = Boolean(error.unknown || error.outcomeUnknown);
      if (!operation.unknown) pending.delete(key(form));
      if (!form.isConnected || capturedGeneration !== generation) return;
      if (operation.unknown) form.dataset.dirty = '1';
      result(
        form,
        operation.unknown
          ? 'Ответ не получен. Повторите прежнее действие, чтобы проверить результат.'
          : error.status === 409
            ? 'Условия изменились. Перечитайте раздел перед сохранением.'
            : error.message,
        true,
      );
    } finally {
      if (form.isConnected) {
        const secret = form.querySelector('[name="secretKey"]');
        if (secret) secret.value = '';
        delete form.dataset.busy;
        fields.disabled = Boolean(operation.unknown);
        button.disabled = false;
        if (operation.unknown) button.textContent = 'Повторить прежнее действие';
      }
    }
  }
  function updatePackageFields(form) {
    const service = form.elements.namedItem('serviceCode'),
      unit = form.elements.namedItem('quotaUnit');
    if (!service || !unit) return;
    if (form.dataset.packageId)
      for (const option of service.options) option.disabled = option.value !== service.value;
    const voice = service.value === 'voice-assistant',
      period = form.elements.namedItem('periodMonths');
    if (voice) {
      unit.value = 'tasks';
      period.value = '1';
    }
    period.readOnly = voice;
    for (const option of unit.options)
      if (option.value && option.value !== 'tasks') option.disabled = voice;
    const quota = form.elements.namedItem('taskLimit'),
      label = form.elements.namedItem('serviceTitle');
    quota.closest('label').hidden = unit.value === 'access';
    quota.disabled = unit.value === 'access';
    if (label) {
      label.closest('label').hidden = service.value !== 'new';
      label.required = service.value === 'new';
    }
  }
  function bind() {
    if (bound) return;
    bound = true;
    navigation.bind();
    pages.bind();
    $('#admin-billing-refresh')?.addEventListener('click', () => {
      void load({ organizationId });
    });
    document.addEventListener('click', (event) => {
      const target = event.target.closest?.('[data-admin-billing-organization]');
      if (target) void changeView('billing', target.dataset.adminBillingOrganization);
      if (event.target.closest?.('[data-admin-billing-back]')) void changeView('billing');
    });
    for (const type of ['input', 'change'])
      document.addEventListener(type, (event) => {
        const form = event.target.closest?.(forms);
        if (form) {
          form.dataset.dirty = '1';
          if (form.hasAttribute('data-admin-package-form')) updatePackageFields(form);
        }
      });
    document.addEventListener('submit', (event) => {
      const form = event.target.closest?.(forms);
      if (!form) return;
      event.preventDefault();
      void submit(form);
    });
    window.addEventListener('beforeunload', (event) => {
      if (!dirty() && ![...pending.values()].some((operation) => operation.unknown)) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }
  return { load, loadOverview, bind };
}

function createAdminMfaSettings({ $, request, records }) {
  const { esc } = records;
  let busy = false,
    generation = 0;
  const root = () => $('#admin-mfa-content');
  function message(text) {
    const node = root()?.querySelector('[data-mfa-message]');
    if (node) node.textContent = text;
  }
  function codesHtml(codes) {
    return codes
      ? '<p>Сохраните резервные коды в безопасном месте. Каждый работает один раз. После закрытия они не показываются.</p><textarea readonly rows="5" aria-label="Резервные коды">' +
          esc(codes.join('\n')) +
          '</textarea>'
      : '';
  }
  function render(data, codes = null) {
    root().innerHTML =
      '<p><strong>' +
      (data.enabled ? 'Подтверждение входа включено' : 'Подтверждение входа не включено') +
      '</strong></p>' +
      (data.enabled
        ? '<p>Осталось резервных кодов: ' +
          esc(data.recoveryRemaining ?? codes?.length ?? '—') +
          '. Сброс пароля не отключает эту защиту.</p>'
        : '<p>Подключите приложение для одноразовых кодов. Защита включится после проверки кода; входы сотрудников не меняются.</p>') +
      codesHtml(codes) +
      '<form data-admin-mfa-form><fieldset><label class="field">Текущий пароль<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label>' +
      (data.enabled
        ? '<label class="field">Код приложения или резервный код<input name="code" required maxlength="64" autocomplete="one-time-code"></label><label class="field">Действие<select name="action"><option value="recovery">Заменить резервные коды</option><option value="disable">Отключить подтверждение входа</option></select></label>'
        : '<input name="action" type="hidden" value="prepare">') +
      '</fieldset><button type="submit" class="secondary">' +
      (data.enabled ? 'Выполнить' : 'Настроить подтверждение входа') +
      '</button></form><p role="status" data-mfa-message></p>';
  }
  async function load() {
    const serial = ++generation;
    try {
      const data = await request('/api/admin/security/mfa');
      if (serial === generation && root()?.isConnected) render(data);
    } catch (error) {
      message(error.message);
    }
  }
  function prepared(data) {
    root().innerHTML =
      '<p>Добавьте Картотеку в приложение-аутентификатор и введите шестизначный код. Настройка действует10минут.</p>' +
      '<img data-mfa-qr width="240" height="240" alt="QR-код подключения приложения"><label class="field">Секрет для ручного ввода<input readonly data-mfa-secret></label>' +
      '<form data-admin-mfa-form data-setup-id="' +
      esc(data.setupId) +
      '"><fieldset><input type="hidden" name="action" value="enable"><label class="field">Код из приложения<input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label></fieldset><button type="submit" class="secondary">Включить защиту</button></form><p role="status" data-mfa-message></p>';
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qr))
      throw Error('Не удалось подготовить QR-код.');
    root().querySelector('[data-mfa-qr]').src = data.qr;
    root().querySelector('[data-mfa-secret]').value = data.secret;
  }
  async function submit(form) {
    if (busy || !form.reportValidity()) return;
    const action = form.elements.action.value;
    if (
      action === 'disable' &&
      !confirm('Отключить подтверждение входа? Другие сеансы будут завершены.')
    )
      return;
    busy = true;
    const serial = ++generation,
      fieldset = form.querySelector('fieldset'),
      button = form.querySelector('[type="submit"]');
    const values = new FormData(form),
      body =
        action === 'enable'
          ? { setupId: form.dataset.setupId, code: String(values.get('code') || '') }
          : {
              password: String(values.get('password') || ''),
              ...(action === 'prepare'
                ? { requestId: (form.dataset.requestId ||= window.crypto.randomUUID()) }
                : { code: String(values.get('code') || '') }),
            };
    fieldset.disabled = true;
    button.disabled = true;
    message('Проверяем…');
    try {
      const data = await request('/api/admin/security/mfa/' + action, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (serial !== generation || !root()?.isConnected) return;
      if (action === 'prepare') prepared(data);
      else {
        render(data, data.recoveryCodes);
        message(
          data.recoveryCodes
            ? 'Защита настроена. Сохраните резервные коды.'
            : data.enabled
              ? 'Защита включена. Если коды не были получены, создайте новые кодом приложения.'
              : 'Подтверждение входа отключено.',
        );
      }
    } catch (error) {
      if (serial === generation) message(error.message);
    } finally {
      busy = false;
      if (form.isConnected) {
        fieldset.disabled = false;
        button.disabled = false;
        const password = form.elements.password;
        if (password) password.value = '';
      }
    }
  }
  function bind() {
    const details = $('#admin-mfa-settings');
    details?.addEventListener('toggle', () => {
      if (details.open && !busy) void load();
      else if (!details.open) {
        generation++;
        if (root())
          root().innerHTML =
            '<p role="status" data-mfa-message>Откройте настройки для проверки состояния.</p>';
      }
    });
    document.addEventListener('submit', (event) => {
      if (event.target.matches?.('[data-admin-mfa-form]')) {
        event.preventDefault();
        void submit(event.target);
      }
    });
    window.addEventListener('pagehide', () => {
      generation++;
      if (root()) root().textContent = '';
    });
  }
  return { bind };
}

(() => {
  const $ = (selector) => document.querySelector(selector);
  const token = new URLSearchParams(location.hash.slice(1)).get('setup') || '';
  let accountContext = null,
    contextChanged = false;
  const requests = new Set();
  const contextError = () =>
    Object.assign(Error('Учётная запись изменилась. Откройте кабинет заново.'), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      unknown: false,
      outcomeUnknown: false,
    });
  function rejectContext() {
    if (!contextChanged) {
      contextChanged = true;
      for (const controller of requests) controller.abort();
      show('#admin-denied');
      $('#admin-denied p').textContent = contextError().message;
      location.replace('/');
    }
    return contextError();
  }
  const show = (id) => {
    for (const section of [
      '#admin-loading',
      '#admin-setup',
      '#admin-created',
      '#admin-dashboard',
      '#admin-denied',
    ])
      $(section).hidden = section !== id;
  };
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    contextChanged = true;
    for (const controller of requests) controller.abort();
    show('#admin-loading');
    $('#admin-identity').textContent = '';
    $('#admin-logout').hidden = true;
    location.reload();
  });
  function message(text, error = false) {
    $('#admin-message').textContent = text;
    $('#admin-message').dataset.status = error ? 'error' : 'success';
  }
  async function request(route, options = {}) {
    const context = accountContext,
      publicRoute = [
        '/api/auth/session',
        '/api/auth/logout',
        '/api/admin/bootstrap',
        '/api/admin/bootstrap-status',
      ].includes(route.split('?')[0]);
    if (contextChanged || (!publicRoute && !context?.accountId)) throw contextError();
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 15000);
    requests.add(controller);
    try {
      const response = await fetch(route, {
        cache: 'no-store',
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          ...options.headers,
          ...(context
            ? {
                'X-Cartoteca-Account-Id': context.accountId,
                'X-Cartoteca-Organization-Id': context.organizationId,
              }
            : {}),
        },
      });
      const result = await response.json();
      if (contextChanged || context !== accountContext) throw contextError();
      if (response.status === 428 || result.code === 'AUTH_CONTEXT_CHANGED') throw rejectContext();
      if (!response.ok) {
        const error = Error(result.error || 'Не удалось выполнить операцию.');
        error.status = response.status;
        error.unknown =
          options.method === 'POST' && response.status >= 500 && result.code !== 'UPLOAD_CAPACITY';
        throw error;
      }
      return result;
    } catch (error) {
      if (contextChanged) throw contextError();
      if (!error.status) error.unknown = options.method === 'POST';
      throw error;
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
    }
  }
  const records = createAdminRecords(),
    details = createAdminDetails(records);
  const overview = createAdminOverview({ $, records });
  const lists = createAdminLists({ $, request, records, details, message });
  const voice = createAdminVoice({ $, request, records, message });
  const billing = createAdminBilling({ $, request, records, message, changeView });
  createAdminMfaSettings({ $, request, records }).bind();
  voice.bind();
  billing.bind();
  createAdminNavigation({ $ }).bind();
  let auditNext = null,
    auditOrg = null,
    auditGeneration = 0,
    viewGeneration = 0;
  async function reloadSummary() {
    overview.renderOverview(await request('/api/admin/overview'));
    void billing.loadOverview();
  }
  async function loadAudit(more = false, organizationId = undefined) {
    const generation = ++auditGeneration;
    if (organizationId !== undefined) auditOrg = organizationId;
    const parameters = {};
    parameters.q = $('#admin-audit-search').value.trim();
    if (auditOrg) parameters.organizationId = auditOrg;
    if ($('#admin-audit-event').value) parameters.event = $('#admin-audit-event').value;
    if (more && auditNext) parameters.before = auditNext;
    $('#admin-audit-more').disabled = true;
    try {
      const data = await request('/api/admin/audit?' + new URLSearchParams(parameters));
      if (generation !== auditGeneration) return;
      overview.renderAudit(data.items, more);
      auditNext = data.next;
      $('#admin-audit-more').hidden = !auditNext;
      $('#admin-audit-clear').hidden = !auditOrg;
    } catch (error) {
      message(error.message, true);
    } finally {
      if (generation === auditGeneration) $('#admin-audit-more').disabled = false;
    }
  }
  async function changeView(view, organizationId) {
    if (
      ![
        'overview',
        'organizations',
        'accounts',
        'support',
        'audit',
        'system',
        'voice-assistant',
        'billing',
      ].includes(view)
    )
      return;
    const dirty = [
      ...document.querySelectorAll(
        '[data-admin-record][data-dirty], [data-admin-voice-draft][data-dirty], [data-admin-package-form][data-dirty], [data-admin-package-trial][data-dirty], [data-admin-package-payments][data-dirty], [data-admin-payment-review][data-dirty]',
      ),
    ];
    if (dirty.length && !confirm('Перейти в другой раздел без сохранения изменений?')) return;
    for (const item of dirty) delete item.dataset.dirty;
    const generation = ++viewGeneration;
    document.querySelectorAll('[data-admin-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.adminView === view);
      button.setAttribute('aria-pressed', String(button.dataset.adminView === view));
    });
    document.querySelectorAll('[data-admin-section]').forEach((section) => {
      section.hidden = section.dataset.adminSection !== view;
    });
    try {
      if (view === 'overview') await reloadSummary();
      else if (view === 'voice-assistant') await voice.load();
      else if (view === 'billing') await billing.load({ organizationId });
      else if (lists.config[view]) await lists.load(view);
      else if (view === 'audit') await loadAudit(false, organizationId);
      else {
        const system = await request('/api/admin/system');
        if (generation === viewGeneration) overview.renderSystem(system);
      }
    } catch (error) {
      message(error.message, true);
    }
  }
  bindAdminEvents({
    $,
    token,
    show,
    request,
    message,
    changeView,
    lists,
    reloadSummary,
    loadAudit,
  });
  async function initialize() {
    try {
      if (token) {
        history.replaceState(null, '', location.pathname);
        const status = await request(
          '/api/admin/bootstrap-status?token=' + encodeURIComponent(token),
        );
        if (!status.valid) {
          show('#admin-denied');
          $('#admin-denied p').textContent = status.exists
            ? 'Главный администратор уже создан.'
            : 'Ссылка недействительна или истекла.';
          return;
        }
        show('#admin-setup');
        return;
      }
      const session = await request('/api/auth/session');
      if (!session.user?.globalAdmin) {
        show('#admin-denied');
        return;
      }
      accountContext = {
        accountId: session.user.id,
        organizationId: session.user.organizationId || '',
      };
      $('#admin-identity').textContent = session.user.displayName + ' · ' + session.user.email;
      await reloadSummary();
      $('#admin-logout').hidden = false;
      show('#admin-dashboard');
      const caseId = new URLSearchParams(location.hash.slice(1)).get('case');
      if (caseId) {
        await changeView('support');
        // The case may be outside the first page: fetch only this authorized record.
        const ticket = await request('/api/admin/support/case?id=' + encodeURIComponent(caseId));
        $('#admin-support-list').innerHTML = records.supportRecord({
          ...ticket,
          excerpt: ticket.description.slice(0, 160),
        });
        $('#admin-support-more').hidden = true;
        $('#admin-support-count').textContent = 'Выбранное обращение';
        lists.bindRecords($('#admin-support-list'));
        const row = $('#admin-support-list [data-admin-record]');
        row.open = true;
      }
    } catch (error) {
      show('#admin-denied');
      $('#admin-denied p').textContent = error.message;
    }
  }
  void initialize();
})();

})();
