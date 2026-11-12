const routes = [
  {
    method: 'GET',
    path: '/api/service-groups',
    access: 'organization',
    handle(c) {
      return c.json(c.res, 200, c.platform.serviceGroups(c.current.organizationId));
    },
  },
  {
    method: 'POST',
    path: '/api/service-groups',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 201, c.platform.createServiceGroup(c.token, await c.readBody(c.req)));
    },
  },
  {
    method: 'DELETE',
    path: '/api/service-groups',
    access: 'organization',
    async handle(c) {
      const values = await c.readBody(c.req, 1024);
      const next = c.platform.deleteServiceGroup(
        c.token,
        values,
        (organizationId) => c.tenantStore(organizationId).readServices(),
        c.assertCurrent,
      );
      return c.json(c.res, 200, next);
    },
  },
];
module.exports = { routes };
