const routes = [
  {
    method: 'POST',
    path: '/api/calendar/personal-event',
    access: 'organization',
    async handle(c) {
      const values = await c.readBody(c.req, 16 * 1024);
      const saved = await c.platform.personalEvents.save(
        c.token,
        values,
        c.tenantStore(c.current.organizationId),
        c.current.organizationId,
        () => c.assertCurrent(),
      );
      return c.json(c.res, 200, saved);
    },
  },
  {
    method: 'DELETE',
    path: '/api/calendar/personal-event',
    access: 'organization',
    async handle(c) {
      const values = await c.readBody(c.req, 16 * 1024);
      const saved = await c.platform.personalEvents.remove(
        c.token,
        values,
        c.current.organizationId,
        () => c.assertCurrent(),
      );
      return c.json(c.res, 200, saved);
    },
  },
];
module.exports = { routes };
