const { SESSION_MS } = require('../infrastructure/platform-constants.cjs');
const { createJsonBodyScope } = require('./json-body-budget.cjs');
const { json, readBody } = require('./responses.cjs');
const { secureRequest } = require('./security.cjs');
const { serveStatic } = require('./static-files.cjs');
const { prepareStatic } = require('./static-snapshot.cjs');
const { fail } = require('../../shared/errors.cjs');
const { organizationUsage } = require('../infrastructure/organization-usage.cjs');
const { readBackupStatus } = require('../infrastructure/backup/status.cjs');
const { servePhoto } = require('./photo-response.cjs');
const { createRequestWork, createPhotoWork } = require('./request-work.cjs');
const { createAssistantResponseTiming } = require('./assistant-timing-response.cjs');

const cookieName = 'cartoteca_v2_session';

function createRequestHandler({
  config,
  platform,
  pool,
  routes,
  metrics,
  requestDispatcher,
  clientAddress,
  sendMail,
  services,
  assetRoot,
}) {
  // API-only native command handlers have no interface root.
  if (assetRoot !== undefined) prepareStatic(assetRoot);
  const { origin, dataDir } = config;
  const {
    telegram,
    appointmentState,
    notificationCoordinator,
    maxConnections,
    maxRuntime,
    staffMax,
    support,
    calendarFeeds,
    staffPush,
    adminEmail,
  } = services;
  const setCookie = (res, token) =>
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? SESSION_MS / 1000 : 0}${origin.startsWith('https://') ? '; Secure' : ''}`,
    );
  const assertMailAvailable = () => {
    if (!sendMail) throw fail(503, 'Отправка почты не подключена. Обратитесь к владельцу сервиса.');
  };
  async function sendLink(email, route, token, kind, requestOrigin) {
    assertMailAvailable();
    const link = `${origin || requestOrigin || `http://127.0.0.1:${config.port}`}/#${route}=${encodeURIComponent(token)}`;
    try {
      await sendMail(email, link, { kind });
    } catch {
      throw fail(503, 'Не удалось отправить письмо. Попробуйте ещё раз позже.');
    }
  }
  async function handleRequest(req, res) {
    const measurement = metrics.track(req, res);
    const assistantTiming = createAssistantResponseTiming(req, res, measurement.assistant);
    const lease = pool.lease(),
      tenantStore = lease.get;
    let bodyScope;
    try {
      measurement.stage('request-security');
      const providerRoute = routes.find(
        (x) =>
          ['max', 'yookassa'].includes(x.provider) &&
          x.method === req.method &&
          x.path === new URL(req.url, 'http://route.invalid').pathname,
      );
      const expectedOrigin = secureRequest(
          req,
          res,
          origin,
          config.additionalOrigins,
          providerRoute?.provider || false,
        ),
        url = new URL(req.url, expectedOrigin);
      if (config.releaseGate && url.pathname.startsWith('/api/')) {
        res.setHeader('Retry-After', '30');
        return json(res, 503, {
          error: 'Идёт обновление картотеки. Попробуйте через несколько секунд.',
        });
      }
      const token =
        (req.headers.cookie || '')
          .split(';')
          .map((x) => x.trim())
          .find((x) => x.startsWith(cookieName + '='))
          ?.slice(cookieName.length + 1) || '';
      const requireCurrent = () => {
        const current = platform.session(token);
        if (!current) throw fail(401, 'Войдите в картотеку.');
        return current;
      };
      const assertRequestContext = (current, required = false, query = false) => {
        const account = query
            ? url.searchParams.get('accountContext')
            : req.headers['x-cartoteca-account-id'],
          organization = query
            ? url.searchParams.get('organizationContext')
            : req.headers['x-cartoteca-organization-id'];
        const supplied = account != null || organization != null;
        if (!required && !supplied) return;
        if (
          (query &&
            (url.searchParams.getAll('accountContext').length !== 1 ||
              url.searchParams.getAll('organizationContext').length !== 1)) ||
          !current ||
          typeof account !== 'string' ||
          typeof organization !== 'string' ||
          account !== current.accountId ||
          organization !== (current.organizationId || '')
        )
          throw Object.assign(fail(428, 'Аккаунт изменился. Обновите страницу картотеки.'), {
            code: 'AUTH_CONTEXT_CHANGED',
          });
      };
      const route = routes.find((x) => x.method === req.method && x.path === url.pathname);
      measurement.route(
        route
          ? `${route.method} ${route.path}`
          : url.pathname.startsWith('/api/photos/')
            ? 'photo'
            : url.pathname.startsWith('/api/')
              ? 'unknown-api'
              : 'static',
      );
      if (route) {
        measurement.stage('request-auth');
        const current = route.access === 'public' ? platform.session(token) : requireCurrent();
        // Client context is a precondition, never an authorization credential.
        // Missing context also rejects an old open tab before it can write to a
        // newly authenticated account through the browser's shared cookie.
        const mediaContext = route.method === 'GET' && route.path === '/api/assistant/speak-audio';
        const logoutContext =
          route.method === 'POST' && route.path === '/api/auth/logout' && Boolean(current);
        const assertRouteContext = (session) => {
          assertRequestContext(
            session,
            (route.access !== 'public' || logoutContext) && !mediaContext,
          );
          // HTMLAudioElement cannot attach headers. Its server-issued ticket
          // URL pins the issuing scope; PCM requests must also match any headers.
          if (mediaContext) assertRequestContext(session, true, true);
        };
        assertRouteContext(current);
        if (route.access === 'global' && !current.globalAdmin)
          throw fail(403, 'Доступ только для главного администратора.');
        if (route.access === 'organization' && current.globalAdmin)
          throw fail(403, 'Главный администратор не имеет доступа к данным кабинета.');
        if (route.access === 'organization' && !current.organizationId)
          throw fail(403, 'Выберите кабинет.');
        const assertCurrent = () => {
          if (route.access === 'public') return;
          const fresh = requireCurrent();
          assertRouteContext(fresh);
          if (
            fresh.accountId !== current.accountId ||
            fresh.organizationId !== current.organizationId ||
            fresh.role !== current.role ||
            fresh.globalAdmin !== current.globalAdmin
          )
            throw fail(403, 'Доступ изменился. Повторите операцию.');
          return fresh;
        };
        const runWork = createRequestWork({
          dispatcher: requestDispatcher,
          route,
          current,
          authorize: assertCurrent,
          cancelled: () => req.aborted || res.destroyed,
        });
        bodyScope = createJsonBodyScope(current?.accountId || clientAddress(req));
        const guardedReadBody = async (request, limit, reviver) => {
          measurement.stage('request-body');
          const body = await readBody(request, limit, reviver, {
            ...bodyScope.options,
            runParse: (parse, bytes) => runWork(parse, bytes),
          });
          assertCurrent();
          measurement.stage('request-handler');
          return body;
        };
        measurement.stage('request-handler');
        return await runWork(() =>
          route.handle({
            req,
            res,
            url,
            current,
            platform,
            telegram,
            appointmentState,
            notificationCoordinator,
            maxConnections,
            maxRuntime,
            staffMax,
            support,
            token,
            tenantStore,
            calendarFeeds,
            json,
            readBody: guardedReadBody,
            staffPush,
            setCookie,
            assertMailAvailable,
            invitationMailConfigured: Boolean(sendMail),
            adminEmail,
            backupStatus: () => readBackupStatus(config.backupStatusFile, config),
            organizationUsage: (organizationId) =>
              organizationUsage(dataDir, platform.organization(organizationId), {
                databaseOwner: config.databaseOwner,
              }),
            sendLink: (...args) => sendLink(...args, expectedOrigin),
            sendInvitation: (invitation) => {
              assertMailAvailable();
              const link = `${origin || expectedOrigin}/login.html#invite=${encodeURIComponent(invitation.token)}`;
              return sendMail(invitation.email, link, {
                kind: 'invitation',
                organizationName: invitation.organizationName,
                roleName: invitation.roleName,
              });
            },
            clientAddress,
            expectedOrigin,
            requireCurrent,
            assertCurrent,
            recordTiming: measurement.phase,
            recordStage: measurement.stage,
            assistantTiming,
            recordAssistantPlayback: measurement.playback,
          }),
        );
      }
      if (url.pathname.startsWith('/api/photos/') && ['GET', 'HEAD'].includes(req.method)) {
        const runPhotoWork = createPhotoWork({
          dispatcher: requestDispatcher,
          requireCurrent,
          assertRequestContext,
          cancelled: () => req.aborted || res.destroyed,
        });
        return await runPhotoWork(() =>
          servePhoto({
            req,
            res,
            id: url.pathname.slice(12),
            requireCurrent,
            assertRequestContext,
            tenantStore,
          }),
        );
      }
      if (url.pathname.startsWith('/api/')) {
        requireCurrent();
        throw fail(404, 'Маршрут не найден.');
      }
      await serveStatic(
        req,
        res,
        url,
        config.releaseGate ? null : platform.session(token),
        assetRoot,
      );
    } catch (error) {
      measurement.failure(error, error.status || 500);
      if (!req.complete && !res.headersSent) {
        res.shouldKeepAlive = false;
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
      }
      if (res.destroyed) return;
      if (error.status === 429 || (error.status === 503 && error.retryAfter))
        res.setHeader('Retry-After', String(error.retryAfter || 900));
      if (!res.headersSent)
        json(res, error.status || 500, {
          error: error.status ? error.message : 'Не удалось выполнить операцию.',
          ...([
            'AUTH_CONTEXT_CHANGED',
            'BOOKING_CHALLENGE_REJECTED',
            'BOOKING_SLOT_UNAVAILABLE',
            'BOOKING_CONDITIONS_CHANGED',
            'BOOKING_PHONE_PENDING',
            'BOOKING_CONTACT_CONFLICT',
            'BOOKING_KEY_CONFLICT',
            'BOOKING_REQUEST_PROCESSED',
            'MFA_REQUIRED',
            'MFA_INVALID',
            'PAYMENTS_NETWORK_DISABLED',
            'UPLOAD_CAPACITY',
            'AUTH_WORK_CAPACITY',
            'PHOTO_READ_CAPACITY',
            'TENANT_POOL_CAPACITY',
            'ASSISTANT_DIALOGUE_CAPACITY',
            'TASK_IN_PROGRESS',
            'TASK_ALREADY_COUNTED',
            'TASK_KEY_CONFLICT',
            'TASK_NOT_RESERVED',
            'ASSISTANT_PACKAGE_EXHAUSTED',
            'ASSISTANT_PACKAGE_REQUIRED',
            'ASSISTANT_TASK_REQUIRED',
            'ASSISTANT_SPEECH_PROOF_REQUIRED',
          ].includes(error.code)
            ? { code: error.code }
            : {}),
        });
      else res.end();
    } finally {
      bodyScope?.close();
      lease.release();
    }
  }
  return (req, res) => {
    // Bound synchronous incoming request bursts before any auth/storage work.
    // Do not await an entire request in the dispatcher: uploads and queued SQL
    // remain concurrent, and fresh permissions are checked after admission.
    req.pause();
    return requestDispatcher
      .run(() => handleRequest(req, res), {
        cancelled: () => req.aborted || res.destroyed,
      })
      .catch((error) => {
        if (res.destroyed || res.writableEnded) return;
        // An unconsumed body must not be reused as another keep-alive request.
        res.shouldKeepAlive = false;
        if (!res.headersSent) {
          res.setHeader('Retry-After', '1');
          json(res, error.status || 503, { error: 'Сервер временно занят. Повторите запрос.' });
        } else res.end();
      });
  };
}
module.exports = { createRequestHandler };
