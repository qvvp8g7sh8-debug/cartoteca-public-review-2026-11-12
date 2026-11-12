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
