const { fail } = require('../../../shared/errors.cjs');
const { previewMessage } = require('./telegram-messages.cjs');
function manager(c) {
  if (!['owner', 'salon_admin'].includes(c.current.role))
    throw fail(403, 'Настройки напоминаний доступны владельцу и администратору.');
}
function snapshot(c, settings = c.platform.telegram.settings(c.current.organizationId)) {
  const telegram = previewMessage(
    c.platform.telegram.messageIdentity(c.current.organizationId),
    settings,
  );
  return {
    settings,
    bot: c.telegram.status(),
    max: c.maxRuntime.status(),
    preview: telegram,
    maxPreview: telegram.replace(
      '\nПоказ услуг: /privacy\nОтключить уведомления: /stop',
      '\nОтключить уведомления можно, остановив бота MAX.',
    ),
  };
}
const routes = [
  {
    method: 'GET',
    path: '/api/notifications/reminders',
    access: 'organization',
    async handle(c) {
      manager(c);
      return c.json(c.res, 200, snapshot(c));
    },
  },
  {
    method: 'POST',
    path: '/api/notifications/reminders',
    access: 'organization',
    async handle(c) {
      manager(c);
      const values = await c.readBody(c.req);
      c.assertCurrent();
      manager(c);
      const settings = c.platform.telegram.saveReminderPeriod(
        c.current.organizationId,
        c.current.accountId,
        values,
      );
      return c.json(c.res, 200, snapshot(c, settings));
    },
  },
];
module.exports = { routes };
