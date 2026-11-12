const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { bookingPreview } = require('./preview.cjs');
const { submitRequest, listRequests, requestSummary, rejectRequest } = require('./requests.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { acceptRequest } = require('./acceptance.cjs');
const { requestContacts } = require('./contacts.cjs');
const QRCode = require('qrcode');
const { proposalOptions, propose, proposalLink } = require('./proposals.cjs');
const { requestTimeOptions } = require('./request-time.cjs');
const { privateBookingHealth } = require('./readiness.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/online-booking/health',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, await privateBookingHealth(c));
    },
  },
  {
    method: 'GET',
    path: '/api/online-booking/requests/summary',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, requestSummary(c.platform, c.token));
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/requests/time-options',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, requestTimeOptions(c, await c.readBody(c.req)));
    },
  },
  {
    method: 'GET',
    path: '/api/online-booking/requests/proposal-link',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, proposalLink(c, c.url.searchParams.get('id')));
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/requests/proposal-options',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, proposalOptions(c, await c.readBody(c.req)));
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/requests/propose',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, propose(c, await c.readBody(c.req)));
    },
  },
  {
    method: 'GET',
    path: '/api/online-booking/qr',
    access: 'organization',
    async handle(c) {
      const publication = c.platform.bookingPublication.view(c.token),
        staff = c.url.searchParams.get('staff');
      if (!publication.canManage || !publication.enabled)
        throw fail(403, 'Публичная запись выключена или недоступна.');
      if (
        staff &&
        !c.platform.bookingPublication.members(c.current.organizationId).some((m) => m.id === staff)
      )
        throw fail(400, 'Сотрудник недоступен.');
      const staffPath = staff && publication.staffPaths?.[staff];
      const url = new URL(staffPath || publication.path, c.expectedOrigin);
      if (staff && !staffPath) url.searchParams.set('staff', staff);
      const dataUrl = await QRCode.toDataURL(url.href, {
        width: 220,
        margin: 2,
      });
      c.assertCurrent();
      const latest = c.platform.bookingPublication.view(c.token);
      if (!latest.enabled || latest.revision !== publication.revision)
        throw fail(409, 'Настройки изменились.');
      if (
        staff &&
        !c.platform.bookingPublication.members(c.current.organizationId).some((m) => m.id === staff)
      )
        throw fail(409, 'Сотрудник больше не принимает по онлайн-записи.');
      return c.json(c.res, 200, { dataUrl });
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/publication',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(c.res, 200, c.platform.bookingPublication.save(c.token, body));
    },
  },
  {
    method: 'GET',
    path: '/api/online-booking/requests/contacts',
    access: 'organization',
    async handle(c) {
      return c.json(c.res, 200, requestContacts(c, c.url.searchParams.get('id')));
    },
  },
  {
    method: 'GET',
    path: '/api/online-booking/requests',
    access: 'organization',
    async handle(c) {
      const value = c.url.searchParams.get('cursor');
      let cursor = null;
      if (value) {
        try {
          cursor = JSON.parse(value);
        } catch {
          throw fail(400, 'Некорректная страница заявок.');
        }
      }
      return c.json(c.res, 200, listRequests(c.platform, c.token, cursor));
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/requests',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(
        c.res,
        200,
        submitRequest(
          c.platform,
          c.token,
          c.tenantStore(c.current.organizationId),
          body,
          Date.now(),
          c.current.organizationId,
        ),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/requests/reject',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(
        c.res,
        200,
        rejectRequest(
          c.platform,
          c.token,
          body,
          Date.now(),
          c.tenantStore(c.current.organizationId),
        ),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/requests/accept',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(c.res, 200, await acceptRequest(c, body));
    },
  },
  {
    method: 'GET',
    path: '/api/online-booking/settings',
    access: 'organization',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.platform.withWriteLock(() => {
          c.assertCurrent();
          const settings = c.platform.onlineBooking.view(c.token);
          const services = settings.canManage
            ? c
                .tenantStore(c.current.organizationId)
                .readServices()
                .map((s) => ({
                  id: s.id,
                  name: s.name,
                  duration: s.duration ?? 60,
                  staffId: s.staffId || c.platform.serviceCatalog(c.current.organizationId).ownerId,
                }))
            : [];
          if (settings.canManage)
            c.platform.bookingPublication.reconcileInTransaction(c.current.organizationId);
          return {
            ...settings,
            catalog: services,
            publication: c.platform.bookingPublication.view(c.token),
          };
        }),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/settings',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(
        c.res,
        200,
        c.platform.onlineBooking.save(
          c.token,
          body,
          new Set(
            c
              .tenantStore(c.current.organizationId)
              .readServices()
              .map((s) => s.id),
          ),
        ),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/online-booking/preview',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      return c.json(
        c.res,
        200,
        compoundMutation(
          c.platform,
          c.tenantStore(c.current.organizationId),
          c.current.organizationId,
          'booking',
          () => {
            c.assertCurrent();
            return bookingPreview(
              c.platform,
              c.token,
              c.tenantStore(c.current.organizationId),
              body,
            );
          },
        ),
      );
    },
  },
];
module.exports = { routes };
