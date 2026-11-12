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
