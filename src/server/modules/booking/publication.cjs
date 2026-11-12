const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { hasOpenWorkingDays } = require('./schedule-state.cjs');
const { publicContact } = require('../organizations/public-contact.cjs');
function createBookingPublication(context) {
  const { db, seal, open, transaction } = context;
  const missing = () => fail(404, 'Онлайн-запись недоступна.');
  function organizationState(org, now = Date.now(), workingDays) {
    const profile = context.organization(org),
      saved = profile.bookingPublication || {};
    return {
      canManage: true,
      enabled: saved.enabled === true,
      revision: saved.revision || 0,
      disabledReason: saved.disabledReason || null,
      hasWorkingDays:
        workingDays ??
        (saved.enabled || saved.disabledReason ? hasOpenWorkingDays(context, org, now) : null),
      path:
        context.bookingShortLinks?.path(org) ||
        '/booking.html?organization=' + encodeURIComponent(org),
    };
  }
  function managerView(token, now, allocate) {
    const actor = context.onlineBooking.actor(token);
    if (!['owner', 'salon_admin'].includes(actor.role))
      return { publication: { canManage: false }, needsLinks: false, needsReconcile: false };
    const org = actor.organizationId;
    const links = context.bookingShortLinks;
    const providers = links ? context.onlineBooking.providers(org, []) : [];
    const staffIds = providers.map((member) => member.accountId);
    const needsLinks = Boolean(links && !links.hasTargets(org, staffIds));
    if (allocate && needsLinks) links.ensure(org, staffIds);
    const state = organizationState(org, now);
    return {
      publication: {
        ...state,
        ...(links
          ? {
              staffPaths: Object.fromEntries(
                providers.map((member) => [member.accountId, links.path(org, member.accountId)]),
              ),
            }
          : {}),
      },
      needsLinks: !allocate && needsLinks,
      needsReconcile: state.enabled && state.hasWorkingDays === false,
    };
  }
  function view(token, now = Date.now()) {
    return managerView(token, now, true).publication;
  }
  // No allocation, flag changes or audit: this probe is safe inside READONLY RR.
  function inspectView(token, now = Date.now()) {
    return managerView(token, now, false);
  }
  // Internal only: caller owns the platform transaction (schedule save,
  // diagnostic/public-info read, or the maintenance batch).
  function reconcileInTransaction(org, now = Date.now()) {
    const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(org);
    if (!row) throw missing();
    const profile = open(row.value),
      saved = profile.bookingPublication || {};
    if (!saved.enabled) return organizationState(org, now);
    const working = hasOpenWorkingDays(context, org, now);
    if (working) return organizationState(org, now, true);
    db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
      seal({
        ...profile,
        bookingPublication: {
          ...saved,
          enabled: false,
          revision: (saved.revision || 0) + 1,
          disabledReason: 'no_working_days',
          disabledAt: now,
        },
      }),
      org,
    );
    context.audit('booking_publication_disabled_no_working_days', null, org, {
      reason: 'no_working_days',
    });
    return organizationState(org, now, false);
  }
  function reconcileBatch(cursor = '', limit = 50, now = Date.now()) {
    if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw fail(400, 'Некорректный пакет проверки публикации.');
    const rows = db
      .prepare(
        "SELECT id,value FROM organizations WHERE status='active' AND id>? ORDER BY id LIMIT ?",
      )
      .all(cursor, limit);
    for (const row of rows) {
      if (!open(row.value).bookingPublication?.enabled) continue;
      const needsReconcile = context.readOnlySnapshot(() => {
        const current = organizationState(row.id, now);
        return current.enabled && current.hasWorkingDays === false;
      });
      if (!needsReconcile) continue;
      transaction(() => reconcileInTransaction(row.id, now));
    }
    return { cursor: rows.length === limit ? rows.at(-1).id : '' };
  }
  function save(token, values) {
    if (
      !values ||
      Object.keys(values).some((k) => !['enabled', 'revision'].includes(k)) ||
      typeof values.enabled !== 'boolean' ||
      !Number.isSafeInteger(values.revision)
    )
      throw fail(400, 'Проверьте включение онлайн-записи.');
    return transaction(() => {
      const prior = view(token);
      if (!prior.canManage) throw fail(403, 'Включение доступно владельцу и администратору.');
      if (prior.revision !== values.revision)
        throw fail(409, 'Настройки изменились. Обновите страницу.');
      const actor = context.onlineBooking.actor(token),
        org = actor.organizationId;
      const working = values.enabled ? hasOpenWorkingDays(context, org) : null;
      const enabled = values.enabled && working;
      const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(org);
      db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
        seal({
          ...open(row.value),
          bookingPublication: {
            enabled,
            revision: prior.revision + 1,
            disabledReason: values.enabled && !working ? 'no_working_days' : null,
          },
        }),
        org,
      );
      context.audit('booking_publication_updated', actor.accountId, org, {
        enabled,
        requestedEnabled: values.enabled,
      });
      return view(token);
    });
  }
  function resolve(
    org,
    { allowAutoDisabled = false, allowClosedContact = false, now = Date.now() } = {},
  ) {
    if (typeof org !== 'string' || !/^[a-f0-9-]{36}$/.test(org)) throw missing();
    const row = db.prepare('SELECT value,status FROM organizations WHERE id=?').get(org);
    if (!row) throw missing();
    const profile = open(row.value);
    const saved = profile.bookingPublication || {};
    if (
      context.subscription(org).status !== 'active' ||
      row.status !== 'active' ||
      (!saved.enabled &&
        !(allowAutoDisabled && saved.disabledReason === 'no_working_days') &&
        !(allowClosedContact && saved.revision > 0))
    )
      throw missing();
    if (!allowAutoDisabled && !allowClosedContact && !hasOpenWorkingDays(context, org, now))
      throw missing();
    return {
      organizationId: org,
      name: profile.name || 'Организация',
      city: profile.city || '',
      ...publicContact(context, org, profile),
      timeZone: context.organizationTimeZone(org),
    };
  }
  function signature(org, address, value) {
    return context
      .limitKey('booking-challenge', JSON.stringify([org, address, value]))
      .split(':')
      .at(-1);
  }
  function challenge(org, address, now = Date.now()) {
    const value = now.toString(36) + '.' + crypto.randomBytes(12).toString('hex');
    return value + '.' + signature(org, address, value);
  }
  function assertChallenge(org, address, key, now = Date.now()) {
    if (typeof key !== 'string' || !/^[a-z0-9]{8,12}\.[a-f0-9]{24}\.[a-f0-9]{64}$/.test(key))
      throw fail(400, 'Обновите страницу записи.');
    const [issued, nonce, supplied] = key.split('.'),
      time = parseInt(issued, 36);
    if (
      !Number.isSafeInteger(time) ||
      now - time < 0 ||
      now - time > 30 * 60000 ||
      !crypto.timingSafeEqual(
        Buffer.from(supplied, 'hex'),
        Buffer.from(signature(org, address, issued + '.' + nonce), 'hex'),
      )
    )
      throw Object.assign(fail(400, 'Срок формы истёк. Обновите страницу записи.'), {
        code: 'BOOKING_CHALLENGE_REJECTED',
      });
  }
  const members = (org, ids = [], catalog = [], snapshot) =>
    context.onlineBooking.providers(org, ids, catalog, snapshot).map((m) => ({
      id: m.accountId,
      name: m.displayName || 'Сотрудник',
      specialty: snapshot?.specialties
        ? snapshot.specialties[m.accountId] || ''
        : context.staffSpecialty(org, m.accountId) || '',
    }));
  return {
    view,
    inspectView,
    save,
    resolve,
    challenge,
    assertChallenge,
    members,
    state: organizationState,
    reconcileInTransaction,
    reconcileBatch,
  };
}
module.exports = { createBookingPublication };
