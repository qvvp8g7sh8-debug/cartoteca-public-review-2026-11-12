const { fail } = require('../../../shared/errors.cjs');
function body(values, keys) {
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    Object.keys(values).some((key) => !keys.includes(key))
  )
    throw fail(400, 'Некорректные параметры связи с клиентом.');
  return values;
}
const routes = [
  {
    method: 'POST',
    path: '/api/notifications/appointment-preference',
    access: 'organization',
    async handle(c) {
      const values = body(await c.readBody(c.req), [
        'patientId',
        'appointmentId',
        'preference',
        'expectedRevision',
        'expectedFingerprint',
      ]);
      return c.json(
        c.res,
        200,
        c.maxConnections.saveAppointmentPreference(c.current, values, c.assertCurrent),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/max/patient',
    access: 'organization',
    async handle(c) {
      return c.json(
        c.res,
        200,
        c.maxConnections.status(
          c.current,
          c.url.searchParams.get('patientId'),
          c.url.searchParams.get('view') === 'card' ? c.url : null,
        ),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/max/link',
    access: 'organization',
    async handle(c) {
      const values = body(await c.readBody(c.req), ['patientId']);
      return c.json(
        c.res,
        200,
        await c.maxConnections.invitation(c.current, values.patientId, c.assertCurrent),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/max/unlink',
    access: 'organization',
    async handle(c) {
      const values = body(await c.readBody(c.req), ['patientId', 'bindingId']);
      return c.json(c.res, 200, c.maxConnections.disconnect(c.current, values, c.assertCurrent));
    },
  },
  {
    method: 'POST',
    path: '/api/notifications/preference',
    access: 'organization',
    async handle(c) {
      const values = body(await c.readBody(c.req), ['patientId', 'preference', 'expectedRevision']);
      return c.json(
        c.res,
        200,
        c.maxConnections.savePreference(c.current, values, c.assertCurrent),
      );
    },
  },
];
module.exports = { routes };
