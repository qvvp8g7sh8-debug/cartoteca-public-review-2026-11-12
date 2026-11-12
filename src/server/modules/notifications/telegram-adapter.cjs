const { fail } = require('../../../shared/errors.cjs');
function configuredTelegram({
  token = process.env.TELEGRAM_BOT_TOKEN || '',
  fetchImpl = fetch,
} = {}) {
  if (!token) return null;
  if (!/^\d+:[A-Za-z0-9_-]{20,150}$/.test(token)) throw Error('Invalid TELEGRAM_BOT_TOKEN format.');
  async function call(method, body = {}, signal) {
    let response, data;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(35000)])
          : AbortSignal.timeout(35000),
      });
      data = await response.json();
    } catch {
      const error = fail(503, 'Telegram недоступен. Проверьте подключение к интернету.');
      error.deliveryUncertain = method === 'sendMessage';
      throw error;
    }
    if (!response.ok || !data.ok) {
      const error = fail(
        data.error_code === 403 ? 403 : data.error_code === 429 ? 429 : 503,
        'Telegram не принял запрос.',
      );
      error.providerCode = Number(data.error_code) || 0;
      error.deliveryUncertain =
        method === 'sendMessage' &&
        (response.status >= 500 || ![400, 401, 403, 429].includes(Number(data.error_code)));
      const retryAfter = Number(data.parameters?.retry_after);
      error.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 30;
      throw error;
    }
    return data.result;
  }
  return {
    async initialize(signal) {
      const me = await call('getMe', {}, signal),
        webhook = await call('getWebhookInfo', {}, signal);
      if (webhook.url)
        throw fail(
          409,
          'У бота включён webhook. Для локального подключения нужен отдельный бот без webhook.',
        );
      if (!me.is_bot || !/^\w{5,64}$/.test(me.username || ''))
        throw fail(503, 'Не удалось определить Telegram-бота.');
      return {
        username: me.username,
        botId: Number.isSafeInteger(me.id) && me.id > 0 ? String(me.id) : '',
      };
    },
    updates(offset, signal) {
      return call(
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['message', 'callback_query', 'my_chat_member'] },
        signal,
      );
    },
    send(chatId, text, replyMarkup, signal) {
      return call(
        'sendMessage',
        { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) },
        signal,
      );
    },
    clearButtons(chatId, messageId, signal, contactUrl = '') {
      if (
        !/^[1-9]\d{0,19}$/.test(String(chatId)) ||
        !Number.isSafeInteger(messageId) ||
        messageId <= 0
      )
        throw fail(400, 'Некорректное сообщение Telegram.');
      return call(
        'editMessageReplyMarkup',
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard:
              contactUrl.startsWith('https://wa.me/') &&
              /^[1-9]\d{6,14}$/.test(contactUrl.slice(14))
                ? [[{ text: 'Связаться', url: contactUrl }]]
                : [],
          },
        },
        signal,
      );
    },
    answer(id, text, signal) {
      return call('answerCallbackQuery', { callback_query_id: id, text, show_alert: true }, signal);
    },
  };
}
module.exports = { configuredTelegram };
