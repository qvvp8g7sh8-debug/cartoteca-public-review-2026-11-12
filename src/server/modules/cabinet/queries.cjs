const { cabinetForUser } = require('../access/cabinet-policy.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { directoryPage } = require('./directory.cjs');
const { calendarRead } = require('./calendar-read.cjs');
function calendarPeriod(url) {
  const from = url.searchParams.get('from'),
    to = url.searchParams.get('to');
  const valid = (v) =>
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
    new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
  if (
    !valid(from) ||
    !valid(to) ||
    to < from ||
    (Date.parse(to) - Date.parse(from)) / 86400000 > 42
  )
    throw fail(400, 'Выберите период до 43 дней.');
  return { from, to };
}
function selectedPatient(context, id) {
  if (typeof id !== 'string' || !id || id.length > 120) throw fail(400, 'Укажите карточку.');
  const selected = cabinetForUser(
    context.current,
    context.tenantStore(context.current.organizationId).readSelected([id]),
  );
  if (!selected.patients.length) throw fail(404, 'Карточка не найдена.');
  return selected;
}
// Page DTOs contain at most fifty canonical upcoming records. History outcomes
// remain unchanged; this helper never turns a page into an editable full card.
function decoratePatientView(data, decorator) {
  if (data.viewUnsupported) return data;
  const entries = data.upcoming ? data.upcoming.entries : data.entries;
  if (!Array.isArray(entries) || entries.length > 50)
    throw fail(503, 'Некорректная страница записей.');
  const decorated = decorator(entries, data.patient);
  if (!data.upcoming) return { ...data, entries: decorated };
  const byId = new Map(decorated.map((appointment) => [appointment.id, appointment]));
  return {
    ...data,
    upcoming: { ...data.upcoming, entries: decorated },
    patient: {
      ...data.patient,
      appointments: data.patient.appointments.map(
        (appointment) => byId.get(appointment.id) || appointment,
      ),
    },
  };
}
function patientView(c, mode) {
  const data = c.tenantStore(c.current.organizationId).patientView(c.current, c.url);
  if (mode === 'history') return data;
  return decoratePatientView(
    data,
    (appointments, patient) =>
      c.appointmentState.decorate(
        {
          patients: [
            {
              ...(patient || {
                id: c.url.searchParams.get('id') || c.url.searchParams.get('patientId'),
              }),
              visits: [],
              appointments,
            },
          ],
        },
        c.current.organizationId,
        { readSnapshot: c.projectionSnapshotProof?.(), boundedCanonical: true },
      ).patients[0].appointments,
  );
}
const routes = [
  {
    method: 'POST',
    path: '/api/cabinet/time-zone',
    access: 'organization',
    async handle(c) {
      const values = await c.readBody(c.req);
      return c.json(c.res, 200, c.platform.updateOrganizationTimeZone(c.token, values));
    },
  },
  {
    method: 'GET',
    path: '/api/cabinet/time-zone',
    access: 'organization',
    handle(c) {
      return c.json(c.res, 200, {
        timeZone: c.platform.organizationTimeZone(c.current.organizationId),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/cabinet/bootstrap',
    access: 'organization',
    handle(c) {
      const timeZone = c.platform.organizationTimeZone(c.current.organizationId);
      const storage = c.tenantStore(c.current.organizationId);
      const paged = c.url.searchParams.get('paged') === '1';
      const snapshot = {
        ...storage.overview(
          c.current,
          paged
            ? (metadata) => ({
                ...metadata,
                ...directoryPage(storage, c.current, c.url, metadata, timeZone),
              })
            : undefined,
        ),
        ...c.platform.personalEvents?.view(c.current),
        serviceGroups: c.platform.serviceGroups(c.current.organizationId),
        serviceCatalog: c.platform.serviceCatalog(c.current.organizationId),
        timeZone,
      };
      if (paged) {
        return c.json(c.res, 200, {
          ...snapshot,
          partialWrites: true,
          appointmentWrites: true,
          idempotentWrites: true,
          lazyReads: true,
          pagedReads: true,
        });
      }
      return c.json(c.res, 200, {
        ...snapshot,
        partialWrites: true,
        appointmentWrites: true,
        idempotentWrites: true,
        lazyReads: true,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/cabinet/directory',
    access: 'organization',
    handle(c) {
      return c.json(
        c.res,
        200,
        directoryPage(
          c.tenantStore(c.current.organizationId),
          c.current,
          c.url,
          undefined,
          c.platform.organizationTimeZone(c.current.organizationId),
        ),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/cabinet/patient',
    access: 'organization',
    handle(c) {
      if (c.url.searchParams.get('view') === 'appointment') {
        const result = require('./appointment-edit161.cjs').readEditSnapshot(
          c.tenantStore(c.current.organizationId),
          c.current,
          c.url,
        );
        if (result.kind === 'appointment-edit-v1' && c.url.searchParams.get('details') === '1')
          result.displayAppointment = c.appointmentState.decorate(
            { patients: [{ ...result.patient, visits: [], appointments: [result.appointment] }] },
            c.current.organizationId,
            { boundedCanonical: true },
          ).patients[0].appointments[0];
        return c.json(c.res, 200, result);
      }
      if (c.url.searchParams.get('view') === 'card')
        return c.json(c.res, 200, patientView(c, 'card'));
      return c.json(
        c.res,
        200,
        c.appointmentState.decorate(
          selectedPatient(c, c.url.searchParams.get('id')),
          c.current.organizationId,
          { readSnapshot: c.projectionSnapshotProof?.() },
        ),
      );
    },
  },
  ...['history', 'upcoming'].map((mode) => ({
    method: 'GET',
    path: '/api/cabinet/patient/' + mode,
    access: 'organization',
    handle(c) {
      return c.json(c.res, 200, patientView(c, mode));
    },
  })),
  {
    method: 'GET',
    path: '/api/cabinet/calendar',
    access: 'organization',
    handle(c) {
      return calendarRead(c, calendarPeriod);
    },
  },
];
module.exports = { routes, calendarPeriod, selectedPatient, decoratePatientView };
