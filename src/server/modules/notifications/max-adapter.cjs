const { fail } = require('../../../shared/errors.cjs');

const API_ORIGIN = 'https://platform-api2.max.ru';
const capabilityPattern = /^[A-Za-z0-9_-]{20,80}$/;

// Node >=24 exposes the original JSON number before IEEE-754 rounding.
// Only provider IDs become strings; timestamps and all browser JSON stay unchanged.
function maxJSONReviver(key, value, context) {
  if (['user_id', 'chat_id'].includes(key) && typeof value === 'number') {
    if (!context || !/^[1-9]\d{0,18}$/.test(context.source))
      throw fail(400, 'Некорректный числовой идентификатор MAX.');
    return maxId(context.source);
  }
  return value;
}

function maxId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw fail(400, 'Идентификатор MAX должен передаваться без потери точности.');
  if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d{0,18}$/.test(String(value)))
    throw fail(400, 'Некорректный идентификатор MAX.');
  if (BigInt(value) > 9223372036854775807n) throw fail(400, 'Некорректный идентификатор MAX.');
  return String(value);
}

function maxInvitationLink(username, capability) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(username))
    throw fail(400, 'Некорректное имя MAX-бота.');
  if (typeof capability !== 'string' || !capabilityPattern.test(capability))
    throw fail(400, 'Некорректная ссылка подключения MAX.');
  const url = new URL(`https://max.ru/${username}`);
  url.searchParams.set('start', capability);
  return url.href;
}

// No environment reads, autostart, webhook registration or production composition.
// Even with a token, an explicit enabled:true is required; construction makes no request.
function configuredMax({ enabled = false, token = '', fetchImpl = fetch } = {}) {
  if (enabled !== true || !token) return null;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(token))
    throw fail(400, 'Некорректный токен MAX.');
  if (typeof fetchImpl !== 'function') throw fail(500, 'Не настроен транспорт MAX.');
  let initializedBotId = '';

  function providerError(status, retryAfter = 30, uncertain = false) {
    const error = fail(
      [400, 401, 403, 429].includes(status) ? status : 503,
      'MAX не принял запрос или не подтвердил результат. Проверьте состояние канала.',
    );
    error.providerStatus = status;
    error.retryAfter = Math.min(3600, Math.max(1, retryAfter));
    error.deliveryUncertain = uncertain;
    return error;
  }

  async function call(path, { method = 'GET', body, query = {}, signal } = {}) {
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url.href, {
        method,
        redirect: 'error',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
    } catch (cause) {
      const error = providerError(0, 30, method === 'POST');
      if (
        [
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          'SELF_SIGNED_CERT_IN_CHAIN',
          'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
          'CERT_HAS_EXPIRED',
        ].includes(cause?.cause?.code || cause?.code)
      )
        error.safeReason = 'tls_certificate';
      else error.safeReason = 'network';
      throw error;
    }
    if (!response.ok) {
      const retry = Number(response.headers?.get('retry-after'));
      throw providerError(
        response.status,
        Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 30,
        method === 'POST' && response.status >= 500,
      );
    }
    let data;
    try {
      data =
        typeof response.text === 'function'
          ? JSON.parse(await response.text(), maxJSONReviver)
          : await response.json();
    } catch {
      throw providerError(response.status, 30, method === 'POST');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.success === false)
      throw providerError(response.status, 30, method === 'POST');
    return data;
  }

  return {
    async subscriptions(signal) {
      if (!initializedBotId) throw fail(409, 'Сначала определите MAX-бота.');
      const data = await call('/subscriptions', { signal });
      if (!Array.isArray(data.subscriptions)) throw providerError(200);
      return data.subscriptions;
    },
    async subscribe(url, secret, signal) {
      if (!initializedBotId) throw fail(409, 'Сначала определите MAX-бота.');
      let target;
      try {
        target = new URL(url);
      } catch {
        throw fail(400, 'Некорректный адрес событий MAX.');
      }
      if (
        target.protocol !== 'https:' ||
        target.port ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        target.pathname !== '/api/max/webhook' ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(target.hostname) ||
        target.hostname.endsWith('.localhost') ||
        /^\d+(?:\.\d+){3}$/.test(target.hostname) ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(secret)
      )
        throw fail(400, 'Нужны публичный HTTPS-адрес и защищённый секрет MAX.');
      const result = await call('/subscriptions', {
        method: 'POST',
        signal,
        body: {
          url: target.href,
          secret,
          update_types: ['bot_started', 'bot_stopped', 'message_callback'],
        },
      });
      if (result.success !== true) throw providerError(200, 30, true);
      return true;
    },
    async answer(callbackId, text, signal) {
      if (!initializedBotId) throw fail(409, 'Сначала определите MAX-бота.');
      if (
        typeof callbackId !== 'string' ||
        !callbackId.trim() ||
        callbackId.length > 256 ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 200
      )
        throw fail(400, 'Некорректный ответ MAX.');
      const result = await call('/answers', {
        method: 'POST',
        query: { callback_id: callbackId },
        body: { notification: text },
        signal,
      });
      if (result.success !== true) throw providerError(200, 30, true);
      return true;
    },
    async initialize(signal) {
      initializedBotId = '';
      const me = await call('/me', { signal });
      if (me.is_bot !== true) throw fail(503, 'Не удалось определить MAX-бота.');
      const botId = maxId(me.user_id);
      const username = typeof me.username === 'string' ? me.username : '';
      initializedBotId = botId;
      return Object.freeze({ botId, username });
    },
    async clearButtons(messageId, signal, contactUrl = '') {
      if (!initializedBotId) throw fail(409, 'Сначала определите MAX-бота.');
      if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 200)
        throw fail(400, 'Некорректное сообщение MAX.');
      return call('/messages', {
        method: 'PUT',
        query: { message_id: messageId },
        body: {
          attachments:
            contactUrl.startsWith('https://wa.me/') && /^[1-9]\d{6,14}$/.test(contactUrl.slice(14))
              ? [
                  {
                    type: 'inline_keyboard',
                    payload: { buttons: [[{ type: 'link', text: 'Связаться', url: contactUrl }]] },
                  },
                ]
              : [],
          notify: false,
        },
        signal,
      });
    },
    async send({ recipient, text, confirmationToken = '', link = null, contactUrl = '', signal }) {
      if (!initializedBotId) throw fail(409, 'Сначала определите MAX-бота.');
      if (!recipient || maxId(recipient.botId) !== initializedBotId)
        throw fail(409, 'Привязка относится к другому MAX-боту.');
      const userId = maxId(recipient.userId);
      if (typeof text !== 'string' || !text.trim() || [...text].length > 4000)
        throw fail(400, 'Некорректный текст уведомления MAX.');
      if (
        typeof confirmationToken !== 'string' ||
        (confirmationToken && !capabilityPattern.test(confirmationToken))
      )
        throw fail(400, 'Некорректная кнопка подтверждения MAX.');
      const buttons = [];
      if (confirmationToken)
        buttons.push([
          { type: 'callback', text: 'Подтвердить запись', payload: 'confirm_' + confirmationToken },
        ]);
      if (link) {
        let target;
        try {
          target = new URL(link.url);
        } catch {
          throw fail(400, 'Некорректная ссылка сообщения.');
        }
        if (
          target.protocol !== 'https:' ||
          target.username ||
          target.password ||
          typeof link.text !== 'string' ||
          !link.text.trim() ||
          link.text.length > 64
        )
          throw fail(400, 'Некорректная ссылка сообщения.');
        buttons.push([{ type: 'link', text: link.text, url: target.href }]);
      }
      if (contactUrl) {
        if (!(
          contactUrl.startsWith('https://wa.me/') && /^[1-9]\d{6,14}$/.test(contactUrl.slice(14))
        ))
          throw fail(400, 'Некорректный контакт организации.');
        buttons.push([{ type: 'link', text: 'Связаться', url: contactUrl }]);
      }
      const attachments = buttons.length ? [{ type: 'inline_keyboard', payload: { buttons } }] : [];
      const data = await call('/messages', {
        method: 'POST',
        query: { user_id: userId, disable_link_preview: true },
        body: { text, ...(attachments.length ? { attachments } : {}) },
        signal,
      });
      if (
        !data.message ||
        typeof data.message !== 'object' ||
        Array.isArray(data.message) ||
        typeof data.message.body?.mid !== 'string' ||
        !data.message.body.mid.trim()
      )
        throw providerError(200, 30, true);
      return data.message;
    },
  };
}

module.exports = { configuredMax, maxInvitationLink, maxId, maxJSONReviver };
