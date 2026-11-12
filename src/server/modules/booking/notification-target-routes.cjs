const { fail } = require('../../../shared/errors.cjs');
const { requestView } = require('./request-input.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/online-booking/requests/item',
    access: 'organization',
    async handle(c) {
      const ids = c.url.searchParams.getAll('id');
      if (
        ids.length !== 1 ||
        !ids[0] ||
        ids[0].length > 120 ||
        [...c.url.searchParams.keys()].some((key) => key !== 'id')
      )
        throw fail(400, 'Укажите заявку.');
      const result = c.platform.withReadSnapshot(() => {
        c.assertCurrent();
        const actor = c.platform.onlineBooking.actor(c.token),
          record = c.platform.bookingRequests.get(actor.organizationId, ids[0]);
        if (!record || (actor.role === 'cosmetologist' && record.staffId !== actor.accountId))
          throw fail(404, 'Заявка не найдена.');
        return requestView(record);
      });
      return c.json(c.res, 200, { item: result });
    },
  },
];
module.exports = { routes };
