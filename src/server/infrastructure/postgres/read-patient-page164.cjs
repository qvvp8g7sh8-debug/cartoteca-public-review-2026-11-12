const { createPatientHistoryReader } = require('../patient-history-read145.cjs');
const { nativePatientPage } = require('./read-clinical-views152.cjs');
const {
  preparePatientCapsule197,
  patientCapsule197,
  projectPatientCapsule197,
} = require('./read-patient-capsule197.cjs');
const { operationSources } = require('./read-operation-sources145.cjs');
const { decoratePatientView } = require('../../modules/cabinet/queries.cjs');
const {
  createAppointmentStateReader,
} = require('../../modules/notifications/appointment-state-reader.cjs');
const {
  createNotificationCoordinator,
} = require('../../modules/notifications/notification-coordinator.cjs');

const patientTables = new Set([
  'telegram_links',
  'telegram_confirmations',
  'telegram_jobs',
  'appointment_manual_confirmations',
  'notification_confirmations',
  'notification_channel_jobs',
  'max_client_links',
]);
function platformPageSources(operation, current, url, hash, patientId) {
  return operationSources(operation, { current, url, hash, platformOnly: true }).map((source) => {
    // All existing response batches on these closed tables use only this
    // patient's entries. Actor/staff authority and encrypted booking provenance
    // retain their separate organization-wide bounds.
    const columns = source.catalog.tables[source.table]?.columns;
    if (
      !patientTables.has(source.table) ||
      !columns?.some((column) => column.name === 'patient_id')
    )
      return source;
    return {
      ...source,
      where: source.where + ' AND s.patient_id=$' + (source.values.length + 2),
      values: [...source.values, patientId],
    };
  });
}

// The index hint grants no visibility and lends no clinical value. The existing
// canonical projector still verifies every manifest, staff witness and record.
async function readPatientPage164({
  context,
  operation,
  prepared,
  current,
  url,
  config,
  nativeViews,
  views,
  cacheKey,
}) {
  const reader = createPatientHistoryReader({
    db: prepared.cabinetDb,
    encode: prepared.encode,
    decode: prepared.decode,
    hash: prepared.hash,
    schemaVersion: operation.cabinetCatalog.version,
  });
  if (!reader.supported) return context.json(context.res, 200, { viewUnsupported: true });
  const historyOnly = url.pathname.endsWith('/history');
  const id = reader.parameters(current, url).id;
  const capsule197 = nativeViews
    ? patientCapsule197(
        operation,
        preparePatientCapsule197({
          url,
          current,
          crypto: prepared,
          catalog: operation.cabinetCatalog,
        }),
      )
    : null;
  const pageBound =
    capsule197?.bound ||
    (await operation.probe(reader.sources(operation, current, url), {
      witness: nativeViews,
      ...(!historyOnly
        ? {
            patientPageHint165: {
              id,
              audience:
                current.role === 'cosmetologist'
                  ? prepared.hash('staff:' + current.accountId)
                  : '*',
            },
          }
        : {}),
    }));
  if (!historyOnly && typeof pageBound.patientPageEmpty165 !== 'boolean')
    throw Object.assign(Error('Patient page index hint is invalid.'), {
      status: 503,
      code: 'POSTGRES_PATIENT_PAGE_SELECTION',
    });
  const emptyCandidate = historyOnly || pageBound.patientPageEmpty165;
  const platformBound = !emptyCandidate
    ? await operation.probe(
        [
          ...platformPageSources(operation, current, url, prepared.hash, id),
          {
            scope: operation.scope,
            catalog: operation.cabinetCatalog,
            table: 'meta',
            where: "s.key LIKE 'booking-accepted:%'",
            values: [],
          },
        ],
        { witness: nativeViews },
      )
    : null;
  // Keep the explicit large-provenance compatibility decision before any
  // clinical fetch/decode. Errors after fetch never select another reader.
  if ((platformBound?.sourceBounds.get('platform:booking_requests')?.bytes || 0) > 8 * 1024 * 1024)
    return { unsupported: 'streaming-booking-provenance' };
  let value = nativeViews ? views.get(cacheKey, pageBound.clinicalWitness) : null;
  if (!value) {
    value = capsule197
      ? projectPatientCapsule197(capsule197, reader, current, url)
      : nativeViews
        ? await nativePatientPage(operation, prepared, current, url, reader)
        : await reader.readAsync(current, url);
    if (nativeViews) {
      if (capsule197)
        operation.afterCommit165(() => views.put(cacheKey, pageBound.clinicalWitness, value));
      else views.put(cacheKey, pageBound.clinicalWitness, value);
    }
  }
  if (historyOnly) return context.json(context.res, 200, value);
  const appointments = value.upcoming ? value.upcoming.entries : value.entries;
  if (!appointments.length) return context.json(context.res, 200, value);
  if (emptyCandidate)
    throw Object.assign(Error('Patient page index hint disagrees with its canonical projection.'), {
      status: 503,
      code: 'POSTGRES_PATIENT_PAGE_SELECTION',
    });
  const platform = prepared.platform,
    org = current.organizationId;
  let coordinator;
  try {
    await platform.prefetchProjectionAsync(org, url.pathname);
    const statement = prepared.cabinetDb.prepare('SELECT value FROM meta WHERE key=?');
    const storage = {
      get(key, fallback) {
        const row = statement.get(key);
        return row ? prepared.decode(row.value) : fallback;
      },
      prefetchMeta: (keys) =>
        prepared.cabinetDb.prefetchAll(keys.map((key) => statement.readRequest('get', [key]))),
    };
    const tenantStore = (id) => {
      operation.assertActive();
      if (id !== org) throw Error('Cross-cabinet operation');
      return storage;
    };
    coordinator =
      config.commonNotificationsEnabled === true
        ? createNotificationCoordinator({
            platform,
            tenantStore,
            store: platform.notificationStore,
            links: platform.maxLinks,
            providers: context.providers,
          })
        : null;
    const decorate = createAppointmentStateReader({
      platform,
      store: platform.telegram,
      tenantStore,
      coordinator,
    });
    const patients = [
      {
        ...(value.patient || {
          id: url.searchParams.get('id') || url.searchParams.get('patientId'),
        }),
        visits: [],
        appointments,
      },
    ];
    await decorate.prepareAsync({ patients }, org);
    const result = decoratePatientView(
      value,
      () =>
        decorate({ patients }, org, { readSnapshot: platform.projectionSnapshotProof() })
          .patients[0].appointments,
    );
    operation.assertActive();
    return context.json(context.res, 200, result);
  } finally {
    coordinator?.stop();
  }
}
module.exports = { readPatientPage164 };
