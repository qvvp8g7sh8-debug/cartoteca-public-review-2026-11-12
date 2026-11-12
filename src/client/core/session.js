function createSession(state, actions) {
  const pendingReads = new Set();
  let departed = false,
    contextInvalid = false;
  const accountContext = () =>
    state.account?.id ? JSON.stringify([state.account.id, state.account.organizationId || '']) : '';
  const contextError = () =>
    Object.assign(new Error('Аккаунт изменился. Откройте картотеку заново.'), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      outcomeUnknown: false,
    });
  const cancelReads = () => {
    for (const interrupt of pendingReads) interrupt();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener?.('pagehide', () => {
      departed = true;
      actions.cancelReadTasks?.();
      cancelReads();
    });
    window.addEventListener?.('pageshow', () => {
      departed = false;
    });
  }
  function request(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase(),
      read = ['GET', 'HEAD'].includes(method);
    if (!read || !actions.scheduleRead) return sendRequest(url, options);
    const scheduledIdentity = JSON.stringify([accountContext(), state.account?.role]);
    const assistantScope =
      options.assistantRequest === true && method === 'GET' && url === '/api/assistant/scope';
    const optionalStatus =
      url === '/api/cabinet/time-zone' || /^\/api\/(telegram|max)\/patient\?/.test(url);
    const priority =
      options.priority ||
      (assistantScope
        ? 'assistant'
        : url.startsWith('/api/cabinet/calendar?')
          ? 'calendar'
          : optionalStatus && !state.busy
            ? 'background'
            : 'user');
    const key =
      !options.signal && !options.headers && !options.body
        ? JSON.stringify([accountContext(), state.account?.role, url, options.method || 'GET'])
        : '';
    return actions.scheduleRead(
      (signal) => {
        if (scheduledIdentity !== JSON.stringify([accountContext(), state.account?.role]))
          throw contextError();
        return sendRequest(url, { ...options, signal });
      },
      { priority, key, signal: options.signal, timeoutMs: options.timeoutMs || 20000 },
    );
  }
  async function sendRequest(url, options = {}) {
    if (contextInvalid) throw contextError();
    const sessionProbe = url === '/api/auth/session',
      capturedContext = accountContext(),
      capturedRole = state.account?.role,
      requestContext = sessionProbe ? '' : capturedContext;
    const contextHeaders = requestContext
      ? {
          'X-Cartoteca-Account-Id': state.account.id,
          'X-Cartoteca-Organization-Id': state.account.organizationId || '',
        }
      : {};
    const {
        timeoutMs = 20000,
        priority,
        signal,
        assistantRequest = false,
        assistantTiming,
        ...fetchOptions
      } = options,
      controller = new AbortController();
    const mutation = !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase());
    const assistant =
      assistantRequest === true &&
      String(options.method || 'GET').toUpperCase() === 'POST' &&
      /^\/api\/assistant\/(turn|transcribe|speak)$/.test(url);
    const assistantWrite =
      assistantRequest === true &&
      String(options.method || 'GET').toUpperCase() === 'POST' &&
      url === '/api/assistant/execute';
    const scopedAssistant =
      assistant ||
      assistantWrite ||
      (assistantRequest === true &&
        String(options.method || 'GET').toUpperCase() === 'GET' &&
        url === '/api/assistant/scope');
    const assistantAccount = scopedAssistant ? state.account : null,
      assistantGeneration = state.assistantGeneration;
    const assistantIdentity = () =>
      JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
    const requestIdentity = scopedAssistant ? assistantIdentity() : '';
    let response, rejectWait;
    const interrupted = new Promise((resolve, reject) => {
      rejectWait = reject;
    });
    const interrupt = () => {
      controller.abort();
      rejectWait(new Error('Request interrupted'));
    };
    let deadlineExceeded = false;
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      interrupt();
    }, timeoutMs);
    signal?.addEventListener('abort', interrupt, { once: true });
    if (!mutation) {
      if (!pendingReads.size && typeof window !== 'undefined')
        window.addEventListener?.('beforeunload', cancelReads);
      pendingReads.add(interrupt);
    }
    try {
      if (signal?.aborted || (!mutation && departed)) {
        interrupt();
        await interrupted;
      }
      const network = (async () => {
        response = await fetch(url, {
          cache: 'no-store',
          ...fetchOptions,
          // WebKit rejects ordinary reads while a replacement document is loading.
          // GET/HEAD have no request body; retain explicit lifecycle/timeout aborts.
          ...(!mutation ? { keepalive: true } : {}),
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Cartoteca-Request': '1',
            ...options.headers,
            ...contextHeaders,
          },
        });
        return response.json();
      })();
      const result = await Promise.race([network, interrupted]);
      // A shared cookie may change in another tab while this document still has
      // its old account. Only the server can compare that cookie with our scope.
      if (
        capturedContext &&
        (capturedContext !== accountContext() ||
          (!mutation && !scopedAssistant && capturedRole !== state.account?.role))
      )
        throw contextError();
      const changedSession =
        sessionProbe &&
        response.ok &&
        capturedContext &&
        JSON.stringify([result.user?.id, result.user?.organizationId || '']) !== capturedContext;
      if (changedSession || (response.status === 428 && result.code === 'AUTH_CONTEXT_CHANGED')) {
        if (!contextInvalid) {
          contextInvalid = true;
          state.sessionReady = false;
          cancelReads();
          actions.resetAssistant?.();
          if (typeof document !== 'undefined') document.body?.classList.add('app-loading');
          location.replace('/');
        }
        throw contextError();
      }
      if (contextInvalid) throw contextError();
      if (response.status === 401) {
        if (
          !scopedAssistant ||
          (assistantAccount === state.account &&
            assistantGeneration === state.assistantGeneration &&
            requestIdentity === assistantIdentity())
        ) {
          actions.resetAssistant?.();
          location.replace('/' + (location.hash.startsWith('#staff-push=') ? location.hash : ''));
        }
        throw Object.assign(new Error('Войдите снова.'), { status: 401 });
      }
      // Request-local metadata only, after the same authenticated context checks as the reply.
      // Never forward the observer to fetch or let optional diagnostics affect request semantics.
      if (
        assistant &&
        response.ok &&
        assistantAccount === state.account &&
        assistantGeneration === state.assistantGeneration &&
        requestIdentity === assistantIdentity()
      ) {
        try {
          if (typeof assistantTiming === 'function')
            assistantTiming(response.headers?.get?.('Server-Timing') || '');
        } catch {}
      }
      if (
        !response.ok &&
        [503, 504].includes(response.status) &&
        result.code === 'CABINET_COMMAND_NOT_STARTED' &&
        ((options.method === 'POST' && url === '/api/cabinet/appointments') ||
          (options.method === 'PATCH' && url === '/api/cabinet/changes') ||
          (options.method === 'PUT' && url === '/api/cabinet'))
      )
        throw Object.assign(new Error(result.error || 'Сервер временно занят.'), {
          status: response.status,
          code: result.code,
          outcomeUnknown: false,
        });
      if (!response.ok)
        throw Object.assign(
          new Error(
            result.error ||
              (assistant
                ? 'Не удалось получить ответ помощника.'
                : 'Не удалось сохранить изменения.'),
          ),
          {
            status: response.status,
            ...([
              'PAYMENTS_NETWORK_DISABLED',
              'UPLOAD_CAPACITY',
              'TASK_IN_PROGRESS',
              'TASK_ALREADY_COUNTED',
              'TASK_KEY_CONFLICT',
              'TASK_NOT_RESERVED',
              'ASSISTANT_PACKAGE_EXHAUSTED',
              'ASSISTANT_PACKAGE_REQUIRED',
              'ASSISTANT_TASK_REQUIRED',
              'ASSISTANT_SPEECH_PROOF_REQUIRED',
            ].includes(result.code)
              ? { code: result.code }
              : {}),
          },
        );
      return result;
    } catch (error) {
      if (contextInvalid) throw contextError();
      if (
        error.status &&
        (!mutation ||
          error.status < 500 ||
          assistant ||
          error.code === 'UPLOAD_CAPACITY' ||
          error.code === 'CABINET_COMMAND_NOT_STARTED' ||
          (url === '/api/billing/checkout' &&
            error.status === 503 &&
            ['PAYMENTS_NETWORK_DISABLED', 'UPLOAD_CAPACITY'].includes(error.code)))
      )
        throw error;
      throw Object.assign(
        new Error(
          assistant
            ? 'Ответ помощника не получен. Проверьте состояние диалога перед повторной отправкой.'
            : mutation
              ? 'Не удалось получить ответ сервера. Результат сохранения пока неизвестен. Проверьте его перед повторной отправкой.'
              : 'Нет связи с сервером или истекло время ожидания. Попробуйте ещё раз.',
        ),
        {
          outcomeUnknown: mutation,
          ...(assistant
            ? {
                assistantFailure: deadlineExceeded ? 'deadline' : response ? 'response' : 'network',
              }
            : {}),
        },
      );
    } finally {
      pendingReads.delete(interrupt);
      if (!pendingReads.size && typeof window !== 'undefined')
        window.removeEventListener?.('beforeunload', cancelReads);
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
    }
  }
  function legacyData() {
    const patientsText = localStorage.getItem(state.KEY);
    const servicesText = localStorage.getItem(state.SERVICE_KEY);
    if (!patientsText && !servicesText) return null;
    const patients = patientsText ? JSON.parse(patientsText) : [];
    const oldServices = servicesText ? JSON.parse(servicesText) : state.serviceSeed;
    if (!actions.isPatientList(patients) || !Array.isArray(oldServices))
      throw new Error(
        'Не удалось прочитать старые данные. Сохраните копию браузера перед переносом.',
      );
    return {
      patients: patients.map((p) => ({
        ...p,
        appointments: p.appointments || [],
      })),
      services: oldServices,
    };
  }
  async function migrateLegacy() {
    const old = actions.legacyData();
    if (!old) {
      actions.toast('В этом браузере нет старой картотеки');
      return;
    }
    if (
      !window.confirm(
        'Перенести карточки и услуги из этого браузера в ваш кабинет? Они заменят текущие данные кабинета. После успешного сохранения старая копия в браузере будет удалена.',
      )
    )
      return;
    state.data = old.patients;
    state.services = old.services;
    await actions.save();
    localStorage.removeItem(state.KEY);
    localStorage.removeItem(state.SERVICE_KEY);
    actions.toast('Карточки и услуги перенесены');
  }
  function isPatientList(value) {
    return (
      Array.isArray(value) &&
      value.every(
        (p) => p && typeof p === 'object' && typeof p.name === 'string' && Array.isArray(p.visits),
      )
    );
  }
  return { request, legacyData, migrateLegacy, isPatientList };
}
