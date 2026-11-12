const { fail } = require('../../../shared/errors.cjs');
function store(c) {
  c.platform.onlineBooking.actor(c.token);
  if (!c.platform.staffPush || !c.staffPush.available)
    throw fail(503, 'Пуш-уведомления ещё не включены на сервере.');
  return c.platform.staffPush;
}
const routes = [
  {
    method: 'POST',
    path: '/api/push/staff/status',
    access: 'organization',
    async handle(c) {
      c.platform.onlineBooking.actor(c.token);
      const body = await c.readBody(c.req);
      c.assertCurrent();
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => k !== 'endpoint') ||
        (body.endpoint !== undefined &&
          (typeof body.endpoint !== 'string' || body.endpoint.length > 4096))
      )
        throw fail(400, 'Некорректное устройство.');
      const value = c.platform.staffPush?.status(c.token, body.endpoint);
      return c.json(
        c.res,
        200,
        c.platform.staffPush
          ? {
              ...value,
              available: c.staffPush.available && value.available,
            }
          : { prepared: false, available: false, device: null },
      );
    },
  },
  {
    method: 'POST',
    path: '/api/push/staff/connect',
    access: 'organization',
    async handle(c) {
      const s = store(c),
        body = await c.readBody(c.req);
      c.assertCurrent();
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => !['subscription', 'bindingExpectation'].includes(k)) ||
        typeof body.bindingExpectation !== 'string'
      )
        throw fail(400, 'Обновите статус устройства перед подключением уведомлений.');
      return c.json(c.res, 200, s.connect(c.token, body.subscription, body.bindingExpectation));
    },
  },
  {
    method: 'POST',
    path: '/api/push/staff/settings',
    access: 'organization',
    async handle(c) {
      const s = store(c),
        body = await c.readBody(c.req);
      c.assertCurrent();
      return c.json(c.res, 200, s.update(c.token, body));
    },
  },
  {
    method: 'POST',
    path: '/api/push/staff/disconnect',
    access: 'organization',
    async handle(c) {
      c.platform.onlineBooking.actor(c.token);
      if (!c.platform.staffPush) throw fail(503, 'Подключение ещё не подготовлено.');
      const body = await c.readBody(c.req);
      c.assertCurrent();
      return c.json(c.res, 200, c.platform.staffPush.update(c.token, body, true));
    },
  },
  {
    method: 'POST',
    path: '/api/push/staff/test',
    access: 'organization',
    async handle(c) {
      const s = store(c),
        body = await c.readBody(c.req);
      c.assertCurrent();
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => k !== 'deviceId') ||
        typeof body.deviceId !== 'string'
      )
        throw fail(400, 'Укажите устройство.');
      return c.json(c.res, 200, s.test(c.token, body.deviceId));
    },
  },
];
module.exports = { routes };
