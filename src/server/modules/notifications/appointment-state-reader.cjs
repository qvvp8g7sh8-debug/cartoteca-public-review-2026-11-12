const { appointmentRows, pairKey } = require('./appointment-state-batch.cjs');

// Input is already filtered by the HTTP role/tenant boundary. This reader does
// not discover patients or grant access; it decorates only the supplied rows.
function createAppointmentStateReader({ platform, store, tenantStore, coordinator }) {
  function read(
    cabinet,
    org,
    responseFrame = false,
    readSnapshot = null,
    boundedCanonical = false,
  ) {
    store.prefetchReads?.(store.settings.readRequests?.(org) || []);
    const settings = store.settings(org),
      zone = settings.timeZone;
    const entries = appointmentRows(cabinet.patients, zone, platform.appointmentConfirmations);
    coordinator?.prefetchResponseReads?.(org, cabinet.patients, entries);
    const telegram = store.confirmedMany(org, entries),
      manual = platform.appointmentConfirmations.readMany(org, entries),
      delivery = coordinator?.describeMany(org, cabinet.patients, {
        zone,
        entries,
        // Borrow only values read in this owning synchronous response snapshot.
        responseRead: responseFrame
          ? {
              organizationId: org,
              zone,
              settings,
              entries,
              legacy: telegram,
              manual,
              readSnapshot,
              sourcePatients: cabinet.patients,
              boundedCanonical,
            }
          : null,
      });
    const stamps = new Map(
      entries.map((row) => [pairKey(row.patient, row.appointment), row.stamp]),
    );
    const online =
      platform.bookingRequests?.appointmentSources?.(org, cabinet.patients, tenantStore(org)) ||
      new Set();
    return {
      ...cabinet,
      patients: cabinet.patients.map((p) => ({
        ...p,
        appointments: p.appointments.map((a) => {
          const key = pairKey(p.id, a.id);
          return {
            ...a,
            bookingSource: online.has(key) ? 'online' : undefined,
            telegramConfirmedAt: telegram.get(key) || null,
            manualConfirmedAt: null,
            manualConfirmedBy: '',
            ...manual.get(key),
            confirmationKey: stamps.get(key),
            ...delivery?.get(key),
          };
        }),
      })),
    };
  }
  const decorate = (cabinet, org, { readSnapshot = null, boundedCanonical = false } = {}) => {
    const snapshot = platform.withNotificationReadSnapshot || platform.withReadSnapshot;
    return snapshot
      ? snapshot.call(platform, () => read(cabinet, org, true, readSnapshot, boundedCanonical))
      : read(cabinet, org, boundedCanonical, readSnapshot, boundedCanonical);
  };
  decorate.prepareAsync = async (cabinet, org) => {
    const prefetch = store.prefetchReadsAsync;
    if (!prefetch) throw Error('Asynchronous appointment projection is unavailable');
    await prefetch(store.settings.readRequests?.(org) || []);
    const settings = store.settings(org);
    const entries = appointmentRows(
      cabinet.patients,
      settings.timeZone,
      platform.appointmentConfirmations,
    );
    await prefetch([
      ...(store.confirmedMany.readRequests?.(org, entries) || []),
      ...(platform.appointmentConfirmations.readMany.readRequests?.(org, entries) || []),
      ...(coordinator?.responseReadRequests?.(org, cabinet.patients, entries) || []),
    ]);
    await prefetch(
      platform.appointmentConfirmations.readMany.actorReadRequests?.(org, entries) || [],
    );
    await platform.bookingRequests?.appointmentSources?.prepareAsync?.(
      org,
      cabinet.patients,
      tenantStore(org),
    );
  };
  return decorate;
}

module.exports = { createAppointmentStateReader };
