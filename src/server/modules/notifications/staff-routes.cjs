const { fail } = require('../../../shared/errors.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/telegram/staff',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, {
        ...c.platform.staffNotifications.status(c.token),
        bot: c.telegram.status(),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/staff/link',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      if (!body || Object.keys(body).length)
        throw fail(400, 'Подключайте Telegram только в своём аккаунте.');
      const bot = c.telegram.status();
      if (!bot.connected || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username))
        throw fail(503, 'Бот сейчас недоступен. Подключите его на сервере.');
      const result = c.platform.staffNotifications.issue(c.token);
      return c.json(c.res, 200, {
        url: 'https://t.me/' + bot.username + '?start=staff_' + result.token,
        expiresAt: result.expiresAt,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/staff/test',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      c.assertCurrent();
      if (!c.telegram.status().connected) throw fail(503, 'Бот сейчас недоступен.');
      return c.json(c.res, 202, c.platform.staffNotifications.test(c.token, body));
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/staff/settings',
    access: 'organization',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.staffNotifications.update(c.token, await c.readBody(c.req)),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/staff/unlink',
    access: 'organization',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.staffNotifications.update(c.token, await c.readBody(c.req), true),
      );
    },
  },
];
module.exports = { routes };
