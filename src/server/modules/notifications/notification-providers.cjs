const { createTelegramPacing } = require('./telegram-pacing.cjs');
const { fail } = require('../../../shared/errors.cjs');

// Construction performs no provider requests. Both transports share the queue port.
function createNotificationProviders({
  telegramBot = null,
  telegramStatus,
  telegramPacing,
  maxBot = null,
  maxIdentity = null,
  maxPacing = createTelegramPacing(),
}) {
  return {
    telegram: {
      status: () => ({
        configured: Boolean(telegramBot),
        connected: Boolean(telegramStatus().connected),
        botId: telegramStatus().botId || '',
      }),
      acquire: (recipient, signal) =>
        (telegramPacing.acquireDelivery || telegramPacing.acquire).call(
          telegramPacing,
          recipient.chatId,
          signal,
          1000,
        ),
      release: (recipient) => telegramPacing.releaseDelivery?.(recipient.chatId),
      pause: (delay) => telegramPacing.pause(delay),
      async send({ recipient, text, confirmationToken, contactUrl = '', signal }) {
        const buttons = [];
        if (confirmationToken)
          buttons.push([
            { text: 'Подтвердить запись', callback_data: 'confirm_' + confirmationToken },
          ]);
        if (
          contactUrl &&
          contactUrl.startsWith('https://wa.me/') &&
          /^[1-9]\d{6,14}$/.test(contactUrl.slice(14))
        )
          buttons.push([{ text: 'Связаться', url: contactUrl }]);
        const message = await telegramBot.send(
          recipient.chatId,
          text,
          buttons.length ? { inline_keyboard: buttons } : null,
          signal,
        );
        if (!Number.isSafeInteger(message?.message_id)) {
          const error = fail(503, 'Telegram не подтвердил результат отправки.');
          error.deliveryUncertain = true;
          throw error;
        }
        return message;
      },
    },
    max: {
      status: () => ({
        configured: Boolean(maxBot && maxIdentity),
        connected: Boolean(maxBot && maxIdentity),
        botId: maxIdentity?.botId || '',
      }),
      acquire: (recipient, signal) =>
        (maxPacing.acquireDelivery || maxPacing.acquire).call(
          maxPacing,
          recipient.botId + ':' + recipient.userId,
          signal,
          1000,
        ),
      release: (recipient) => maxPacing.releaseDelivery?.(recipient.botId + ':' + recipient.userId),
      pause: (delay) => maxPacing.pause(delay),
      send: (values) => maxBot.send(values),
    },
  };
}
module.exports = { createNotificationProviders };
