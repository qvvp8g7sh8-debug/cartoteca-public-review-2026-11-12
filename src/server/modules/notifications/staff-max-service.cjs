const { fail } = require('../../../shared/errors.cjs');
const { maxId, maxInvitationLink } = require('./max-adapter.cjs');
const { MAX_USERNAME } = require('./max-connections.cjs');
function createStaffMaxService({ platform, identity = null, enabled = false, clock = Date.now }) {
  const store = platform.staffMaxNotifications;
  if (identity && identity.username !== MAX_USERNAME) throw fail(409, 'Настроен другой MAX-бот.');
  const botId = identity ? maxId(identity.botId) : '';
  const ready = () => Boolean(enabled === true && store && botId);
  function status(token) {
    // Even disabled/preparation status is scoped to the authenticated active member.
    platform.onlineBooking.actor(token);
    const value = store
      ? store.status(token, botId)
      : { linked: false, enabled: false, bindingId: '', available: false };
    return {
      ...value,
      available: ready() && value.available,
      prepared: Boolean(store),
      bot: {
        connected: ready(),
        configured: Boolean(identity),
        username: ready() ? identity.username : '',
      },
    };
  }
  function issue(token) {
    platform.onlineBooking.actor(token);
    if (!ready()) throw fail(503, 'Личные уведомления MAX ещё не подготовлены.');
    const result = store.issue(token, botId, clock());
    return {
      url: maxInvitationLink(identity.username, 'staff_' + result.token),
      expiresAt: result.expiresAt,
    };
  }
  function update(token, values, disconnect = false) {
    platform.onlineBooking.actor(token);
    if (!store) throw fail(503, 'Личные уведомления MAX ещё не подготовлены.');
    if (!disconnect && values?.enabled && !ready()) throw fail(503, 'Бот MAX сейчас недоступен.');
    store.update(token, values, disconnect, botId);
    return status(token);
  }
  function consumeStarted(payload, userId, eventAt) {
    if (!ready()) return { ignored: true };
    const secret = payload.match(/^staff_([A-Za-z0-9_-]{43})$/)?.[1];
    if (!secret) return { ignored: true };
    return store.consume(secret, botId, userId, eventAt, clock());
  }
  function stopped(userId, eventAt) {
    return ready() ? store.stopped(botId, userId, eventAt, clock()) : 0;
  }
  return { status, issue, update, consumeStarted, stopped };
}
module.exports = { createStaffMaxService };
