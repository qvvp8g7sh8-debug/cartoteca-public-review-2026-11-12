const { fail } = require('../../../shared/errors.cjs');
const routes = [
  {
    method: 'POST',
    path: '/api/notifications/email/test',
    access: 'session',
    async handle(c) {
      const body = await c.readBody(c.req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw fail(400, 'Пробное письмо отправляется только на почту вашего аккаунта.');
      c.assertCurrent();
      c.assertMailAvailable();
      const user = c.platform.session(c.token);
      if (!user?.accountId) throw fail(401, 'Войдите в картотеку.');
      const profile = c.platform.accountProfile(c.token),
        account = profile.account;
      const operationId =
        'notification-test:' + user.accountId + ':' + Math.floor(Date.now() / 60000);
      await c.platform.withWriteLock(() => {
        c.assertCurrent();
        const current = c.platform.session(c.token),
          fresh = c.platform.accountProfile(c.token).account;
        if (current?.accountId !== user.accountId || fresh.email !== account.email)
          throw fail(409, 'Аккаунт изменился. Повторите проверку.');
        c.platform.admin.emailQueue.enqueue(
          operationId,
          'notification-test',
          {
            actorId: user.accountId,
            accountId: user.accountId,
            email: account.email,
          },
          Date.now() + 3600000,
        );
      });
      return c.json(c.res, 202, { queued: true });
    },
  },
];
module.exports = { routes };
