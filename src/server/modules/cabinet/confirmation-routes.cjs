const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { compoundMutation } = require('./compound-mutation133.cjs');
const { cabinetForUser } = require('../access/cabinet-policy.cjs');
const { fingerprint, serviceFingerprint, startsAt } = require('../notifications/appointments.cjs');
const routes = [
  {
    method: 'POST',
    path: '/api/appointments/confirmation',
    access: 'organization',
    async handle(c) {
      const values = await c.readBody(c.req);
      if (
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        Object.keys(values).some(
          (k) => !['patientId', 'appointmentId', 'confirmed', 'expectedFingerprint'].includes(k),
        ) ||
        typeof values.confirmed !== 'boolean' ||
        !/^[a-f0-9]{64}$/.test(values.expectedFingerprint)
      )
        throw fail(400, 'Некорректное подтверждение записи.');
      for (const key of ['patientId', 'appointmentId'])
        if (typeof values[key] !== 'string' || !values[key] || values[key].length > 120)
          throw fail(400, 'Укажите карточку и запись.');
      const storage = c.tenantStore(c.current.organizationId);
      const result = compoundMutation(
        c.platform,
        storage,
        c.current.organizationId,
        'confirmation',
        () =>
          storage.transaction(() => {
            c.assertCurrent();
            const current = c.requireCurrent(),
              org = current.organizationId;
            if (!['owner', 'salon_admin', 'cosmetologist'].includes(current.role))
              throw fail(403, 'Нет доступа к подтверждению записи.');
            if (c.platform.subscription(org).status !== 'active')
              throw fail(403, 'Доступ по тарифу приостановлен.');
            const p = cabinetForUser(current, storage.readSelected([values.patientId])).patients[0],
              a = p?.appointments.find((a) => a.id === values.appointmentId);
            if (!a) throw fail(404, 'Запись не найдена.');
            if (current.role === 'cosmetologist' && a.staffId !== current.accountId)
              throw fail(403, 'Сотрудник может подтверждать только свои записи.');
            if (!isActiveAppointment(a))
              throw fail(400, 'Подтверждение закрытой записи недоступно.');
            const zone = c.platform.organizationTimeZone(org),
              store = c.platform.appointmentConfirmations,
              key = store.stamp(a, zone);
            if (key !== values.expectedFingerprint)
              throw fail(409, 'Запись изменилась. Обновите её перед подтверждением.');
            if (!(startsAt(a, zone) > Date.now()))
              throw fail(400, 'Подтверждение доступно только для будущей записи.');
            const telegramConfirmedAt = c.platform.telegram.confirmed(
              org,
              p.id,
              fingerprint(a, zone),
              serviceFingerprint(a),
            );
            const notificationReceipt = c.notificationCoordinator?.receipt(org, p.id, a, zone);
            if (
              values.confirmed &&
              (telegramConfirmedAt || notificationReceipt?.notificationConfirmedAt)
            )
              throw fail(409, 'Запись уже подтверждена клиентом.');
            const receipt = store.set(org, p.id, a, zone, current.accountId, values.confirmed);
            if (values.confirmed) {
              c.platform.telegram.cancelPending(org, p.id, fingerprint(a, zone));
              c.notificationCoordinator?.cancelPending(org, p.id, a.id);
            }
            return {
              appointmentId: a.id,
              confirmationKey: key,
              manualConfirmedAt: receipt?.manualConfirmedAt || null,
              manualConfirmedBy: receipt?.manualConfirmedBy || '',
              telegramConfirmedAt,
              notificationConfirmedAt: notificationReceipt?.notificationConfirmedAt || null,
              notificationConfirmedChannel: notificationReceipt?.notificationConfirmedChannel || '',
            };
          }),
      );
      return c.json(c.res, 200, result);
    },
  },
];
module.exports = { routes };
