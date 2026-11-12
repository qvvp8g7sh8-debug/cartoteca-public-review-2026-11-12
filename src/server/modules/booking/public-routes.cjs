const {
  publicInfo,
  publicAvailability,
  publicDates,
  publicSubmit,
} = require('./public-service.cjs');
const { inspectProposal, respondProposal } = require('./proposals.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { bookingTimingAsync } = require('./timing.cjs');
async function budget(c) {
  await bookingTimingAsync(c, 'booking-read-budget', () =>
    c.platform.bookingPublicLimits.consumeReadAsync(c.clientAddress(c.req), {
      cancelled: () => Boolean(c.req.aborted || c.res.destroyed),
    }),
  );
  return c.url.searchParams.get('organization');
}
const routes = [
  {
    method: 'POST',
    path: '/api/public-booking/proposal',
    access: 'public',
    async handle(c) {
      await budget(c);
      const body = await c.readBody(c.req);
      if (!body || Object.keys(body).some((k) => k !== 'secret'))
        throw fail(400, 'Некорректное предложение.');
      return c.json(c.res, 200, inspectProposal(c, body.secret));
    },
  },
  {
    method: 'POST',
    path: '/api/public-booking/proposal-response',
    access: 'public',
    async handle(c) {
      await budget(c);
      return c.json(c.res, 200, respondProposal(c, await c.readBody(c.req)));
    },
  },
  {
    method: 'GET',
    path: '/api/public-booking/info',
    access: 'public',
    async handle(c) {
      const org = await budget(c);
      if (!c.url.searchParams.has('link')) return c.json(c.res, 200, publicInfo(c, org));
      if (
        c.url.searchParams.getAll('link').length !== 1 ||
        c.url.searchParams.has('organization') ||
        c.url.searchParams.has('staff')
      )
        throw fail(400, 'Некорректная ссылка онлайн-записи.');
      const target = c.platform.bookingShortLinks.resolve(c.url.searchParams.get('link'));
      // The address is not an access capability: normal publication and tenant
      // checks still run, including the contact-only page for paused booking.
      const info = publicInfo(c, target.organizationId);
      if (
        target.staffId &&
        info.health.available &&
        !info.members.some((member) => member.id === target.staffId)
      )
        throw fail(404, 'Онлайн-запись недоступна.');
      return c.json(c.res, 200, { ...info, selectedStaffId: target.staffId });
    },
  },
  {
    method: 'GET',
    path: '/api/public-booking/dates',
    access: 'public',
    async handle(c) {
      const org = await budget(c);
      return c.json(
        c.res,
        200,
        publicDates(c, org, c.url.searchParams.get('month'), c.url.searchParams.get('staffId')),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/public-booking/availability',
    access: 'public',
    async handle(c) {
      const org = await budget(c),
        body = await c.readBody(c.req);
      return c.json(c.res, 200, publicAvailability(c, org, body));
    },
  },
  {
    method: 'POST',
    path: '/api/public-booking/requests',
    access: 'public',
    async handle(c) {
      const org = await budget(c),
        body = await c.readBody(c.req);
      return c.json(c.res, 200, publicSubmit(c, org, body));
    },
  },
];
module.exports = { routes };
