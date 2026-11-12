const { calendarProvider } = require('./subscription.cjs');
const { fail } = require('../../../shared/errors.cjs');
function provider(c) {
  const values = c.url.searchParams.getAll('provider');
  if (values.length > 1) throw fail(400, 'Укажите один календарь.');
  return calendarProvider(values.length ? values[0] : undefined);
}
const routes = [
  {
    method: 'GET',
    path: '/api/calendar/subscription',
    access: 'organization',
    handle(c) {
      return c.json(c.res, 200, c.platform.calendarSubscription.status(c.token, provider(c)));
    },
  },
  {
    method: 'POST',
    path: '/api/calendar/subscription',
    access: 'organization',
    async handle(c) {
      const selected = provider(c);
      await c.readBody(c.req, 1024);
      return c.json(
        c.res,
        200,
        c.platform.calendarSubscription.connect(c.token, c.assertCurrent, selected),
      );
    },
  },
  {
    method: 'PUT',
    path: '/api/calendar/subscription',
    access: 'organization',
    async handle(c) {
      const selected = provider(c);
      const values = await c.readBody(c.req, 65536);
      return c.json(
        c.res,
        200,
        c.platform.calendarSubscription.updateSelection(c.token, c.assertCurrent, selected, values),
      );
    },
  },
  {
    method: 'DELETE',
    path: '/api/calendar/subscription',
    access: 'organization',
    async handle(c) {
      const selected = provider(c);
      await c.readBody(c.req, 1024);
      return c.json(
        c.res,
        200,
        c.platform.calendarSubscription.disconnect(c.token, c.assertCurrent, selected),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/calendar/feed.ics',
    access: 'public',
    handle(c) {
      const current = c.platform.calendarSubscription.resolve(
        c.url.searchParams.get('subscription'),
      );
      const result = c.calendarFeeds.read({
        current,
        storage: c.tenantStore(current.organizationId),
        platform: c.platform,
        ifNoneMatch: c.req.headers['if-none-match'],
      });
      // A different process may revoke access while the indexed snapshots are read.
      const latest = c.platform.calendarSubscription.resolve(
        c.url.searchParams.get('subscription'),
      );
      if (JSON.stringify(latest) !== JSON.stringify(current)) {
        const error = fail(503, 'Состав календаря изменился. Повторите обновление.');
        error.retryAfter = 1;
        throw error;
      }
      c.res.setHeader('ETag', result.etag);
      c.res.setHeader('Cache-Control', 'private, no-cache');
      if (result.unchanged) {
        c.res.writeHead(304);
        return c.res.end();
      }
      c.res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'private, no-cache',
        'Referrer-Policy': 'no-referrer',
        'Content-Disposition': 'inline; filename="cartoteca.ics"',
      });
      c.res.end(result.body);
    },
  },
];
module.exports = { routes };
