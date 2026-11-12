const { fail } = require('../../../shared/errors.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/max/staff',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, c.staffMax.status(c.token));
    },
  },
  {
    method: 'POST',
    path: '/api/max/staff/link',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw fail(400, 'Подключайте MAX только в своём аккаунте.');
      c.assertCurrent();
      return c.json(c.res, 200, c.staffMax.issue(c.token));
    },
  },
  ...['settings', 'unlink'].map((action) => ({
    method: 'POST',
    path: '/api/max/staff/' + action,
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      c.assertCurrent();
      return c.json(c.res, 200, c.staffMax.update(c.token, body, action === 'unlink'));
    },
  })),
  {
    method: 'POST',
    path: '/api/max/staff/test',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      c.assertCurrent();
      const status = c.staffMax.status(c.token);
      if (!status.bot?.connected || !status.compatible)
        throw fail(503, 'Подключите свой MAX и проверьте доступность бота.');
      return c.json(c.res, 202, c.platform.staffMaxNotifications.test(c.token, body));
    },
  },
];
module.exports = { routes };
