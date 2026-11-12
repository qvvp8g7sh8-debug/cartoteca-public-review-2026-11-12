const { updatePersonalVersions } = require('./personal-feed-state.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { nextDate } = require('../../../shared/work-schedule.cjs');
const {
  EVENT_LIMIT,
  validatePersonalEvent,
  personalCollection,
  personalOverlap,
  personalInPeriod,
  personalOccupancy,
  personalEnd,
} = require('../../../shared/personal-calendar.cjs');
const occupancyFields = ['staffId', 'date', 'time', 'duration'];
function createPersonalEvents(context) {
  const { db, open, seal, audit } = context;
  function collection(org) {
    // Native projections already prefetched this exact organization in the
    // owning physical READONLY snapshot. Ordinary reads and mutations stay fresh.
    if (db.canPrefetchReads && context.organization?.readRequests)
      return personalCollection(context.organization(org).personalEvents);
    const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(org);
    if (!row) throw fail(404, 'Организация не найдена.');
    return personalCollection(open(row.value).personalEvents);
  }
  function actor(token, expectedOrg) {
    const current = context.session(token);
    if (
      !current?.organizationId ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(current.role)
    )
      throw fail(403, 'Нет доступа к личным событиям организации.');
    if (expectedOrg && current.organizationId !== expectedOrg)
      throw fail(403, 'Организация изменилась. Откройте календарь заново.');
    if (context.subscription(current.organizationId).status !== 'active')
      throw fail(403, 'Доступ по тарифу приостановлен.');
    return current;
  }
  function view(current, from, to, { projection = 'details' } = {}) {
    if (!['owner', 'salon_admin', 'cosmetologist'].includes(current.role))
      throw fail(403, 'Нет доступа к личным событиям организации.');
    const saved = collection(current.organizationId);
    const visible = saved.events.filter(
      (event) => current.role !== 'cosmetologist' || event.staffId === current.accountId,
    );
    return {
      personalRevision: saved.revision,
      personalEvents: personalInPeriod(visible, from, to).map((event) =>
        projection === 'details' ? { ...event } : personalOccupancy(event),
      ),
    };
  }
  function overview(current, from, to) {
    const records = view(current, from, to, { projection: 'occupancy' }).personalEvents;
    const days = new Map();
    for (const event of records)
      for (
        let cursor = Math.max(
          Date.parse(event.date + 'T00:00:00Z'),
          Date.parse(from + 'T00:00:00Z'),
        );
        cursor < personalEnd(event) && cursor <= Date.parse(to + 'T00:00:00Z');
        cursor += 86400000
      ) {
        const date = new Date(cursor).toISOString().slice(0, 10);
        const key = date + '|' + event.staffId;
        const record = days.get(key) || { date, staffId: event.staffId, count: 0 };
        record.count++;
        days.set(key, record);
      }
    return [...days.values()];
  }
  function occupancy(org, from, to) {
    return personalInPeriod(collection(org).events, from, to).map(personalOccupancy);
  }
  function assertAppointments(org, before, next) {
    const events = collection(org).events;
    if (!events.length) return;
    const owner = context
      .workspaceIdentities(org)
      .find((member) => member.role === 'owner')?.accountId;
    const old = new Map(before.patients.flatMap((p) => p.appointments.map((a) => [a.id, a])));
    for (const patient of next.patients)
      for (const appointment of patient.appointments) {
        if (!isActiveAppointment(appointment)) continue;
        const prior = old.get(appointment.id);
        if (
          prior &&
          isActiveAppointment(prior) &&
          occupancyFields.every((field) => prior[field] === appointment[field])
        )
          continue;
        const staffId = appointment.staffId || owner;
        if (
          events.some((event) => event.staffId === staffId && personalOverlap(event, appointment))
        )
          throw fail(409, 'У сотрудника в это время личное событие. Выберите другое время.');
      }
  }
  function assertEditable(current, event) {
    if (current.role === 'cosmetologist' && event.staffId !== current.accountId)
      throw fail(403, 'Сотрудник может изменять только свои личные события.');
  }
  function assertStaff(current, staffId) {
    assertEditable(current, { staffId });
    if (
      !context
        .workspaceIdentities(current.organizationId, staffId)
        .some(
          (member) =>
            member.status === 'active' && ['owner', 'cosmetologist'].includes(member.role),
        )
    )
      throw fail(403, 'Выберите действующего специалиста этой организации.');
  }
  function write(org, current, saved, events, eventId, action) {
    const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(org);
    const next = { version: 1, revision: saved.revision + 1, events };
    if (!Number.isSafeInteger(next.revision)) throw fail(409, 'Обновите коллекцию личных событий.');
    db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
      seal({
        ...updatePersonalVersions(open(row.value), saved.events, events),
        personalEvents: next,
      }),
      org,
    );
    audit('personal_event_' + action, current.accountId, org, { eventId });
    return next.revision;
  }
  function input(values, remove = false) {
    const fields = remove ? ['revision', 'id'] : ['revision', 'event'];
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some((key) => !fields.includes(key)) ||
      !Number.isSafeInteger(values.revision) ||
      values.revision < 0 ||
      (remove &&
        (typeof values.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.id)))
    )
      throw fail(400, 'Некорректное личное событие.');
  }
  async function save(
    token,
    values,
    storage,
    expectedOrg,
    assertCurrent = () => {},
    now = Date.now(),
  ) {
    input(values);
    const event = validatePersonalEvent(values.event);
    return context.asyncTransaction(
      () => {
        assertCurrent();
        const current = actor(token, expectedOrg),
          org = current.organizationId;
        assertStaff(current, event.staffId);
        const saved = collection(org),
          prior = saved.events.find((row) => row.id === event.id);
        if (prior) assertEditable(current, prior);
        // Exact repeat after a lost response is harmless even if the collection advanced.
        if (prior && JSON.stringify(prior) === JSON.stringify(event))
          return { revision: saved.revision, event: { ...prior } };
        if (values.revision !== saved.revision)
          throw fail(409, 'Личные события изменились. Обновите календарь и повторите сохранение.');
        if (!prior && saved.events.length >= EVENT_LIMIT)
          throw fail(400, 'Можно сохранить не более 2000 личных событий.');
        return storage.transaction(() => {
          const owner = context
            .workspaceIdentities(org)
            .find((member) => member.role === 'owner')?.accountId;
          const from = event.date === '0001-01-01' ? event.date : nextDate(event.date, -1),
            to = event.date === '9999-12-31' ? event.date : nextDate(event.date, 1);
          const appointments = storage.indexes.appointments(from, to, { includeNames: false });
          const reserves = context.bookingRequests.reserves(org, from, to, now);
          if (
            [...appointments, ...reserves].some(
              (row) => (row.staffId || owner) === event.staffId && personalOverlap(event, row),
            ) ||
            saved.events.some(
              (row) =>
                row.id !== event.id && row.staffId === event.staffId && personalOverlap(event, row),
            )
          )
            throw fail(
              409,
              'Это время уже занято. Выберите свободный интервал для личного события.',
            );
          const events = saved.events.filter((row) => row.id !== event.id);
          events.push(event);
          return {
            revision: write(org, current, saved, events, event.id, prior ? 'updated' : 'created'),
            event,
          };
        }, 'DEFERRED');
      },
      { bytes: Buffer.byteLength(JSON.stringify(values)) * 3 },
    );
  }
  async function remove(token, values, expectedOrg, assertCurrent = () => {}) {
    input(values, true);
    return context.asyncTransaction(
      () => {
        assertCurrent();
        const current = actor(token, expectedOrg),
          org = current.organizationId,
          saved = collection(org);
        const event = saved.events.find((row) => row.id === values.id);
        if (!event) return { revision: saved.revision };
        assertEditable(current, event);
        if (values.revision !== saved.revision)
          throw fail(409, 'Личные события изменились. Обновите календарь перед удалением.');
        return {
          revision: write(
            org,
            current,
            saved,
            saved.events.filter((row) => row.id !== event.id),
            event.id,
            'deleted',
          ),
        };
      },
      { bytes: Buffer.byteLength(JSON.stringify(values)) * 3 },
    );
  }
  return { view, overview, occupancy, assertAppointments, save, remove };
}
module.exports = { createPersonalEvents };
