const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { PRIVACY_VERSION, privacyConsent } = require('../../../shared/privacy-consent.cjs');
const { validDate, nextDate, minutes } = require('../../../shared/work-schedule.cjs');
const { startsAt } = require('../notifications/appointments.cjs');
const { duration } = require('../cabinet/validation.cjs');
const { calculateBookingPreview } = require('./preview.cjs');
const { requestInput } = require('./request-input.cjs');
const { admitRequest } = require('./admission.cjs');
const { bookingReadiness, publicBookingHealth } = require('./readiness.cjs');
const { bookClassic, classicReceipt } = require('./classic.cjs');
const { bookingTiming } = require('./timing.cjs');
const { serviceOwner } = require('../services/catalog.cjs');
const { effectiveStaffRules } = require('./staff-rules.cjs');
const { dateInZone } = require('./schedule-state.cjs');

function publicPreview(platform, org, storage, values, now, snapshot = null) {
  return calculateBookingPreview(
    platform,
    org,
    storage,
    values,
    now,
    {},
    (id) => {
      if (snapshot?.schedules.has(id)) return snapshot.schedules.get(id);
      const schedule = platform.workSchedules.publicDays(org, id, values.date, values.date);
      snapshot?.schedules.set(id, schedule);
      return schedule;
    },
    null,
    snapshot,
  );
}
function publicInfo(context, org, now = Date.now()) {
  const { platform } = context;
  const result = bookingTiming(context, 'booking-platform-read', () =>
    platform.withReadSnapshot(() => {
      const { organization, publication } = bookingTiming(context, 'booking-publication', () => ({
        organization: platform.bookingPublication.resolve(org, {
          allowAutoDisabled: true,
          allowClosedContact: true,
          now,
        }),
        publication: platform.bookingPublication.state(org, now),
      }));
      if (publication.enabled && !publication.hasWorkingDays) return null;
      return infoProjection(context, org, now, publication, organization);
    }),
  );
  if (result !== null) return result;
  // Only auto-disabling an exhausted schedule needs a writer. Recheck atomically.
  return platform.withWriteLock(() => {
    const publication = platform.bookingPublication.reconcileInTransaction(org, now);
    const organization = platform.bookingPublication.resolve(org, {
      allowAutoDisabled: true,
      allowClosedContact: true,
      now,
    });
    return infoProjection(context, org, now, publication, organization);
  });
}
function infoProjection(context, org, now, publication, organization) {
  const { platform } = context;
  if (!publication.enabled)
    return {
      organization,
      health: {
        available: false,
        reason:
          publication.disabledReason === 'no_working_days'
            ? publication.hasWorkingDays
              ? 'awaiting_activation'
              : 'no_working_days'
            : 'paused',
        nextDate: null,
        checkedAt: now,
      },
      services: [],
      members: [],
    };
  const storage = context.tenantStore(org);
  const snapshot = bookingTiming(context, 'booking-provider-snapshot', () =>
    platform.onlineBooking.providerSnapshot(org),
  );
  const settings = snapshot.settings;
  snapshot.timeZone = organization.timeZone;
  snapshot.recordTiming = context.recordTiming;
  const members = platform.bookingPublication.members(org, [], [], snapshot),
    eligible = new Set(members.map((m) => m.id));
  const catalog = bookingTiming(context, 'booking-services', () => storage.readServices());
  const groups = new Map(platform.serviceGroups(org).groups.map((group) => [group.id, group]));
  const services = catalog
    .map((s) => {
      const category = s.category ? groups.get(s.category) : null;
      return {
        id: s.id,
        name: s.name,
        categoryId: category ? category.id : '',
        categoryTitle: category ? category.title : '',
        description: s.description || '',
        duration: duration(s.duration ?? 60),
        ...(settings.showPrices !== false ? { price: s.price } : {}),
        staffIds: eligible.has(serviceOwner(s, snapshot.ownerId))
          ? [serviceOwner(s, snapshot.ownerId)]
          : [],
      };
    })
    .filter((s) => s.staffIds.length);
  return {
    organization,
    health: bookingTiming(context, 'booking-readiness', () =>
      publicBookingHealth(bookingReadiness(platform, org, storage, now, catalog, snapshot)),
    ),
    services,
    members: members.map((member) => ({
      ...member,
      rules: effectiveStaffRules(settings, member.id),
    })),
    mode: settings.mode,
    bookingMode: settings.bookingMode,
    minimumLeadMinutes: settings.minimumLeadMinutes,
    reservationMinutes: settings.reservationMinutes,
    showPrices: settings.showPrices !== false,
    privacyConsentVersion: PRIVACY_VERSION,
    challenge: platform.bookingPublication.challenge(org, context.clientAddress(context.req), now),
  };
}
function publicAvailability(context, org, values, now = Date.now()) {
  return bookingTiming(context, 'booking-platform-read', () =>
    context.platform.withReadSnapshot(() => {
      const organization = bookingTiming(context, 'booking-publication', () =>
        context.platform.bookingPublication.resolve(org, { now }),
      );
      const snapshot = bookingTiming(context, 'booking-provider-snapshot', () =>
        context.platform.onlineBooking.providerSnapshot(org),
      );
      snapshot.timeZone = organization.timeZone;
      snapshot.recordTiming = context.recordTiming;
      snapshot.schedules = new Map();
      const result = bookingTiming(context, 'booking-availability', () =>
        publicPreview(context.platform, org, context.tenantStore(org), values, now, snapshot),
      );
      const requestedTimes = new Set();
      const rules = values.staffId ? effectiveStaffRules(snapshot.settings, values.staffId) : null;
      if (
        rules?.bookingMode !== 'classic' &&
        values.staffId &&
        context.platform.onlineBooking
          .providers(org, values.serviceIds, snapshot.services, snapshot)
          .some((m) => m.accountId === values.staffId)
      ) {
        const schedule =
            snapshot.schedules.get(values.staffId) ||
            context.platform.workSchedules.publicDays(
              org,
              values.staffId,
              values.date,
              values.date,
            ),
          day = schedule.days[values.date],
          settings = snapshot.settings;
        if (day?.status === 'working' && schedule.closures[values.date]?.status !== 'closed')
          for (const [from, to] of day.intervals)
            for (
              let start = Math.ceil(minutes(from) / 5) * 5;
              start + result.duration <= minutes(to, true);
              start += 15
            ) {
              const time =
                String(Math.floor(start / 60)).padStart(2, '0') +
                ':' +
                String(start % 60).padStart(2, '0');
              if (
                startsAt({ date: values.date, time }, result.timeZone) >=
                now + settings.minimumLeadMinutes * 60000
              )
                requestedTimes.add(time);
            }
      }
      // Physical rooms are internal resources, not a client selection or data leak.
      return {
        ...result,
        requestedTimes: [...requestedTimes].sort(),
        slots: result.slots.map(({ roomId, ...slot }) => slot),
        members: context.platform.bookingPublication
          .members(org, values.serviceIds, snapshot.services, snapshot)
          .filter((m) => !values.staffId || m.id === values.staffId)
          .map((member) => ({
            ...member,
            rules: effectiveStaffRules(snapshot.settings, member.id),
          })),
      };
    }),
  );
}
function publicDates(context, org, month, staffId, now = Date.now()) {
  if (
    typeof month !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !validDate(month + '-01') ||
    (staffId && (typeof staffId !== 'string' || staffId.length > 120))
  )
    throw fail(400, 'Выберите месяц.');
  const from = month + '-01';
  let to = from;
  for (let i = 1; i < 31; i++) {
    const next = nextDate(to);
    if (!next.startsWith(month)) break;
    to = next;
  }
  return bookingTiming(context, 'booking-platform-read', () =>
    context.platform.withReadSnapshot(() => {
      const { platform } = context;
      const organization = bookingTiming(context, 'booking-publication', () =>
        platform.bookingPublication.resolve(org, { now }),
      );
      const today = dateInZone(now, organization.timeZone);
      const dates = new Set();
      for (const member of platform.onlineBooking
        .providers(org, [])
        .filter((m) => !staffId || m.accountId === staffId)) {
        const schedule = platform.workSchedules.publicDays(org, member.accountId, from, to);
        for (const [date, day] of Object.entries(schedule.days))
          if (
            date >= today &&
            day.status === 'working' &&
            schedule.closures[date]?.status !== 'closed'
          )
            dates.add(date);
      }
      return { month, dates: [...dates].sort() };
    }),
  );
}
function publicSubmit(context, org, values, now = Date.now()) {
  const { challenge, ...input } = requestInput(values),
    { platform } = context;
  const assertConsent = () =>
    privacyConsent(
      {
        privacyConsent: input.consent,
        privacyConsentVersion: input.privacyConsentVersion,
      },
      'booking',
      now,
    );
  const address = context.clientAddress(context.req);
  platform.bookingPublication.resolve(org, { now });
  if (!/^[a-z0-9]{8,12}\.[a-f0-9]{24}\.[a-f0-9]{64}$/.test(input.key))
    throw fail(400, 'Обновите страницу записи.');
  // The renewed proof is transport metadata; keep the original idempotency key
  // and exclude the proof from stored submissions and classic receipt hashes.
  platform.bookingPublication.assertChallenge(org, address, challenge ?? input.key, now);
  // Budgets commit separately: invalid/conflicting submissions cannot roll back
  // an attacker's request counter. Repeat keys do not extend holds or consume a
  // second slot, but requests still consume the address read budget at the route.
  const prior = platform.bookingRequests.byKey(org, input.key, now);
  const receipt = classicReceipt(context.tenantStore(org), org, input);
  if (!prior && !receipt) {
    assertConsent();
    platform.bookingPublicLimits.consume('submit', org, address, input.phone, now);
  }
  // Commit the recovery hint before entering platform -> tenant locks. It must
  // survive a later platform rollback after a classic appointment has committed.
  const schedule = platform.notificationSchedule;
  const intent = schedule?.enabled ? schedule.beginIntent(org, input.key) : null;
  const storage = context.tenantStore(org);
  return compoundMutation(platform, storage, org, 'booking', () => {
    if (intent) schedule.assertIntent(intent);
    const finish = (result) => {
      if (intent) schedule.ackIntent(intent);
      return result;
    };
    platform.bookingPublication.resolve(org, { now });
    const saved = classicReceipt(storage, org, input);
    if (saved) {
      if (intent) schedule.markDirty(org);
      return finish(saved);
    }
    const existing = platform.bookingRequests.byKey(org, input.key, now);
    const bookingMode = effectiveStaffRules(
      platform.onlineBooking.settings(org),
      input.staffId,
    ).bookingMode;
    if (!existing && (input.bookingMode || 'approval') !== bookingMode)
      throw Object.assign(
        fail(
          409,
          `Условия записи изменились: ${bookingMode === 'classic' ? 'теперь запись создаётся сразу' : 'теперь требуется подтверждение организации'}. Выберите время заново.`,
        ),
        { code: 'BOOKING_CONDITIONS_CHANGED' },
      );
    if (bookingMode === 'classic' && !existing) {
      assertConsent();
      platform.bookingRequests.publicCapacity(org, input.phone, now);
      return finish(bookClassic({ ...context, notificationIntent: intent }, org, input, now));
    }
    return finish(
      context.tenantStore(org).transaction(() => {
        const storage = context.tenantStore(org);
        if (!platform.bookingRequests.byKey(org, input.key, now)) {
          assertConsent();
          platform.bookingRequests.publicCapacity(org, input.phone, now);
        }
        const result = admitRequest(
          platform,
          org,
          storage,
          input,
          () =>
            publicPreview(
              platform,
              org,
              storage,
              {
                date: input.date,
                serviceIds: input.serviceIds,
                staffId: input.staffId,
              },
              now,
            ),
          () => platform.workSchedules.publicDays(org, input.staffId, input.date, input.date),
          now,
        );
        return {
          status: result.status,
          date: result.date,
          time: result.time,
          duration: result.duration,
          expiresAt: result.expiresAt,
        };
      }, 'DEFERRED'),
    );
  });
}
module.exports = { publicInfo, publicAvailability, publicDates, publicSubmit };
