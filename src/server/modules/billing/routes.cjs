const routes = [
  {
    method: 'POST',
    path: '/api/billing/services/connection',
    access: 'organization',
    async handle(c) {
      const input = await c.readBody(c.req, 4096);
      c.assertCurrent();
      return c.json(c.res, 200, c.platform.billing.setConnection(c.current, input));
    },
  },
  {
    method: 'GET',
    path: '/api/billing',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, c.platform.billing.view(c.current));
    },
  },
  {
    method: 'POST',
    path: '/api/billing/services/voice-assistant',
    access: 'organization',
    async handle(c) {
      const input = await c.readBody(c.req, 4096);
      c.assertCurrent();
      const result = c.platform.billing.setConnection(c.current, input);
      return c.json(c.res, 200, { ...result, assistant: c.platform.assistant.access(c.current) });
    },
  },
  {
    method: 'POST',
    path: '/api/billing/checkout',
    access: 'organization',
    async handle(c) {
      const input = await c.readBody(c.req, 8192);
      c.assertCurrent();
      const result = await c.platform.billing.payments.beginCheckout(c.current, input, {
        assertCurrent: c.assertCurrent,
      });
      c.assertCurrent();
      return c.json(c.res, 200, result);
    },
  },
  {
    method: 'GET',
    path: '/api/billing/payment',
    access: 'organization',
    async handle(c) {
      const result = await c.platform.billing.payments.payment(
        c.current,
        c.url.searchParams.get('id'),
        { assertCurrent: c.assertCurrent },
      );
      c.assertCurrent();
      return c.json(c.res, 200, result);
    },
  },
  {
    method: 'POST',
    path: '/api/billing/yookassa/webhook',
    access: 'public',
    provider: 'yookassa',
    async handle(c) {
      const body = await c.readBody(c.req, 65536);
      await c.platform.billing.payments.webhook(body, c.req.headers);
      return c.json(c.res, 200, { received: true });
    },
  },
  {
    method: 'GET',
    path: '/api/admin/billing',
    access: 'global',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.billing.admin.view(c.current.accountId, Object.fromEntries(c.url.searchParams)),
      );
    },
  },
  ...['summary', 'organizations', 'orders'].map((action) => ({
    method: 'GET',
    path: '/api/admin/billing/' + action,
    access: 'global',
    async handle(c) {
      const input = Object.fromEntries(c.url.searchParams);
      return c.json(
        c.res,
        200,
        action === 'summary'
          ? c.platform.billing.admin.summary(c.current.accountId)
          : c.platform.billing.admin[action](c.current.accountId, input),
      );
    },
  })),
  {
    method: 'POST',
    path: '/api/admin/billing/payment-review',
    access: 'global',
    async handle(c) {
      const input = await c.readBody(c.req, 8192);
      c.assertCurrent();
      const result = await c.platform.billing.payments.review(c.current.accountId, input, {
        assertCurrent: c.assertCurrent,
      });
      c.assertCurrent();
      return c.json(c.res, 200, result);
    },
  },
  ...['financial-action', 'financial-action-check'].map((action) => ({
    method: 'POST',
    path: '/api/admin/billing/' + action,
    access: 'global',
    async handle(c) {
      const input = await c.readBody(c.req, 8192);
      c.assertCurrent();
      const method = action === 'financial-action' ? 'financialAction' : 'refreshFinancialAction';
      const operation = await c.platform.billing.payments[method](c.current.accountId, input, {
        assertCurrent: c.assertCurrent,
      });
      c.assertCurrent();
      return c.json(c.res, 200, { operation });
    },
  })),
  ...['package', 'trial', 'payment-settings'].map((action) => ({
    method: 'POST',
    path: '/api/admin/billing/' + action,
    access: 'global',
    async handle(c) {
      const input = await c.readBody(c.req, 16384);
      c.assertCurrent();
      return c.json(c.res, 200, c.platform.billing.admin[action](c.current.accountId, input));
    },
  })),
];
module.exports = { routes };
