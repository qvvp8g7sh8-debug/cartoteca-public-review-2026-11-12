const routes = [
  {
    method: 'GET',
    path: '/api/admin/overview',
    access: 'global',
    async handle(c) {
      return c.json(c.res, 200, c.platform.admin.overview(c.current.accountId));
    },
  },
  {
    method: 'GET',
    path: '/api/admin/operation',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.admin.operation(c.current.accountId, c.url.searchParams.get('requestId')),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/admin/organizations',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.admin.organizations(c.current.accountId, Object.fromEntries(c.url.searchParams)),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/admin/organization',
    access: 'global',
    async handle(c) {
      const result = c.platform.admin.organization(
        c.current.accountId,
        c.url.searchParams.get('id'),
      );
      return c.json(c.res, 200, { ...result, usage: c.organizationUsage(result.id) });
    },
  },
  {
    method: 'GET',
    path: '/api/admin/accounts',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.admin.accounts(c.current.accountId, Object.fromEntries(c.url.searchParams)),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/admin/account',
    access: 'global',
    async handle(c) {
      return c.json(c.res, 200, {
        ...c.platform.admin.account(c.current.accountId, c.url.searchParams.get('id')),
        mailConfigured: c.invitationMailConfigured,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/admin/audit',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.admin.audit(c.current.accountId, Object.fromEntries(c.url.searchParams)),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/admin/support',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.admin.support.page(c.current.accountId, Object.fromEntries(c.url.searchParams)),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/admin/support/case',
    access: 'global',
    async handle(c) {
      return c.json(c.res, 200, {
        ...c.platform.admin.support.detail(c.current.accountId, c.url.searchParams.get('id')),
        mailConfigured: c.invitationMailConfigured,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/admin/support/messages',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.admin.support.conversation(
          c.current.accountId,
          c.url.searchParams.get('id'),
          Object.fromEntries(c.url.searchParams),
        ),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/admin/system',
    access: 'global',
    async handle(c) {
      const { clientRelease } = require('../../http/client-release.cjs');
      const { root } = require('../../config.cjs');
      const { publicAssetRoot } = require('../../../shared/web-assets.cjs');
      const version = await clientRelease(publicAssetRoot(root));
      c.assertCurrent();
      const telegram = c.telegram.status(),
        support = c.support.status();
      return c.json(c.res, 200, {
        observedAt: Date.now(),
        version,
        backups: c.backupStatus(),
        queues: c.platform.admin.queues(c.current.accountId),
        mailConfigured: c.invitationMailConfigured,
        emailWorker: c.adminEmail.status(),
        support: {
          available: support.available,
          connected: support.connected,
          emailEnabled: support.emailEnabled,
        },
        telegram: { configured: telegram.configured, connected: telegram.connected },
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMegabytes: Math.round(process.memoryUsage().rss / 1048576),
      });
    },
  },
];
module.exports = { routes };
