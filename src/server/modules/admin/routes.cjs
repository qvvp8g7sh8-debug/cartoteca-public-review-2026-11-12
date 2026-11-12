const mutations = [
  ['/api/admin/organizations/update', 'updateProfile', 'organizationId'],
  ['/api/admin/organizations/access', 'updateOrganizationAccess', 'organizationId'],
  ['/api/admin/subscriptions/update', 'updateSubscription', 'organizationId'],
  ['/api/admin/accounts/update', 'updateAccountAccess', 'accountId'],
  ['/api/admin/accounts/sessions/revoke', 'revokeSessions', 'accountId'],
  ['/api/admin/accounts/email/cancel', 'cancelEmailRecovery', 'accountId'],
];
const routes = [
  ...require('./read-routes.cjs').routes,
  ...mutations.map(([path, operation, identifier]) => ({
    method: 'POST',
    path,
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(
        c.res,
        200,
        c.platform.admin[operation](c.current.accountId, body[identifier], body),
      );
    },
  })),
  {
    method: 'POST',
    path: '/api/admin/accounts/email',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req);
      c.assertMailAvailable();
      await c.platform.admin.verifyActor(
        c.current.accountId,
        body.password,
        c.clientAddress(c.req),
      );
      c.assertCurrent();
      const { password, ...input } = body;
      const result = c.platform.admin.prepareEmailRecovery(
        c.current.accountId,
        body.accountId,
        input,
        c.expectedOrigin,
      );
      return c.json(c.res, 202, result);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/confirm-email-change',
    access: 'public',
    async handle(c) {
      const body = await c.readBody(c.req);
      c.platform.admin.consumeConfirmation(c.clientAddress(c.req));
      return c.json(c.res, 200, c.platform.admin.confirmEmailRecovery(body.token));
    },
  },
  {
    method: 'POST',
    path: '/api/admin/support/update',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(
        c.res,
        200,
        c.platform.admin.support.update(c.current.accountId, body.caseId, body),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/admin/support/message',
    access: 'global',
    async handle(c) {
      const body = await c.readBody(c.req);
      if (body.kind === 'reply') c.assertMailAvailable();
      return c.json(
        c.res,
        200,
        c.platform.admin.support.message(c.current.accountId, body.caseId, body),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/support/reply',
    access: 'session',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(
        c.res,
        200,
        c.platform.admin.support.authorReply(c.current.accountId, body.caseId, body),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/support/messages',
    access: 'session',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.admin.support.conversation(
          c.current.accountId,
          c.url.searchParams.get('id'),
          Object.fromEntries(c.url.searchParams),
          true,
        ),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/admin/bootstrap-status',
    access: 'public',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.globalAdminBootstrapStatus(c.url.searchParams.get('token')),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/admin/bootstrap',
    access: 'public',
    async handle(c) {
      const body = await c.readBody(c.req);
      await c.platform.consumeGlobalAdminBootstrap(body.token, body);
      return c.json(c.res, 201, { ok: true });
    },
  },
];
module.exports = { routes };
