const {
  validDate,
  nextDate,
  minutes,
  normalizeDay,
  bookingWarning,
} = require('../../../shared/work-schedule.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { createScheduleBooking } = require('./booking.cjs');
const { workingIntervalsByDate } = require('./working-intervals.cjs');
const { duration } = require('../cabinet/validation.cjs');
const { createPublicDays } = require('./public-days.cjs');
const { createFutureDays } = require('./future-days.cjs');
function createWorkSchedules(context) {
  const { db, open, seal, fail, transaction, audit } = context;
  function profile(org, staff) {
    const row = db
      .prepare('SELECT value FROM work_schedule_profiles WHERE organization_id=? AND staff_id=?')
      .get(org, staff);
    return row ? open(row.value) : { revision: 0, allowSelfEdit: true };
  }
  function day(org, staff, date) {
    const row = db
      .prepare(
        'SELECT value FROM work_schedule_days WHERE organization_id=? AND staff_id=? AND date=?',
      )
      .get(org, staff, date);
    return row ? open(row.value) : null;
  }
  function current(token) {
    const actor = context.session(token);
    if (!actor?.organizationId || !['owner', 'salon_admin', 'cosmetologist'].includes(actor.role))
      throw fail(403, 'Нет доступа к графику организации.');
    return actor;
  }
  function authorize(actor, staff, edit = true, identities) {
    const publicRead = actor?.role === 'public_booking' && !edit && staff === actor.accountId;
    if (
      !actor?.organizationId ||
      (!publicRead && !['owner', 'salon_admin', 'cosmetologist'].includes(actor.role))
    )
      throw fail(403, 'Нет доступа к графику организации.');
    if (
      actor.role === 'cosmetologist' &&
      (staff !== actor.accountId || (edit && !profile(actor.organizationId, staff).allowSelfEdit))
    )
      throw fail(403, 'Недостаточно прав для этого графика.');
    if (
      staff !== 'organization' &&
      !(identities || context.workspaceIdentities(actor.organizationId, staff)).some(
        (member) => member.accountId === staff && member.status === 'active',
      )
    )
      throw fail(403, 'Сотрудник недоступен в этой организации.');
  }
  const booking = createScheduleBooking(context, { profile, day, authorize });
  function view(token, staff, from, to) {
    return viewForActor(current(token), staff, from, to);
  }
  // The native kernel supplies the actor from fresh authority before/after RR.
  // Domain authorization below remains the same for native and legacy reads.
  function viewForActor(actor, staff, from, to) {
    staff ||= actor.accountId;
    authorize(actor, staff, false);
    const org = actor.organizationId,
      saved = profile(org, staff),
      organizationProfile = profile(org, 'organization');
    const rows = (id) =>
      Object.fromEntries(
        db
          .prepare(
            'SELECT date,value FROM work_schedule_days WHERE organization_id=? AND staff_id=? AND date BETWEEN ? AND ? ORDER BY date',
          )
          .all(org, id, from, to)
          .map((row) => [row.date, open(row.value)]),
      );
    const days = rows(staff);
    const members = context
      .workspaceMembers(org, actor.role === 'cosmetologist' ? actor.accountId : undefined)
      .filter(
        (m) =>
          m.status === 'active' &&
          ['owner', 'cosmetologist'].includes(m.role) &&
          (actor.role !== 'cosmetologist' || m.accountId === actor.accountId),
      );
    const visibleStaff = new Set(members.map((m) => m.accountId));
    const workingRecords =
      actor.role === 'cosmetologist'
        ? Object.entries(days).map(([date, day]) => ({ staffId: staff, date, day }))
        : db
            .prepare(
              'SELECT staff_id,date,value FROM work_schedule_days WHERE organization_id=? AND date BETWEEN ? AND ? ORDER BY date',
            )
            .all(org, from, to)
            .filter((row) => visibleStaff.has(row.staff_id))
            .map((row) => ({ staffId: row.staff_id, date: row.date, day: open(row.value) }));
    const staffDays = Object.fromEntries(members.map((member) => [member.accountId, {}]));
    for (const record of workingRecords) staffDays[record.staffId][record.date] = record.day;
    return {
      staffId: staff,
      ...saved,
      from,
      to,
      timeZone: context.organizationTimeZone(org),
      days,
      staffDays,
      workingIntervals: workingIntervalsByDate(workingRecords),
      closures: rows('organization'),
      canEdit: actor.role !== 'cosmetologist' || saved.allowSelfEdit,
      canManagePermission: actor.role === 'owner' && staff !== 'organization',
      calendarHiddenUntil: organizationProfile.calendarHiddenUntil || '07:00',
      calendarRevision: organizationProfile.revision,
      canManageCalendar: actor.role !== 'cosmetologist',
      members,
    };
  }
  viewForActor.readRequests = (actor, staff, from, to) => {
    if (!db.canPrefetchReads) return [];
    staff ||= actor.accountId;
    const org = actor.organizationId;
    const p = db.prepare(
      'SELECT value FROM work_schedule_profiles WHERE organization_id=? AND staff_id=?',
    );
    const d = db.prepare(
      'SELECT date,value FROM work_schedule_days WHERE organization_id=? AND staff_id=? AND date BETWEEN ? AND ? ORDER BY date',
    );
    return [
      p.readRequest('get', [org, staff]),
      p.readRequest('get', [org, 'organization']),
      d.readRequest('all', [org, staff, from, to]),
      d.readRequest('all', [org, 'organization', from, to]),
      ...(actor.role === 'cosmetologist'
        ? []
        : [
            db
              .prepare(
                'SELECT staff_id,date,value FROM work_schedule_days WHERE organization_id=? AND date BETWEEN ? AND ? ORDER BY date',
              )
              .readRequest('all', [org, from, to]),
          ]),
    ];
  };
  function assertFields(values, allowed) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some((key) => !allowed.includes(key))
    )
      throw fail(400, 'Некорректные настройки графика.');
  }
  function updateProfile(org, staff, value) {
    db.prepare(
      'INSERT INTO work_schedule_profiles(organization_id,staff_id,value) VALUES(?,?,?) ON CONFLICT(organization_id,staff_id) DO UPDATE SET value=excluded.value',
    ).run(org, staff, seal(value));
  }
  function save(token, values, storage) {
    assertFields(values, [
      'staffId',
      'dates',
      'status',
      'intervals',
      'revision',
      'expectedTimeZone',
      'confirmation',
    ]);
    const dates = values.dates;
    if (
      !Array.isArray(dates) ||
      !dates.length ||
      dates.length > 62 ||
      dates.some((date) => !validDate(date)) ||
      new Set(dates).size !== dates.length ||
      dates.some((date) => Math.abs((Date.parse(date) - Date.parse(dates[0])) / 86400000) > 62)
    )
      throw fail(400, 'Выберите до 62 конкретных дат в пределах 63 дней.');
    const replacement = normalizeDay(values, fail);
    return transaction(() => {
      const actor = current(token),
        org = actor.organizationId,
        staff = values.staffId || actor.accountId;
      authorize(actor, staff);
      if (staff === 'organization' && replacement.status === 'working')
        throw fail(400, 'Для организации можно установить закрытие или снять его.');
      const prior = profile(org, staff),
        zone = context.organizationTimeZone(org);
      if (values.revision !== prior.revision || values.expectedTimeZone !== zone)
        throw fail(409, 'График или часовой пояс изменён. Откройте настройки заново.');
      const selected = new Set(dates),
        sorted = [...dates].sort();
      const changedDay = (id, date) =>
        id === staff && selected.has(date)
          ? replacement.status === 'reset'
            ? null
            : replacement
          : day(org, id, date);
      const ownerId = context.workspaceMembers(org).find((m) => m.role === 'owner')?.accountId;
      const affected = storage.indexes
        .appointments(nextDate(sorted[0], -1), sorted.at(-1))
        .map((a) => ({ ...a, staffId: a.staffId || ownerId, duration: duration(a.duration ?? 60) }))
        .filter((a) => {
          if (!isActiveAppointment(a) || (staff !== 'organization' && a.staffId !== staff))
            return false;
          if (
            !selected.has(a.date) &&
            !(minutes(a.time) + Number(a.duration) > 1440 && selected.has(nextDate(a.date)))
          )
            return false;
          if (replacement.status === 'reset') return false;
          return (
            dates.some(
              (date) => JSON.stringify(day(org, staff, date)) !== JSON.stringify(replacement),
            ) &&
            Boolean(
              bookingWarning(
                a,
                (date) => changedDay(a.staffId, date),
                (date) => changedDay('organization', date),
              ),
            )
          );
        });
      const confirmation = booking.signature([
        org,
        actor.accountId,
        staff,
        prior.revision,
        zone,
        [...dates].sort(),
        replacement,
        affected.map((a) => [a.id, a.date, a.time, a.duration, a.staffId]).sort(),
      ]);
      if (affected.length && values.confirmation !== confirmation)
        return { requiresConfirmation: true, conflictCount: affected.length, confirmation };
      const insert = db.prepare(
        'INSERT INTO work_schedule_days(organization_id,staff_id,date,value) VALUES(?,?,?,?) ON CONFLICT(organization_id,staff_id,date) DO UPDATE SET value=excluded.value',
      );
      const remove = db.prepare(
        'DELETE FROM work_schedule_days WHERE organization_id=? AND staff_id=? AND date=?',
      );
      for (const date of dates)
        if (replacement.status === 'reset') remove.run(org, staff, date);
        else insert.run(org, staff, date, seal(replacement));
      updateProfile(org, staff, { ...prior, revision: prior.revision + 1 });
      audit('work_schedule_updated', actor.accountId, org, {
        staffId: staff,
        dateCount: dates.length,
        status: replacement.status,
        conflictsAcknowledged: affected.length,
      });
      context.bookingPublication.reconcileInTransaction(org);
      return { saved: true, revision: prior.revision + 1 };
    });
  }
  function permission(token, values) {
    assertFields(values, ['staffId', 'revision', 'allowSelfEdit']);
    if (typeof values.allowSelfEdit !== 'boolean')
      throw fail(400, 'Укажите разрешение на редактирование.');
    return transaction(() => {
      const actor = current(token),
        org = actor.organizationId;
      if (actor.role !== 'owner' || values.staffId === 'organization')
        throw fail(403, 'Разрешение изменяет только владелец.');
      authorize(actor, values.staffId);
      const prior = profile(org, values.staffId);
      if (values.revision !== prior.revision)
        throw fail(409, 'График уже изменён. Обновите настройки.');
      updateProfile(org, values.staffId, {
        ...prior,
        revision: prior.revision + 1,
        allowSelfEdit: values.allowSelfEdit,
      });
      audit('work_schedule_permission_updated', actor.accountId, org, {
        staffId: values.staffId,
        allowSelfEdit: values.allowSelfEdit,
      });
      return { saved: true };
    });
  }
  function calendarSettings(token, values) {
    assertFields(values, ['revision', 'hiddenUntil']);
    if (!/^([01]\d|2[0-3]):00$/.test(values.hiddenUntil))
      throw fail(400, 'Выберите целый час от 00:00 до 23:00.');
    return transaction(() => {
      const actor = current(token),
        org = actor.organizationId;
      if (actor.role === 'cosmetologist')
        throw fail(403, 'Настройку календаря изменяют владелец или администратор.');
      const prior = profile(org, 'organization');
      if (values.revision !== prior.revision)
        throw fail(409, 'Настройки рабочего времени уже изменились. Обновите раздел.');
      updateProfile(org, 'organization', {
        ...prior,
        revision: prior.revision + 1,
        calendarHiddenUntil: values.hiddenUntil,
      });
      audit('calendar_hidden_until_updated', actor.accountId, org, {
        hiddenUntil: values.hiddenUntil,
      });
      return {
        saved: true,
        revision: prior.revision + 1,
        calendarHiddenUntil: values.hiddenUntil,
      };
    });
  }
  return {
    publicDays: createPublicDays(context),
    futureDays: createFutureDays(context),
    view,
    viewForActor,
    save,
    permission,
    calendarSettings,
    check: (token, appointment) => booking.check(current(token), appointment),
    assertChanges: booking.assertChanges,
  };
}
module.exports = { createWorkSchedules };
