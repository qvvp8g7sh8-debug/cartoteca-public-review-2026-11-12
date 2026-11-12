const { calendarPeriod } = require('../cabinet/queries.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/work-schedules',
    access: 'organization',
    handle(c) {
      const { from, to } = calendarPeriod(c.url);
      return c.json(
        c.res,
        200,
        c.platform.workSchedules.view(c.token, c.url.searchParams.get('staffId'), from, to),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/work-schedules',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      c.assertCurrent();
      return c.json(
        c.res,
        200,
        c.platform.workSchedules.save(c.token, body, c.tenantStore(c.current.organizationId)),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/work-schedules/permission',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(c.res, 200, c.platform.workSchedules.permission(c.token, body));
    },
  },
  {
    method: 'POST',
    path: '/api/work-schedules/calendar-settings',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(c.res, 200, c.platform.workSchedules.calendarSettings(c.token, body));
    },
  },
  {
    method: 'POST',
    path: '/api/work-schedules/check',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(c.res, 200, c.platform.workSchedules.check(c.token, body));
    },
  },
];
module.exports = { routes };
