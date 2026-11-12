const { patientViewStatus } = require('./patient-view-status145.cjs');
const QRCode = require('qrcode');
const { fail } = require('../../../shared/errors.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { cabinetForUser } = require('../access/cabinet-policy.cjs');
const { startsAt } = require('./appointments.cjs');
const { maxId, maxInvitationLink } = require('./max-adapter.cjs');

const MAX_USERNAME = 'id000000000000_1_bot';
// No environment, provider calls or migrations. Dependencies must be supplied explicitly.
function createMaxConnections({
  platform,
  tenantStore,
  links = null,
  botIdentity = null,
  enabled = false,
  coordinator = null,
  clock = Date.now,
  makeQr = (url) => QRCode.toDataURL(url, { width: 220, margin: 2 }),
}) {
  const bot = botIdentity
    ? { botId: maxId(botIdentity.botId), username: botIdentity.username }
    : null;
  if (bot && bot.username !== MAX_USERNAME) throw fail(409, 'Настроен другой MAX-бот.');
  const ready = () => enabled === true && Boolean(bot && links);
  const deliveryReady = () => ready() && typeof coordinator?.cancelPending === 'function';
  function visible(current, patientId) {
    if (
      !current?.organizationId ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(current.role)
    )
      throw fail(403, 'Выберите доступную организацию.');
    if (typeof patientId !== 'string' || !patientId || patientId.length > 120)
      throw fail(400, 'Укажите карточку клиента.');
    const patient = cabinetForUser(
      current,
      tenantStore(current.organizationId).readSelected([patientId]),
    ).patients[0];
    if (!patient) throw fail(404, 'Карточка не найдена.');
    return patient;
  }
  function allowed(org) {
    const plan = platform.subscription(org);
    if (
      platform.organization(org).status !== 'active' ||
      plan.status !== 'active' ||
      !plan.limits.automaticNotifications
    )
      throw fail(403, 'Уведомления недоступны в организации.');
  }
  function status(current, patientId, viewUrl = null) {
    if (viewUrl) {
      if (
        viewUrl.searchParams.get('patientId') !== patientId ||
        viewUrl.searchParams.get('view') !== 'card'
      )
        throw fail(400, 'Некорректная карточка.');
      const preview = patientViewStatus(
        { current, url: viewUrl, tenantStore },
        { appointments: false },
      );
      if (preview?.viewUnsupported) return preview;
      if (!preview || preview.patient.id !== patientId) throw fail(404, 'Карточка не найдена.');
    } else visible(current, patientId);
    const org = current.organizationId,
      linked = links?.link(org, patientId);
    const compatible = Boolean(
      linked && !linked.restoredPaused && bot && linked.botId === bot.botId,
    );
    return {
      patientId,
      linked: Boolean(linked),
      compatible,
      linkedAt: linked?.linkedAt || null,
      bindingId: linked?.bindingId || '',
      bot: { username: MAX_USERNAME, connected: ready() },
      canConnect: ready() && !linked,
      canDisconnect: Boolean(linked) && ['owner', 'salon_admin'].includes(current.role),
      canChooseDelivery: false,
      deliveryReady: deliveryReady(),
      reason: !links
        ? 'migration_required'
        : !ready()
          ? 'bot_not_connected'
          : !deliveryReady()
            ? 'delivery_not_ready'
            : '',
    };
  }
  async function invitation(current, patientId, assertCurrent) {
    visible(current, patientId);
    if (!ready())
      throw fail(
        503,
        'Подключение MAX ещё готовится: необходимы проверенный перенос и настройка бота.',
      );
    const guard = () => {
      assertCurrent();
      visible(current, patientId);
      allowed(current.organizationId);
    };
    const issued = links.issue(
      current.organizationId,
      patientId,
      current.accountId,
      bot.botId,
      guard,
      clock(),
    );
    const url = maxInvitationLink(bot.username, issued.token),
      qrDataUrl = await makeQr(url);
    guard();
    links.assertInvitation(current.organizationId, patientId, issued.token, bot.botId, clock());
    const patient = visible(current, patientId),
      zone = platform.organizationTimeZone(current.organizationId);
    const next = (patient.appointments || [])
      .filter(isActiveAppointment)
      .map((a) => ({ a, start: startsAt(a, zone) }))
      .filter((a) => a.start > clock())
      .sort((a, b) => a.start - b.start)[0]?.a;
    const identity = platform.telegram.messageIdentity(current.organizationId, next?.staffId || '');
    const clean = (value) =>
      String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 160);
    const organization = clean(identity.organization?.name),
      specialist = clean(identity.specialist);
    const invitationText = [
      organization ? `Здравствуйте! Это ${organization}.` : 'Здравствуйте!',
      ...(specialist && specialist !== organization ? [`Ваш специалист — ${specialist}.`] : []),
      '',
      'Подключите связь с нами в MAX: откройте ссылку и запустите бота.',
      ...(!deliveryReady() ? ['Автоматические напоминания MAX пока готовятся.'] : []),
      'Персональная ссылка действует 24 часа. Не пересылайте её другим людям.',
    ].join('\n');
    return { url, qrDataUrl, invitationText, expiresAt: issued.expiresAt, expiresInHours: 24 };
  }
  function disconnect(current, values, assertCurrent) {
    visible(current, values.patientId);
    if (!['owner', 'salon_admin'].includes(current.role))
      throw fail(403, 'Отключать связь может владелец или администратор.');
    if (!links) throw fail(503, 'Хранение MAX ещё не включено.');
    links.unlink(
      current.organizationId,
      values.patientId,
      values.bindingId,
      current.accountId,
      () => {
        assertCurrent();
        visible(current, values.patientId);
      },
    );
    return status(current, values.patientId);
  }
  // Keep old authenticated URLs safe for stale tabs; never persist obsolete choices.
  function savePreference(current, values, assertCurrent) {
    assertCurrent();
    visible(current, values.patientId);
    throw fail(410, 'Выбор способа связи убран. Уведомления идут во все подключённые каналы.');
  }
  function authorizeIssuer(org, patientId, actor) {
    const membership = links.member(org, actor);
    if (!membership) throw fail(403, 'Доступ выдавшего приглашение отозван.');
    allowed(org);
    visible({ organizationId: org, accountId: actor, role: membership.role }, patientId);
  }
  function saveAppointmentPreference(current, values, assertCurrent) {
    return savePreference(current, values, assertCurrent);
  }
  function consumeStarted(token, userId, eventAt) {
    if (!ready()) throw fail(503, 'MAX пока не подключён.');
    return links.consume(token, bot.botId, userId, authorizeIssuer, clock(), eventAt);
  }
  function stopped(userId, eventAt) {
    if (!ready()) throw fail(503, 'MAX пока не подключён.');
    return links.stop(bot.botId, userId, eventAt, clock());
  }
  return {
    status,
    invitation,
    disconnect,
    savePreference,
    saveAppointmentPreference,
    consumeStarted,
    stopped,
  };
}
module.exports = { createMaxConnections, MAX_USERNAME };
