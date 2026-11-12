const { randomUUID } = require('node:crypto');
const { digest } = require('./catalog-sqlite.cjs');
const { createFixedReadOwnerPool166 } = require('./fixed-read-owner-pool166.cjs');
const { ArrayBuffer, Uint8Array } = globalThis;
const { createOperationCryptoCache } = require('./read-operation-crypto145.cjs');
const { createReadOperationClient } = require('./read-operation-client145.cjs');
const { operationScope, createOperationContext } = require('./read-operation-context145.cjs');
const { operationSources } = require('./read-operation-sources145.cjs');
const { createOperationCabinet } = require('./read-operation-cabinet145.cjs');
const { prepareCabinetRead } = require('./read-operation-route145.cjs');
const {
  createAppointmentStateReader,
} = require('../../modules/notifications/appointment-state-reader.cjs');
const {
  createNotificationCoordinator,
} = require('../../modules/notifications/notification-coordinator.cjs');
const { isPostgresReadOperation } = require('./read-operation-routes145.cjs');
const { readOperationStatus148 } = require('./read-operation-status148.cjs');
const { directoryPage } = require('../../modules/cabinet/directory.cjs');
const { createReadCacheBudget } = require('../read-cache-budget.cjs');
const { createReadViewCache } = require('../read-view-cache152.cjs');
const { authorityValue } = require('./read-session152.cjs');
const { createReadResultCache } = require('./read-result-cache153.cjs');
const { zonedClock } = require('../../../shared/time-zone.cjs');
const { fullDirectoryKey170, directoryClaimKey170 } = require('./directory-key170.cjs');
const {
  clinicalKey,
  nativeDirectory,
  nativeCalendar,
  nativeFullPatient,
  directoryStorage,
  operationStorage,
} = require('./read-clinical-views152.cjs');
async function createPostgresReadOperations(config, dependencies = {}) {
  if (config.storageBackend !== 'postgres' || config.postgresRevisionProfile !== 3) return null;
  const readCacheBudget = createReadCacheBudget({
    maxBytes: config.tenantReadCacheBytes ?? 8 * 1024 * 1024,
    ...(config.directoryMaxRows180 !== undefined
      ? { directoryMaxRows: config.directoryMaxRows180 }
      : {}),
  });
  const capacity166 = dependencies.readOwnerCapacity166 ?? 1;
  if (![1, 2].includes(capacity166)) throw Error('Invalid fixed read capacity166');
  const resultCache = createReadResultCache({ budget: readCacheBudget, maximumEntries: 1024 });
  const views = createReadViewCache({ budget: readCacheBudget, maximumEntries: 512 });
  const directoryResponses165 =
    require('./directory-response-cache165.cjs').createDirectoryResponseCache165({
      budget: readCacheBudget,
    });
  const directorySnapshots180 =
    config.nativeDirectorySnapshots180 === true
      ? require('./directory-snapshot-cache180.cjs').createDirectorySnapshotCache180({
          budget: readCacheBudget,
        })
      : null;
  const nativeViews = dependencies.readViewsEnabled !== false;
  const engines = [],
    cacheEpoch166 = randomUUID();
  let keyCache, ownerPool;
  try {
    for (let index = 0; index < capacity166; index++) {
      const engine = await createReadOperationClient(config, {
        ...dependencies,
        resultCache,
        cacheEpoch166,
      });
      engines.push(engine);
      if (digest(engine.marker) !== digest(engines[0].marker))
        throw Error('Fixed read owners have different asset lineages166');
    }
    keyCache = await createOperationCryptoCache(config.dataDir, engines[0].marker);
    ownerPool = createFixedReadOwnerPool166({ owners: engines });
  } catch (error) {
    await Promise.allSettled(engines.map((engine) => engine.close()));
    keyCache?.close();
    throw error;
  }
  async function run(engine, context, execution = {}) {
    const readStarted165 = Date.now();
    if (!isPostgresReadOperation(context.req)) return { unsupported: 'route' };
    if (![19, 20].includes(engine.marker.notificationSchema))
      return { unsupported: 'notification-schema' };
    const { current, url } = context;
    const platformOnly = ['/api/cabinet/time-zone', '/api/work-schedules'].includes(url.pathname);
    const selected = operationScope(engine.marker, current.organizationId);
    if (selected.unsupported) return selected;
    const directoryCandidate167 =
      nativeViews && url.pathname === '/api/cabinet/directory'
        ? fullDirectoryKey170({
            epoch: cacheEpoch166,
            storeId: selected.scope.storeId,
            current,
            url,
          })
        : null;
    const capturePlatformClocks167 =
      nativeViews &&
      !platformOnly &&
      ((url.pathname === '/api/cabinet/calendar' && url.searchParams.get('compact') === '1') ||
        (directoryCandidate167 !== null && directoryResponses165.has(directoryCandidate167)));
    const finish167 =
      typeof context.assertFreshAfterCommit167 === 'function'
        ? {
            token: context.token,
            async accept(rows) {
              const crypto = await keyCache.forPlatform(context.assertActive);
              const authority = authorityValue(rows, crypto.decode);
              await context.assertFreshAfterCommit167(authority);
            },
          }
        : null;
    const patientCapsule197 =
      nativeViews && finish167
        ? await require('./patient-capsule-context197.cjs').preparePatientOperation197({
            engine,
            scope: selected.scope,
            current,
            url,
            token: context.token,
            config,
            relativeDirectory: selected.relativeDirectory,
            keyCache,
            assertActive: context.assertActive,
          })
        : null;
    return engine.run(
      {
        scope: selected.scope,
        deferCatalog: nativeViews,
        platformOnly,
        capturePlatformClocks167,
        finish167,
        patientCapsule197,
        assertActive: context.assertActive,
        probeClass: execution.memoryClass === 'query-probe',
        requestMemoryClass: execution.requestMemoryClass,
      },
      async (operation) => {
        const prepared = await createOperationContext(
          config,
          operation,
          current,
          selected.relativeDirectory,
          keyCache,
          { platformOnly },
        );
        let coordinator, calendarVersion163;
        try {
          require('./patient-capsule-context197.cjs').validatePatientOperation197(
            operation,
            prepared,
            current,
          );
          if (url.pathname === '/api/cabinet/operation') {
            const status = await readOperationStatus148(operation, prepared, current, url);
            operation.assertActive();
            return context.json(context.res, 200, status);
          }
          if (!['owner', 'salon_admin', 'cosmetologist'].includes(current.role))
            throw Object.assign(Error('Нет доступа к картотеке.'), { status: 403 });

          if (platformOnly)
            return require('./read-background163.cjs').readBackground163(
              context,
              operation,
              prepared,
            );
          if (url.pathname === '/api/cabinet/calendar' && url.searchParams.get('compact') === '1') {
            const versions = await operation.scopedVersions163(current.organizationId);
            if (versions) {
              calendarVersion163 = require('./calendar-token163.cjs').calendarToken163({
                current,
                url,
                hash: prepared.hash,
                versions,
                runtime: [
                  context.telegram.status(),
                  ...['telegram', 'max'].map((c) => context.providers[c].status()),
                ],
                renderConfig: [
                  config.commonNotificationsEnabled === true,
                  config.notificationChannels || null,
                ],
              });
              const unchanged = calendarVersion163.read();
              if (unchanged) return context.json(context.res, 200, unchanged);
            }
          }
          if (
            url.pathname === '/api/cabinet/patient' &&
            url.searchParams.get('view') === 'appointment'
          ) {
            if (operation.cabinetCatalog.version !== 2)
              return context.json(context.res, 200, { appointmentViewUnsupported: true });
            const {
              editSelection,
              editSnapshot,
            } = require('../../modules/cabinet/appointment-edit161.cjs');
            const selection = editSelection(url);
            const capsule197 =
              url.searchParams.get('details') !== '1'
                ? operation.patientCapsule197?.({
                    kind: 'appointment',
                    id: selection.patientId,
                    appointmentId: selection.id,
                    audience:
                      current.role === 'cosmetologist'
                        ? prepared.hash('staff:' + current.accountId)
                        : '*',
                    cursor: { visit: 0, outcome: 0, upcoming: 0 },
                  })
                : null;
            const bound =
              capsule197?.bound ||
              (await operation.probe(
                operationSources(operation, { current, url, hash: prepared.hash }),
              ));
            if ((bound.sourceBounds.get('platform:booking_requests')?.bytes || 0) > 8 * 1024 * 1024)
              return { unsupported: 'streaming-booking-provenance' };
            const rows = capsule197?.rows || (await operation.selectView('appointment', selection));
            const profile = rows.find((r) => r.bucket === 'profile'),
              record = rows.find((r) => r.bucket === 'appointment'),
              revision = rows.find((r) => r.bucket === 'meta');
            const patient = profile && prepared.decode(profile.value),
              appointment = record && prepared.decode(record.value);
            if (
              (patient && patient.id !== selection.patientId) ||
              (appointment && appointment.id !== selection.id)
            )
              throw Error('Invalid canonical appointment edit');
            const result = editSnapshot(
              current,
              revision ? prepared.decode(revision.value) : 0,
              patient,
              appointment,
            );
            if (url.searchParams.get('details') === '1') {
              const platform = prepared.platform,
                org = current.organizationId;
              await platform.prefetchProjectionAsync(org, url.pathname);
              const storage = operationStorage(prepared, operation, result.revision);
              storage.readAppointment = (pid, id) =>
                pid === patient.id && id === appointment.id ? appointment : null;
              const tenantStore = (id) => {
                if (id !== org) throw Error('Cross-cabinet appointment edit');
                return storage;
              };
              const coordinator =
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
              const input = { patients: [{ ...patient, visits: [], appointments: [appointment] }] };
              await decorate.prepareAsync(input, org);
              result.displayAppointment = decorate(input, org, {
                readSnapshot: platform.projectionSnapshotProof(),
                boundedCanonical: true,
              }).patients[0].appointments[0];
            }
            return context.json(context.res, 200, result);
          }
          const cacheKey = clinicalKey(operation, current, url);
          let responseKey165;
          if (nativeViews && url.pathname === '/api/cabinet/directory') {
            responseKey165 = fullDirectoryKey170({
              epoch: operation.epoch,
              storeId: operation.scope.storeId,
              current,
              url,
            });
            if (directoryResponses165.has(responseKey165)) {
              const stamp = await operation.scopedVersions163(current.organizationId);
              const cached = directoryResponses165.get(responseKey165, stamp);
              if (cached) {
                operation.assertActive();
                return context.json(context.res, 200, JSON.parse(cached.json));
              }
            }
          }
          const finishDirectory165 = (response) => {
            const stamp = operation.capturedVersions165();
            if (
              responseKey165 &&
              stamp &&
              response?.status === 200 &&
              (response.body instanceof ArrayBuffer || response.body instanceof Uint8Array)
            ) {
              const timeZone = prepared.platform.organizationTimeZone(current.organizationId);
              const explicitToday = Boolean(url.searchParams.get('today'));
              operation.afterCommit165(() =>
                directoryResponses165.put(responseKey165, stamp, response.body, {
                  timeZone,
                  explicitToday,
                  renderedDay: zonedClock(readStarted165, timeZone).date,
                  // Only this accepted own-kernel JSON producer can publish a
                  // hint, and only after COMMIT ACK + fresh167 tail acceptance.
                  claimKey170:
                    finish167 && typeof engine.hotMetadata169 === 'function'
                      ? directoryClaimKey170({
                          epoch: cacheEpoch166,
                          platformStoreId: engine.marker.platformStoreId,
                          token: context.token,
                          headers: context.req.headers,
                          url,
                        })
                      : null,
                }),
              );
            }
            return response;
          };

          const paged =
            url.pathname.startsWith('/api/cabinet/patient/') ||
            (url.pathname === '/api/cabinet/patient' && url.searchParams.get('view') === 'card');
          if (paged)
            return require('./read-patient-page164.cjs').readPatientPage164({
              context,
              operation,
              prepared,
              current,
              url,
              config,
              nativeViews,
              views,
              cacheKey,
            });
          if (nativeViews && url.pathname === '/api/cabinet/directory') {
            const result = await require('./read-directory164.cjs').readDirectory164({
              context,
              operation,
              prepared,
              current,
              url,
              views,
              cacheKey,
              readCacheBudget,
              snapshots180:
                finish167 && typeof engine.hotMetadata169 === 'function'
                  ? directorySnapshots180
                  : null,
            });
            if (result !== null) return finishDirectory165(result);
          }
          const bound = await operation.probe(
            operationSources(operation, { current, url, hash: prepared.hash }),
            {
              witness: nativeViews,
              captureScopes163: nativeViews && url.pathname === '/api/cabinet/directory',
            },
          );
          // Exceptionally large legacy provenance keeps its existing streaming
          // implementation. This decision precedes clinical fetch/decode and is
          // never reached by swallowing a database/COMMIT/projection error.
          if ((bound.sourceBounds.get('platform:booking_requests')?.bytes || 0) > 8 * 1024 * 1024)
            return { unsupported: 'streaming-booking-provenance' };
          const platform = prepared.platform,
            org = current.organizationId;
          let storage, core;
          if (nativeViews && url.pathname === '/api/cabinet/directory') {
            let value = views.get(cacheKey, bound.clinicalWitness);
            if (!value) {
              value = await nativeDirectory(operation, prepared, current);
              views.put(cacheKey, bound.clinicalWitness, value);
            }
            await platform.prefetchProjectionAsync(org, url.pathname);
            operation.assertActive();
            return finishDirectory165(
              context.json(
                context.res,
                200,
                directoryPage(
                  directoryStorage(
                    prepared,
                    value,
                    operation,
                    readCacheBudget,
                    bound.clinicalWitness,
                  ),
                  current,
                  url,
                  value,
                  platform.organizationTimeZone(org),
                ),
              ),
            );
          }
          if (nativeViews && url.pathname === '/api/cabinet/calendar') {
            let value = views.get(cacheKey, bound.clinicalWitness);
            if (!value) {
              value = await nativeCalendar(operation, prepared, current, url);
              views.put(cacheKey, bound.clinicalWitness, value);
            }
            storage = operationStorage(prepared, operation, value.snapshot.revision, value);
            core = { ...value.plan, patients: value.patients, kind: 'calendar' };
          } else if (nativeViews && url.pathname === '/api/cabinet/patient') {
            core = await nativeFullPatient(operation, prepared, current, url);
            storage = operationStorage(prepared, operation, core.revision);
          } else {
            await platform.prefetchProjectionAsync(org, url.pathname);
            storage = await createOperationCabinet({
              db: prepared.cabinetDb,
              encode: prepared.encode,
              decode: prepared.decode,
              hash: prepared.hash,
              directory: prepared.directory,
              schemaVersion: operation.cabinetCatalog.version,
              readCacheBudget: prepared.readCacheBudget,
              epoch: operation.epoch,
            });
            core = await prepareCabinetRead({
              storage,
              current,
              url,
              timeZone: platform.organizationTimeZone(org),
            });
          }
          if (nativeViews) await platform.prefetchProjectionAsync(org, url.pathname);
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
          if (core.kind !== 'directory')
            await decorate.prepareAsync({ patients: core.patients }, org);
          operation.assertActive();
          if (core.kind === 'patient') {
            const { kind: _kind, ...cabinet } = core;
            return context.json(
              context.res,
              200,
              decorate(cabinet, org, { readSnapshot: platform.projectionSnapshotProof() }),
            );
          }
          return context.handler.handle({
            ...context,
            platform,
            tenantStore,
            appointmentState: { decorate },
            projectionSnapshotProof: platform.projectionSnapshotProof,
            calendarVersion163,
          });
        } finally {
          coordinator?.stop();
          prepared.close();
        }
      },
    );
  }
  const unavailable166 = () =>
    Object.assign(Error('PostgreSQL read owner is unavailable166'), {
      status: 503,
      code: 'POSTGRES_READ_OWNER_UNAVAILABLE166',
    });
  async function authorize(engine, token, assertActive) {
    const crypto = await keyCache.forPlatform(assertActive);
    const rows = await engine.authority(token, assertActive);
    return authorityValue(rows, crypto.decode);
  }
  function borrow166() {
    const slot = ownerPool.borrow166();
    if (!slot) return null;
    const engine = slot.owner;
    let released = false,
      pending = 0;
    async function invoke(callback) {
      if (released || pending) throw unavailable166();
      pending++;
      try {
        return await callback();
      } finally {
        pending--;
        if (released && !pending) slot.release();
      }
    }
    return {
      run: (context, execution) => invoke(() => run(engine, context, execution)),
      authorize: (token, assertActive) => invoke(() => authorize(engine, token, assertActive)),
      prepareHotCalendar169:
        nativeViews && typeof engine.hotMetadata169 === 'function'
          ? (input) =>
              invoke(() =>
                require('./hot-calendar169.cjs').prepareHotCalendar169({
                  ...input,
                  engine,
                  keyCache,
                  config,
                }),
              )
          : null,
      prepareHotDirectory170:
        nativeViews && typeof engine.hotMetadata169 === 'function'
          ? (input) =>
              invoke(() =>
                require('./hot-directory170.cjs').prepareHotDirectory170({
                  ...input,
                  engine,
                  keyCache,
                  config,
                  epoch: cacheEpoch166,
                  cache: directoryResponses165,
                  snapshots180: directorySnapshots180,
                }),
              )
          : null,
      sqlCalls: engine.sqlCalls,
      release() {
        if (released) return;
        released = true;
        // A cancellation may ask to release while an awaited SQL is draining.
        // Keep the physical client leased until its own operation finally ends.
        if (!pending) slot.release();
      },
    };
  }
  async function oneShot(method, args) {
    const borrowed = borrow166();
    if (!borrowed) throw unavailable166();
    try {
      return await borrowed[method](...args);
    } finally {
      borrowed.release();
    }
  }
  let closing;
  return {
    capacity166,
    borrow166,
    // Compatibility for callers doing one independent operation. Kernel runs
    // use the explicit lease above through pre- and post-authority.
    run: (...args) => oneShot('run', args),
    authorize: (...args) => oneShot('authorize', args),
    readCacheBudget,
    viewStats: () => ({
      ...views.stats(),
      sqlResults: resultCache.stats(),
      directoryResponses165: directoryResponses165.stats(),
      ...(directorySnapshots180 ? { directorySnapshots180: directorySnapshots180.stats() } : {}),
      ...(directorySnapshots180 ? { directory196: directorySnapshots180.stats196() } : {}),
    }),
    ownerStats166: ownerPool.stats,
    sqlCalls: () => engines.reduce((sum, engine) => sum + engine.sqlCalls(), 0),
    close() {
      if (!closing)
        closing = (async () => {
          try {
            await ownerPool.close();
          } finally {
            directorySnapshots180?.clear();
            directoryResponses165.clear();
            resultCache.clear();
            views.clear();
            keyCache.close();
          }
        })();
      return closing;
    },
  };
}
module.exports = { createPostgresReadOperations };
