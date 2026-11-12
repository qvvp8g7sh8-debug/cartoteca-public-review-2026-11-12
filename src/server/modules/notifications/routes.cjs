const { patientViewStatus } = require('./patient-view-status145.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { cabinetForUser } = require('../access/cabinet-policy.cjs');
const { fingerprint, serviceFingerprint, settingsRule, startsAt } = require('./appointments.cjs');
const { previewMessage, invitationMessage } = require('./telegram-messages.cjs');
const QRCode = require('qrcode');
function manager(current) {
  if (!['owner', 'salon_admin'].includes(current.role))
    throw fail(403, 'Настройки уведомлений доступны владельцу и администратору.');
}
function visible(context, id) {
  if (typeof id !== 'string' || !id || id.length > 120) throw fail(400, 'Укажите карточку.');
  const p = cabinetForUser(
    context.current,
    context.tenantStore(context.current.organizationId).readSelected([id]),
  ).patients[0];
  if (!p) throw fail(404, 'Карточка не найдена.');
  return p;
}
function patientStatus(context, p) {
  const org = context.current.organizationId,
    store = context.platform.telegram,
    recipient = store.link(org, p.id);
  const settings = store.settings(org),
    zone = settings.timeZone,
    bot = context.telegram.status(),
    plan = context.platform.subscription(org);
  const confirmations = p.appointments.map((a) => ({
    appointmentId: a.id,
    confirmedAt: isActiveAppointment(a)
      ? store.confirmed(org, p.id, fingerprint(a, zone), serviceFingerprint(a))
      : null,
    ...context.platform.appointmentConfirmations.read(org, p.id, a, zone),
    confirmationKey: context.platform.appointmentConfirmations.stamp(a, zone),
    ...context.notificationCoordinator?.receipt(org, p.id, a, zone),
  }));
  const receipts = new Map(confirmations.map((c) => [c.appointmentId, c]));
  const appointments = p.appointments
    .filter((a) => a.status !== 'completed')
    .map((a) => {
      const start = startsAt(a, zone);
      return {
        appointmentId: a.id,
        status: a.status || 'scheduled',
        staffId: a.staffId,
        confirmationKey: context.platform.appointmentConfirmations.stamp(a, zone),
        date: a.date,
        time: a.time,
        service: a.service || '',
        duration: a.duration || 60,
        startsAt: start,
        upcoming: isActiveAppointment(a) && start > Date.now(),
        ...receipts.get(a.id),
        deliveryStatus:
          Array.isArray(settings.events) && !settings.events.includes('reminder')
            ? 'disabled'
            : store.delivery(org, p.id, fingerprint(a, zone)),
        canRemind:
          isActiveAppointment(a) &&
          (context.current.role !== 'cosmetologist' || a.staffId === context.current.accountId),
        ...context.notificationCoordinator?.describe(org, p.id, a),
      };
    })
    .sort((a, b) => a.startsAt - b.startsAt);
  return {
    patientId: p.id,
    linked: Boolean(recipient),
    linkedAt: recipient?.linkedAt || null,
    servicesConsent: recipient?.servicesConsent === true,
    showServices: settings.showServices,
    bot,
    notificationsEnabled:
      settings.enabled && plan.status === 'active' && Boolean(plan.limits.automaticNotifications),
    appointments,
    confirmations,
  };
}
const routes = [
  {
    method: 'GET',
    path: '/api/notifications/service-visibility',
    access: 'organization',
    async handle(c) {
      manager(c.current);
      return c.json(c.res, 200, {
        showServices: c.platform.telegram.settings(c.current.organizationId).showServices,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/notifications/service-visibility',
    access: 'organization',
    async handle(c) {
      manager(c.current);
      const values = await c.readBody(c.req);
      c.assertCurrent();
      manager(c.current);
      if (
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        Object.keys(values).some((key) => !['showServices', 'expectedShowServices'].includes(key))
      )
        throw fail(400, 'Некорректные поля показа услуг.');
      return c.json(
        c.res,
        200,
        c.platform.telegram.saveServiceVisibility(
          c.current.organizationId,
          c.current.accountId,
          values,
        ),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/telegram/settings',
    access: 'organization',
    async handle(c) {
      manager(c.current);
      const settings = c.platform.telegram.settings(c.current.organizationId);
      return c.json(c.res, 200, {
        settings,
        bot: c.telegram.status(),
        queue: c.platform.telegram.counts(c.current.organizationId),
        preview: previewMessage(
          c.platform.telegram.messageIdentity(c.current.organizationId),
          settings,
        ),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/preview',
    access: 'organization',
    async handle(c) {
      manager(c.current);
      const values = await c.readBody(c.req);
      c.assertCurrent();
      const settings = settingsRule({
        ...values,
        showServices:
          values?.showServices === undefined
            ? c.platform.telegram.settings(c.current.organizationId).showServices
            : values.showServices,
      });
      return c.json(c.res, 200, {
        preview: previewMessage(
          c.platform.telegram.messageIdentity(c.current.organizationId),
          settings,
        ),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/settings',
    access: 'organization',
    async handle(c) {
      manager(c.current);
      const values = await c.readBody(c.req);
      if (values.enabled && !c.telegram.status().connected)
        throw fail(503, 'Сначала подключите Telegram-бота на сервере.');
      if (
        values.enabled &&
        !c.platform.subscription(c.current.organizationId).limits.automaticNotifications
      )
        throw fail(403, 'Уведомления отключены в вашем тарифе.');
      return c.json(c.res, 200, {
        settings: c.platform.telegram.saveSettings(
          c.current.organizationId,
          c.current.accountId,
          values,
        ),
        bot: c.telegram.status(),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/telegram/patient',
    access: 'organization',
    async handle(c) {
      const preview = patientViewStatus(c);
      if (preview?.viewUnsupported) return c.json(c.res, 200, preview);
      return c.json(c.res, 200, {
        ...patientStatus(
          c,
          preview ? preview.patient : visible(c, c.url.searchParams.get('patientId')),
        ),
        ...(preview ? { revision: preview.revision } : {}),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/link',
    access: 'organization',
    async handle(c) {
      const values = await c.readBody(c.req),
        p = visible(c, values.patientId),
        bot = c.telegram.status();
      if (!bot.connected) throw fail(503, 'Telegram-бот пока не подключён.');
      const token = c.platform.telegram.issueLink(
        c.current.organizationId,
        p.id,
        c.current.accountId,
      );
      const url = `https://t.me/${bot.username}?start=${token}`;
      const qrDataUrl = await QRCode.toDataURL(url, { width: 220, margin: 2 });
      c.assertCurrent();
      const current = visible(c, p.id),
        zone = c.platform.telegram.settings(c.current.organizationId).timeZone,
        now = Date.now();
      // Use only this user's accessible appointments, never the inviter's identity.
      const next = current.appointments
        .filter(isActiveAppointment)
        .map((a) => ({ a, start: startsAt(a, zone) }))
        .filter((x) => x.start >= now)
        .sort((a, b) => a.start - b.start)[0]?.a;
      const invitationText = invitationMessage(
        c.platform.telegram.messageIdentity(c.current.organizationId, next?.staffId || ''),
      );
      return c.json(c.res, 200, { url, qrDataUrl, expiresInHours: 24, invitationText });
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/unlink',
    access: 'organization',
    async handle(c) {
      manager(c.current);
      const values = await c.readBody(c.req),
        p = visible(c, values.patientId);
      c.platform.telegram.unlink(c.current.organizationId, p.id, c.current.accountId);
      return c.json(c.res, 200, patientStatus(c, p));
    },
  },
  {
    method: 'POST',
    path: '/api/telegram/remind',
    access: 'organization',
    async handle(c) {
      const values = await c.readBody(c.req),
        p = visible(c, values.patientId),
        a = p.appointments.find((a) => a.id === values.appointmentId);
      if (!a) throw fail(404, 'Запись не найдена.');
      if (!isActiveAppointment(a)) throw fail(400, 'Закрытая запись не требует напоминания.');
      if (c.current.role === 'cosmetologist' && a.staffId !== c.current.accountId)
        throw fail(403, 'Сотрудник может напоминать только о своих записях.');
      if (c.notificationCoordinator) {
        c.assertCurrent();
        c.notificationCoordinator.remind(c.current.organizationId, p.id, a.id, () => {
          c.assertCurrent();
          const latest = visible(c, p.id).appointments.find((item) => item.id === a.id);
          if (
            !latest ||
            (c.current.role === 'cosmetologist' && latest.staffId !== c.current.accountId)
          )
            throw fail(403, 'Нет доступа к этой записи.');
        });
        return c.json(c.res, 200, {
          ok: true,
          message: 'Напоминание поставлено в общую очередь выбранного канала.',
        });
      }
      const org = c.current.organizationId,
        store = c.platform.telegram,
        settings = store.settings(org),
        recipient = store.link(org, p.id);
      if (!c.telegram.status().connected || !settings.enabled || !recipient)
        throw fail(503, 'Подключите клиента и включите Telegram-уведомления в настройках.');
      const plan = c.platform.subscription(org);
      if (plan.status !== 'active' || !plan.limits.automaticNotifications)
        throw fail(403, 'Уведомления недоступны по тарифу.');
      const expiry = startsAt(a, settings.timeZone);
      if (!(expiry > Date.now()))
        throw fail(400, 'Напоминание доступно только для будущей записи.');
      if (c.platform.appointmentConfirmations.read(org, p.id, a, settings.timeZone))
        throw fail(409, 'Запись уже подтверждена вручную.');
      store.enqueue(org, p.id, a, fingerprint(a, settings.timeZone), recipient, expiry);
      return c.json(c.res, 200, {
        ok: true,
        message: 'Напоминание поставлено в очередь. Повторно для этого времени не отправляется.',
      });
    },
  },
];
module.exports = { routes };
