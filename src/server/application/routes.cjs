// One registry for HTTP composition and generated route documentation.
const routeGroups = [
  {
    file: 'src/server/modules/billing/routes.cjs',
    routes: require('../modules/billing/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/assistant/routes.cjs',
    routes: require('../modules/assistant/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/booking/notification-target-routes.cjs',
    routes: require('../modules/booking/notification-target-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/history-routes.cjs',
    routes: require('../modules/notifications/history-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/email-test-routes.cjs',
    routes: require('../modules/notifications/email-test-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/calendar/subscription-routes.cjs',
    routes: require('../modules/calendar/subscription-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/calendar/routes.cjs',
    routes: require('../modules/calendar/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/push-routes.cjs',
    routes: require('../modules/notifications/push-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/staff-max-routes.cjs',
    routes: require('../modules/notifications/staff-max-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/client-reminder-routes.cjs',
    routes: require('../modules/notifications/client-reminder-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/max-webhook-routes.cjs',
    routes: require('../modules/notifications/max-webhook-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/max-routes.cjs',
    routes: require('../modules/notifications/max-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/staff-routes.cjs',
    routes: require('../modules/notifications/staff-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/booking/public-routes.cjs',
    routes: require('../modules/booking/public-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/booking/routes.cjs',
    routes: require('../modules/booking/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/schedules/routes.cjs',
    routes: require('../modules/schedules/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/support/routes.cjs',
    routes: require('../modules/support/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/auth/routes.cjs',
    routes: require('../modules/auth/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/admin/routes.cjs',
    routes: require('../modules/admin/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/organizations/routes.cjs',
    routes: require('../modules/organizations/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/services/routes.cjs',
    routes: require('../modules/services/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/cabinet/routes.cjs',
    routes: require('../modules/cabinet/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/cabinet/queries.cjs',
    routes: require('../modules/cabinet/queries.cjs').routes,
  },
  {
    file: 'src/server/modules/cabinet/confirmation-routes.cjs',
    routes: require('../modules/cabinet/confirmation-routes.cjs').routes,
  },
  {
    file: 'src/server/modules/notifications/routes.cjs',
    routes: require('../modules/notifications/routes.cjs').routes,
  },
  {
    file: 'src/server/modules/workspace/routes.cjs',
    routes: require('../modules/workspace/routes.cjs').routes,
  },
];
const routes = routeGroups.flatMap((group) => group.routes);
const unique = new Set();
for (const route of routes) {
  const key = route.method + ' ' + route.path;
  if (
    unique.has(key) ||
    !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(route.method) ||
    typeof route.path !== 'string' ||
    !route.path.startsWith('/api/') ||
    !['public', 'session', 'organization', 'global'].includes(route.access) ||
    typeof route.handle !== 'function'
  )
    throw Error('Invalid or duplicate HTTP route: ' + key);
  unique.add(key);
}
module.exports = { routeGroups, routes };
