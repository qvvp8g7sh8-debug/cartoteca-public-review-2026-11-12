const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { maxId } = require('./max-adapter.cjs');
const { confirmationReply } = require('./notification-message.cjs');

// Authentication happens before body parsing; normalization excludes names and message text.
function createMaxEvents({
  connections,
  coordinator = null,
  staff = null,
  botId = '',
  secret = '',
  enabled = false,
  clock = Date.now,
}) {
  if (typeof secret !== 'string') throw fail(400, 'Некорректная настройка событий MAX.');
  if (enabled && !/^[A-Za-z0-9_-]{32,256}$/.test(secret))
    throw fail(400, 'Настройте защищённый приём событий MAX.');
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  const expected = digest(secret);
  function authenticate(header) {
    if (enabled !== true) throw fail(503, 'Приём событий MAX не включён.');
    if (
      typeof header !== 'string' ||
      header.length > 256 ||
      !crypto.timingSafeEqual(digest(header), expected)
    )
      throw fail(403, 'Событие MAX не авторизовано.');
  }
  function normalize(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event))
      throw fail(400, 'Некорректное событие MAX.');
    if (!['bot_started', 'bot_stopped', 'message_callback'].includes(event.update_type))
      return null;
    if (
      !Number.isSafeInteger(event.timestamp) ||
      event.timestamp <= 0 ||
      event.timestamp > clock() + 300000 ||
      event.timestamp < clock() - 48 * 3600000
    )
      throw fail(400, 'Некорректное время события MAX.');
    const base = { update_type: event.update_type, timestamp: event.timestamp };
    if (event.update_type === 'message_callback') {
      const callback = event.callback;
      if (
        callback?.user?.is_bot !== false ||
        event.message?.recipient?.chat_type !== 'dialog' ||
        event.is_channel === true
      )
        throw fail(400, 'Подтверждение доступно только в личном диалоге MAX.');
      if (
        typeof callback.callback_id !== 'string' ||
        !callback.callback_id.trim() ||
        callback.callback_id.length > 256
      )
        throw fail(400, 'Некорректная кнопка MAX.');
      const userId = maxId(callback.user.user_id);
      if (maxId(event.message.recipient.user_id) !== userId)
        throw fail(403, 'Другой получатель MAX.');
      const payload = typeof callback.payload === 'string' ? callback.payload : '';
      if (!/^confirm_[A-Za-z0-9_-]{27}$/.test(payload)) return null;
      const links = Array.isArray(event.message.body?.attachments)
        ? event.message.body.attachments
            .slice(0, 5)
            .filter((item) => item?.type === 'inline_keyboard')
            .flatMap((item) =>
              Array.isArray(item.payload?.buttons) ? item.payload.buttons.slice(0, 10).flat() : [],
            )
        : [];
      const contactUrl =
        [event.message.contactUrl, ...links.map((item) => item?.url)].find(
          (value) =>
            typeof value === 'string' &&
            value.startsWith('https://wa.me/') &&
            /^[1-9]\d{6,14}$/.test(value.slice(14)),
        ) || '';
      return {
        ...base,
        callback: {
          callback_id: callback.callback_id,
          payload,
          user: { user_id: userId, is_bot: false },
        },
        message: {
          recipient: { chat_type: 'dialog', user_id: userId },
          ...(contactUrl ? { contactUrl } : {}),
          ...(typeof event.message.body?.mid === 'string' && event.message.body.mid.length <= 200
            ? { body: { mid: event.message.body.mid } }
            : {}),
        },
      };
    }
    if (event.user?.is_bot !== false || event.is_channel === true)
      throw fail(400, 'Требуется личный пользователь MAX.');
    const user = { user_id: maxId(event.user.user_id), is_bot: false };
    if (event.update_type === 'bot_stopped') return { ...base, user };
    if (!event.payload) return null;
    if (typeof event.payload !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.payload))
      throw fail(400, 'Некорректная ссылка подключения MAX.');
    return { ...base, user, payload: event.payload };
  }
  function process(event) {
    // Revalidate when draining a durable event, not only at HTTP acceptance.
    event = normalize(event);
    if (!event) return { ignored: true };
    if (event.update_type === 'message_callback') {
      if (!coordinator) return { ignored: true };
      const receipt = coordinator.confirm('max', event.callback.payload.slice(8), {
        botId: maxId(botId),
        userId: event.callback.user.user_id,
      });
      return {
        callbackId: event.callback.callback_id,
        ...(typeof event.message.body?.mid === 'string'
          ? { messageId: event.message.body.mid }
          : {}),
        confirmed: Boolean(receipt),
        ...(event.message.contactUrl ? { contactUrl: event.message.contactUrl } : {}),
        notification: confirmationReply(Boolean(receipt)),
      };
    }
    if (event.update_type === 'bot_stopped') {
      const stopped = connections.stopped(event.user.user_id, event.timestamp);
      if (staff) staff.stopped(event.user.user_id, event.timestamp);
      return { stopped };
    }
    // Distinct capabilities: a staff invitation can never bind a client card.
    if (event.payload.startsWith('staff_'))
      return staff
        ? staff.consumeStarted(event.payload, event.user.user_id, event.timestamp)
        : { ignored: true };
    return connections.consumeStarted(event.payload, event.user.user_id, event.timestamp);
  }
  function receive(header, event) {
    authenticate(header);
    return process(event);
  }
  return { authenticate, normalize, process, receive };
}
module.exports = { createMaxEvents };
