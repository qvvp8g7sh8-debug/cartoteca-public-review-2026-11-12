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
