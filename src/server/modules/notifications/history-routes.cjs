const { fail } = require('../../../shared/errors.cjs');
const { cabinetForUser } = require('../access/cabinet-policy.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/notifications/history',
    access: 'organization',
    async handle(c) {
      const params = c.url.searchParams;
      if ([...params.keys()].some((key) => !['patientId', 'appointmentId'].includes(key)))
        throw fail(400, 'Укажите карточку и запись.');
      const values = {};
      for (const key of ['patientId', 'appointmentId']) {
        const entries = params.getAll(key);
        if (entries.length !== 1 || !entries[0].trim() || entries[0].length > 120)
          throw fail(400, 'Укажите карточку и запись.');
        values[key] = entries[0];
      }
      const result = c.platform.withReadSnapshot(() => {
        c.assertCurrent();
        const current = c.requireCurrent();
        if (
          !current.organizationId ||
          !['owner', 'salon_admin', 'cosmetologist'].includes(current.role)
        )
          throw fail(403, 'Нет доступа к истории уведомлений.');
        const storage = c.tenantStore(current.organizationId),
          patient = cabinetForUser(current, storage.readSelected([values.patientId])).patients[0],
          appointment = patient?.appointments?.find((item) => item.id === values.appointmentId);
        // A removed or reassigned appointment must never become an ACL bypass.
        if (!appointment) throw fail(404, 'Запись не найдена.');
        if (!c.platform.notificationHistory)
          throw fail(503, 'История уведомлений пока недоступна.');
        return {
          ...values,
          ...c.platform.notificationHistory.read(
            current.organizationId,
            patient.id,
            appointment.id,
          ),
        };
      });
      return c.json(c.res, 200, result);
    },
  },
];
module.exports = { routes };
