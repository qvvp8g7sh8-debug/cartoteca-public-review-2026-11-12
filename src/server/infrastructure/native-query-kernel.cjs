const { ArrayBuffer, Int32Array, Atomics } = globalThis;
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createQueryDiagnostics } = require('./native-query-diagnostics140.cjs');
const { fail } = require('../../shared/errors.cjs');
const { secureRequest } = require('../http/security.cjs');
const { createNativeQueryPlatform } = require('./native-query-platform.cjs');
const { createTenantPool } = require('./tenant-pool.cjs');
const { createStorage } = require('./cabinet-storage.cjs');
const { isPostgresReadOperation } = require('./postgres/read-operation-routes145.cjs');
const { hotCalendarCandidate169 } = require('./postgres/hot-calendar169.cjs');
const { createReadCacheBudget } = require('./read-cache-budget.cjs');
const {
  createAppointmentStateReader,
} = require('../modules/notifications/appointment-state-reader.cjs');
const {
  createNotificationCoordinator,
} = require('../modules/notifications/notification-coordinator.cjs');
// Closed, effect-free GET projection. Mutations stay with the single web owner;
// the existing bounded executor, fresh scope checks and cancellation still apply.
const queryRoutes = new Set([
  '/api/cabinet/bootstrap',
  '/api/cabinet/directory',
  '/api/cabinet/patient',
  '/api/cabinet/patient/history',
  '/api/cabinet/patient/upcoming',
  '/api/cabinet/calendar',
  '/api/cabinet/operation',
  '/api/cabinet/time-zone',
  '/api/work-schedules',
  '/api/workspace',
  '/api/workspace/availability',
  '/api/service-groups',
]);
const handlers = new Map(
  [
    ...require('../modules/cabinet/queries.cjs').routes,
    ...require('../modules/cabinet/routes.cjs').routes,
    ...require('../modules/schedules/routes.cjs').routes,
    ...require('../modules/workspace/routes.cjs').routes,
    ...require('../modules/services/routes.cjs').routes,
  ]
    .filter((route) => route.method === 'GET' && queryRoutes.has(route.path))
    .map((route) => [route.path, route]),
);
function isNativeQuery(req) {
  if (req.method !== 'GET' || typeof req.url !== 'string') return false;
  try {
    return queryRoutes.has(new URL(req.url, 'http://native.invalid').pathname);
  } catch {
    return false;
  }
}
function runtimeSnapshot(runtime) {
  const age = Date.now() - runtime?.timestamp;
  // This is the owner's last transport observation, never delivery authority.
  // Busy owner JSON/SQL must not turn otherwise independent calendar reads off.
  if (!Number.isFinite(age) || age < -1000 || !Number.isSafeInteger(runtime.timestamp))
    throw fail(503, 'Состояние уведомлений временно недоступно. Повторите запрос.');
  for (const value of [runtime.telegram, runtime.providers?.telegram, runtime.providers?.max])
    if (
      !value ||
      typeof value.configured !== 'boolean' ||
      typeof value.connected !== 'boolean' ||
      typeof value.botId !== 'string' ||
      value.botId.length > 128
    )
      throw fail(503, 'Состояние уведомлений временно недоступно. Повторите запрос.');
  if (JSON.stringify(runtime).length > 4096)
    throw fail(503, 'Состояние уведомлений временно недоступно. Повторите запрос.');
  return runtime;
}
function response(status, headers, value) {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > 64 * 1024 * 1024) throw fail(503, 'Ответ слишком велик. Уточните запрос.');
  // Exactly owned output bytes transfer to the public loop without a decoded
  // clinical object graph, a pooled Buffer slab, or another full byte copy.
  const owned = new ArrayBuffer(bytes);
  Buffer.from(owned).write(serialized);
  return {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
    body: owned,
  };
}
// Internal caller passes only the admitted immutable JSON of a prior accepted
// kernel response. UTF-8 bytes are independently owned for every transfer.
function responseSerialized170(headers, serialized) {
  if (typeof serialized !== 'string') throw fail(503, 'Подготовленный ответ недоступен.');
  const bytes = Buffer.byteLength(serialized);
  if (bytes > 64 * 1024) throw fail(503, 'Подготовленный ответ слишком велик.');
  const owned = new ArrayBuffer(bytes);
  if (Buffer.from(owned).write(serialized) !== bytes)
    throw fail(503, 'Подготовленный ответ недоступен.');
  return {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
    body: owned,
  };
}
function createNativeQueryKernel(config, { readOperations = null } = {}) {
  const platform = createNativeQueryPlatform(config);
  const budget =
    readOperations?.readCacheBudget ||
    createReadCacheBudget({
      maxBytes: config.tenantReadCacheBytes ?? 16 * 1024 * 1024,
    });
  const pool = createTenantPool({
    limit: config.tenantCacheLimit || 8,
    idleMs: config.tenantIdleMs || 0,
    open(org, observeOpen) {
      const organization = platform.organization(org);
      return createStorage(
        organization.legacyData ? config.dataDir : path.join(config.dataDir, 'tenants', org),
        {
          readCacheBudget: budget,
          observeOpen,
          databaseOwner: config.databaseOwner,
          databaseRoot: config.dataDir,
          cabinetSchema: config.cabinetSchema || 0,
          photoOrganizationId: org,
        },
      );
    },
  });
  const diagnostics = createQueryDiagnostics(
    config.databaseOwner,
    pool,
    () => readOperations?.sqlCalls() || 0,
  );
  let closing166 = false,
    closePromise166,
    active166 = 0,
    drained166;
  async function run(metadata, cancellation, execution = {}) {
    active166++;
    let operations166 = readOperations,
      borrowed166 = null,
      ownerError166 = null,
      rpcCalls166 = 0,
      measuringRpc166 = false;
    const unavailable166 = () =>
      Object.assign(fail(503, 'Исполнитель временно занят.'), {
        code: 'POSTGRES_READ_OWNER_UNAVAILABLE166',
      });
    if (closing166) ownerError166 = unavailable166();
    else if (readOperations?.borrow166) {
      try {
        borrowed166 = readOperations.borrow166();
        operations166 = borrowed166;
        if (!borrowed166) ownerError166 = unavailable166();
      } catch (error) {
        ownerError166 = error;
      }
    }
    // SQL deltas belong to this exclusively leased physical client. Blocking
    // compatibility RPCs are counted only inside this job's synchronous phases.
    const observation = diagnostics.begin({
      operationSqlCalls: () => operations166?.sqlCalls() || 0,
      rpcCalls: () => rpcCalls166,
    });
    function synchronous166(callback) {
      if (measuringRpc166) return callback();
      measuringRpc166 = true;
      const calls = config.databaseOwner?.stats?.().calls || 0;
      try {
        return callback();
      } finally {
        rpcCalls166 += Math.max(0, (config.databaseOwner?.stats?.().calls || 0) - calls);
        measuringRpc166 = false;
      }
    }
    let status = 500;
    const respond = (code, headers, value) => {
      status = code;
      return observation.phase('serializeMs', () => response(code, headers, value));
    };
    const headers = {};
    const cancelled = () =>
      cancellation &&
      Atomics.load(
        cancellation instanceof Int32Array ? cancellation : new Int32Array(cancellation),
        0,
      ) !== 0;
    const assertActive = () => {
      if (cancelled()) throw fail(499, 'Запрос отменён.');
    };
    const lease = pool.lease();
    try {
      if (ownerError166) throw ownerError166;
      assertActive();
      if (
        !metadata ||
        !isNativeQuery(metadata) ||
        metadata.url.length > 8192 ||
        !metadata.headers ||
        JSON.stringify(metadata.headers).length > 16384
      )
        throw fail(400, 'Некорректный запрос.');
      const req = {
        ...metadata,
        socket: { localPort: metadata.localPort, remoteAddress: metadata.remoteAddress },
      };
      const res = {
        setHeader: (name, value) => {
          headers[name] = value;
        },
      };
      const expectedOrigin = secureRequest(
        req,
        res,
        config.origin || '',
        config.additionalOrigins || [],
      );
      if (config.releaseGate) {
        headers['Retry-After'] = '30';
        throw fail(503, 'Идёт обновление картотеки. Попробуйте через несколько секунд.');
      }
      const url = new URL(metadata.url, expectedOrigin);
      observation.route(url.pathname);
      const token =
        (metadata.headers.cookie || '')
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith('cartoteca_v2_session='))
          ?.slice('cartoteca_v2_session='.length) || '';
      const requireCurrent = () =>
        synchronous166(() => {
          assertActive();
          const current = platform.session(token);
          if (!current) throw fail(401, 'Войдите в картотеку.');
          return current;
        });
      const contextMatches = (current) => {
        if (
          typeof metadata.headers['x-cartoteca-account-id'] !== 'string' ||
          typeof metadata.headers['x-cartoteca-organization-id'] !== 'string' ||
          metadata.headers['x-cartoteca-account-id'] !== current.accountId ||
          metadata.headers['x-cartoteca-organization-id'] !== (current.organizationId || '')
        )
          throw Object.assign(fail(428, 'Аккаунт изменился. Обновите страницу картотеки.'), {
            code: 'AUTH_CONTEXT_CHANGED',
          });
      };
      let coldAuthority171 = null,
        acceptedCold171 = false;
      const acceptColdAuthority171 = (value) => {
        assertActive();
        if (acceptedCold171 || !value || typeof value !== 'object')
          throw fail(503, 'Проверка доступа уже завершена.');
        acceptedCold171 = true;
        coldAuthority171 = value;
      };
      // This optional metadata-only path never creates a clinical operation.
      // Preparation awaits SQL and fresh assets; final acceptance is synchronous
      // here, so no await separates fresh authority/expiry/HMAC from owned output.
      if (operations166?.prepareHotCalendar169 && hotCalendarCandidate169(url, metadata.headers)) {
        const finish169 = await observation.phaseAsync('authMs', () =>
          operations166.prepareHotCalendar169({
            url,
            token,
            headers: metadata.headers,
            assertActive,
          }),
        );
        if (finish169) {
          const hot169 = finish169({
            acceptColdAuthority171,
            contextMatches,
            runtime: () => runtimeSnapshot(metadata.runtime),
            respond: (runtime, value) => {
              headers['X-Cartoteca-Provider-Observed-At'] = String(runtime.timestamp);
              headers['X-Cartoteca-Provider-Status'] =
                Date.now() - runtime.timestamp > 5000 ? 'stale' : 'current';
              return respond(200, headers, value);
            },
          });
          if (hot169) return hot169;
        }
      }
      if (operations166?.prepareHotDirectory170 && url.pathname === '/api/cabinet/directory') {
        const finish170 = await observation.phaseAsync('authMs', () =>
          operations166.prepareHotDirectory170({
            url,
            token,
            headers: metadata.headers,
            assertActive,
          }),
        );
        if (finish170) {
          const hot170 = finish170({
            acceptColdAuthority171,
            contextMatches,
            runtime: () => runtimeSnapshot(metadata.runtime),
            respondSerialized: (runtime, serialized) => {
              headers['X-Cartoteca-Provider-Observed-At'] = String(runtime.timestamp);
              headers['X-Cartoteca-Provider-Status'] =
                Date.now() - runtime.timestamp > 5000 ? 'stale' : 'current';
              status = 200;
              return observation.phase('serializeMs', () =>
                responseSerialized170(headers, serialized),
              );
            },
          });
          if (hot170) return hot170;
        }
      }
      let nativeAuthority = false;
      const current = await observation.phaseAsync('authMs', async () => {
        let value = coldAuthority171;
        coldAuthority171 = null;
        if (value) {
          assertActive();
          if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now())
            throw fail(401, 'Войдите в картотеку.');
          // Keep the ordinary owning RR and its fresh post-COMMIT authority.
          // The metadata proof is ONLY this job's initial authority, not S2 data.
          nativeAuthority = true;
        }
        if (!value && operations166?.authorize && isPostgresReadOperation(req)) {
          const authority = await operations166.authorize(token, assertActive);
          if (authority.supported) {
            nativeAuthority = true;
            value = authority.current;
            if (!value) throw fail(401, 'Войдите в картотеку.');
          }
        }
        value ||= requireCurrent();
        contextMatches(value);
        return value;
      });
      if (current.globalAdmin)
        throw fail(403, 'Главному администратору недоступны данные картотеки.');
      if (!current.organizationId) throw fail(403, 'Выберите кабинет.');
      const assertCurrent = () =>
        observation.phase('authMs', () => {
          const fresh = requireCurrent();
          contextMatches(fresh);
          if (
            ['accountId', 'organizationId', 'role', 'globalAdmin'].some(
              (key) => current[key] !== fresh[key],
            )
          )
            throw fail(403, 'Доступ изменился. Повторите операцию.');
          return fresh;
        });
      let finalized167 = false;
      const validateFreshAuthority167 = (authority) => {
        assertActive();
        if (!authority.supported) throw fail(403, 'Доступ изменился. Повторите операцию.');
        const fresh = authority.current;
        if (!fresh) throw fail(401, 'Войдите в картотеку.');
        contextMatches(fresh);
        if (
          ['accountId', 'organizationId', 'role', 'globalAdmin'].some(
            (key) => current[key] !== fresh[key],
          )
        )
          throw fail(403, 'Доступ изменился. Повторите операцию.');
        return fresh;
      };
      const assertFreshCurrent = async () => {
        if (!nativeAuthority) return assertCurrent();
        return observation.phaseAsync('authMs', async () => {
          assertActive();
          return validateFreshAuthority167(await operations166.authorize(token, assertActive));
        });
      };
      const assertFreshAfterCommit167 = (authority) =>
        observation.phase('authMs', () => {
          const fresh = validateFreshAuthority167(authority);
          finalized167 = true;
          return fresh;
        });
      const runtime = runtimeSnapshot(metadata.runtime);
      headers['X-Cartoteca-Provider-Observed-At'] = String(runtime.timestamp);
      headers['X-Cartoteca-Provider-Status'] =
        Date.now() - runtime.timestamp > 5000 ? 'stale' : 'current';
      const providers = Object.fromEntries(
        ['telegram', 'max'].map((channel) => [
          channel,
          { status: () => runtime.providers[channel] },
        ]),
      );
      if (operations166 && isPostgresReadOperation(req)) {
        const at = performance.now();
        observation.projectionStart();
        let selected;
        try {
          if (acceptedCold171) {
            assertActive();
            if (current.expiresAt <= Date.now()) throw fail(401, 'Войдите в картотеку.');
          }
          selected = await operations166.run(
            {
              req,
              res,
              url,
              current,
              token,
              assertActive,
              assertCurrent,
              ...(nativeAuthority ? { assertFreshAfterCommit167 } : {}),
              providers,
              handler: handlers.get(url.pathname),
              telegram: { status: () => runtime.telegram },
              json: (_res, code, value) => respond(code, headers, value),
            },
            execution,
          );
        } finally {
          observation.projection(performance.now() - at);
        }
        if (!selected?.unsupported) {
          if (!finalized167) await assertFreshCurrent();
          return selected;
        }
        // Only an explicit pre-fetch compatibility decision may use legacy.
        // SQL/COMMIT/decoder failures are never converted into an automatic retry.
        if (execution.memoryClass === 'query-probe') await execution.requestMemoryClass('query');
        assertCurrent();
      }
      const coordinator =
        config.commonNotificationsEnabled === true
          ? createNotificationCoordinator({
              platform,
              tenantStore: lease.get,
              store: platform.notificationStore,
              links: platform.maxLinks,
              providers,
            })
          : null;
      const appointmentState = {
        decorate: createAppointmentStateReader({
          platform,
          store: platform.telegram,
          tenantStore: lease.get,
          coordinator,
        }),
      };
      let result;
      const projectionStarted = performance.now();
      observation.projectionStart();
      try {
        synchronous166(() =>
          platform.withProjectionSnapshot(current.organizationId, () => {
            platform.prefetchProjection(current.organizationId, url.pathname);
            return handlers.get(url.pathname).handle({
              req,
              res,
              url,
              current,
              platform,
              token,
              tenantStore: lease.get,
              assertCurrent,
              telegram: { status: () => runtime.telegram },
              appointmentState,
              projectionSnapshotProof: platform.projectionSnapshotProof,
              json: (_res, status, value) => {
                assertActive();
                result = respond(status, headers, value);
                return result;
              },
            });
          }),
        );
      } finally {
        observation.projection(performance.now() - projectionStarted);
      }
      assertCurrent();
      return result;
    } catch (error) {
      if (error.status === 429 || (error.status === 503 && error.retryAfter))
        headers['Retry-After'] = String(error.retryAfter || 900);
      return respond(error.status || 500, headers, {
        error: error.status ? error.message : 'Не удалось выполнить операцию.',
        ...(['AUTH_CONTEXT_CHANGED', 'TENANT_POOL_CAPACITY'].includes(error.code)
          ? { code: error.code }
          : {}),
      });
    } finally {
      try {
        synchronous166(() => lease.release());
      } finally {
        try {
          observation.finish(status);
        } finally {
          try {
            borrowed166?.release();
          } finally {
            active166--;
            if (!active166) drained166?.();
          }
        }
      }
    }
  }
  return {
    run,
    stats() {
      const readViews = readOperations?.viewStats?.();
      return {
        ...diagnostics.stats(),
        ...(readViews
          ? {
              version: Object.hasOwn(readViews, 'directoryResponses165') ? 3 : 2,
              readViews,
            }
          : {}),
      };
    },
    close() {
      if (!closePromise166) {
        closing166 = true;
        const drained = active166
          ? new Promise((resolve) => {
              drained166 = resolve;
            })
          : Promise.resolve();
        closePromise166 = (async () => {
          // Stop new owner borrows, then await active SQL/authority/finally
          // cleanup before retiring the shared platform and retained budget.
          const results = await Promise.allSettled([
            Promise.resolve().then(() => readOperations?.close()),
            drained,
          ]);
          try {
            pool.close();
          } finally {
            try {
              platform.close();
            } finally {
              budget.clear();
            }
          }
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
        })();
      }
      return closePromise166;
    },
  };
}
module.exports = { queryRoutes, isNativeQuery, runtimeSnapshot, createNativeQueryKernel };
