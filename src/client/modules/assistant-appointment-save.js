function createAssistantAppointmentSave(state, actions) {
  const pending = new Map(),
    accountPending = new Map();
  const identity = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const validId = (value) =>
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
  const actionOperation = (action) =>
    action?.type === 'cancelAppointment'
      ? 'cancel'
      : action?.type === 'moveAppointment'
        ? 'move'
        : undefined;
  const storageKey = (account) => 'cartoteca-assistant-create:' + account;
  function stored(key) {
    try {
      const raw = globalThis.sessionStorage.getItem(key);
      if (raw === null) return null;
      if (raw.length > 1024) throw Error();
      const value = JSON.parse(raw);
      if (
        !value ||
        Object.keys(value).some(
          (name) => !['executionId', 'policyVersion', 'uncertain', 'operation'].includes(name),
        ) ||
        !validId(value.executionId) ||
        !Number.isSafeInteger(value.policyVersion) ||
        value.policyVersion < 0 ||
        typeof value.uncertain !== 'boolean' ||
        (value.operation !== undefined && !['cancel', 'move'].includes(value.operation))
      )
        throw Error();
      return value;
    } catch {
      throw Error('Не удалось проверить предыдущее сохранение. Обновите страницу.');
    }
  }
  function remember(key, operation) {
    try {
      globalThis.sessionStorage.setItem(key, JSON.stringify(operation));
    } catch {
      throw Error('Не удалось подготовить сохранение. Обновите страницу.');
    }
  }
  function forget(key, executionId) {
    try {
      if (stored(key)?.executionId === executionId) globalThis.sessionStorage.removeItem(key);
    } catch {
      // A retained token is reconciled on the next request, never blindly re-created.
    }
  }
  function confirmed(reply, operation) {
    const kind = operation.operation;
    const management = kind === 'cancel' || kind === 'move';
    const target = management
      ? reply?.operation === kind &&
        (kind === 'cancel'
          ? reply.cancelled === true && reply.moved !== true
          : reply.moved === true && reply.cancelled !== true) &&
        ((typeof reply.appointmentId === 'string' &&
          reply.appointmentId.length > 0 &&
          reply.appointmentId.length <= 120) ||
          (reply.appointmentId === null && reply.alreadySaved === true && reply.action === null))
      : reply?.operation === undefined &&
        reply?.cancelled !== true &&
        reply?.moved !== true &&
        typeof reply?.appointmentId === 'string' &&
        reply.appointmentId.length > 0 &&
        reply.appointmentId.length <= 120;
    return Boolean(
      reply?.saved === true &&
      typeof reply.text === 'string' &&
      reply.text.length > 0 &&
      reply.text.length <= 1000 &&
      target &&
      Number.isSafeInteger(reply.policyVersion) &&
      reply.policyVersion >= 0 &&
      (reply.alreadySaved === true || reply.policyVersion === operation.policyVersion) &&
      (reply.action === null ||
        (reply.action?.type === 'calendar' &&
          /^\d{4}-\d{2}-\d{2}$/u.test(reply.action.date || '') &&
          typeof reply.action.staffId === 'string' &&
          reply.action.staffId.length > 0)),
    );
  }
  function requiresInput(reply, operation) {
    const recovery = reply?.recovery,
      dialogue = recovery?.dialogue;
    return (
      reply?.saved === false &&
      reply.definitive === true &&
      reply.code === 'ASSISTANT_EXECUTION_REQUIRES_INPUT' &&
      reply.policyVersion === operation.policyVersion &&
      recovery?.policyVersion === operation.policyVersion &&
      recovery.action === null &&
      dialogue?.id === operation.executionId &&
      Number.isSafeInteger(dialogue.version) &&
      dialogue.version > 0 &&
      (['client', 'staff', 'service', 'date', 'time', 'duration'].includes(dialogue.step) ||
        (operation.operation === 'cancel' &&
          dialogue.step === 'appointment' &&
          dialogue.phase === 'cancelConfirmation' &&
          dialogue.options?.length === 1)) &&
      typeof recovery.text === 'string' &&
      recovery.text.length > 0 &&
      recovery.text.length <= 2000 &&
      typeof dialogue.prompt === 'string' &&
      dialogue.prompt.length > 0 &&
      dialogue.prompt.length <= 2000 &&
      Array.isArray(dialogue.options) &&
      Array.isArray(dialogue.fields)
    );
  }
  async function execute(key, operation, current) {
    const body = JSON.stringify({
      executionId: operation.executionId,
      policyVersion: operation.policyVersion,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current()) return false;
      // Persist uncertainty before dispatch: a reload may outlive the HTTP response.
      remember(key, { ...operation, uncertain: true });
      let reply;
      try {
        reply = await actions.request('/api/assistant/execute', {
          method: 'POST',
          body,
          timeoutMs: state.assistantScope?.limits?.requestTimeoutMs || 20000,
          assistantRequest: true,
        });
      } catch (error) {
        // The refusal concerns this request, not an earlier uncertain commit.
        // Keep its account-scoped receipt for reconciliation in the original account.
        if (error.code === 'AUTH_CONTEXT_CHANGED') throw error;
        // Access may expire after the cabinet commits but before its response.
        const unknown =
          operation.uncertain ||
          error.outcomeUnknown === true ||
          [401, 403].includes(error.status) ||
          error.status >= 500;
        if (unknown) {
          operation = { ...operation, uncertain: true };
          remember(key, operation);
          if (attempt === 0 && error.outcomeUnknown === true && current()) continue;
          throw Object.assign(
            Error(
              operation.operation === 'cancel'
                ? 'Результат отмены пока неизвестен. Повторите проверку.'
                : operation.operation === 'move'
                  ? 'Результат переноса пока неизвестен. Повторите проверку.'
                  : 'Результат сохранения пока неизвестен. Повторите проверку.',
            ),
            {
              outcomeUnknown: true,
            },
          );
        }
        forget(key, operation.executionId);
        throw error;
      }
      if (
        reply?.saved === false &&
        reply.definitive === true &&
        reply.code === 'ASSISTANT_EXECUTION_EXPIRED'
      ) {
        forget(key, operation.executionId);
        return null;
      }
      if (requiresInput(reply, operation)) {
        forget(key, operation.executionId);
        return current() ? reply : false;
      }
      if (!confirmed(reply, operation)) {
        remember(key, { ...operation, uncertain: true });
        throw Object.assign(
          Error(
            operation.operation === 'cancel'
              ? 'Не удалось подтвердить отмену. Повторите проверку.'
              : operation.operation === 'move'
                ? 'Не удалось подтвердить перенос. Повторите проверку.'
                : 'Не удалось подтвердить сохранение. Повторите проверку.',
          ),
          {
            outcomeUnknown: true,
          },
        );
      }
      forget(key, operation.executionId);
      return current() ? reply : false;
    }
  }
  function saveAssistantAppointment(action) {
    const scope = state.assistantScope;
    if (
      !state.account?.id ||
      !scope?.enabled ||
      scope.appointmentSavingEnabled !== true ||
      scope.organizationId !== state.account.organizationId ||
      !Number.isSafeInteger(scope.policyVersion) ||
      scope.policyVersion < 0 ||
      !['createAppointment', 'cancelAppointment', 'moveAppointment'].includes(action?.type) ||
      !validId(action.executionId)
    )
      return Promise.reject(Error('Сохранение записи помощником недоступно.'));
    const policyVersion = scope.policyVersion;
    const account = state.account,
      accountKey = identity(),
      generation = state.assistantGeneration,
      view = state.currentView,
      editor = state.editorMode;
    const current = () =>
      state.account === account &&
      identity() === accountKey &&
      state.assistantGeneration === generation &&
      state.assistantScope?.enabled === true &&
      state.assistantScope.appointmentSavingEnabled === true &&
      state.assistantScope.policyVersion === policyVersion &&
      state.assistantScope.organizationId === account.organizationId &&
      state.currentView === view &&
      state.editorMode === editor &&
      !document.hidden;
    const key = storageKey(JSON.stringify([account.id, account.organizationId])),
      requestKey = JSON.stringify([accountKey, action.executionId, policyVersion]);
    if (pending.has(requestKey)) return pending.get(requestKey);
    const previousText = (operation) =>
      operation === 'cancel'
        ? 'Предыдущая запись отменена. Повторите новую команду.'
        : operation === 'move'
          ? 'Предыдущая запись перенесена. Повторите новую команду.'
          : 'Предыдущая запись сохранена. Повторите новую команду.';
    const active = accountPending.get(accountKey);
    if (active)
      return active.promise.then((reply) =>
        !current() || reply === false
          ? false
          : reply?.saved === false
            ? reply
            : { ...reply, text: previousText(reply.operation) },
      );
    const operation = (async () => {
      if (!current()) return false;
      const previous = stored(key);
      if (previous && previous.executionId !== action.executionId) {
        const reconciled = await execute(key, previous, current);
        if (reconciled === false) return false;
        if (reconciled)
          return reconciled.saved === false
            ? reconciled
            : { ...reconciled, text: previousText(previous.operation) };
      }
      if (
        previous?.executionId === action.executionId &&
        previous.operation !== actionOperation(action)
      )
        throw Error('Выбранное действие изменилось. Повторите команду.');
      const selected =
        previous?.executionId === action.executionId
          ? previous
          : {
              executionId: action.executionId,
              policyVersion,
              uncertain: false,
              ...(actionOperation(action) ? { operation: actionOperation(action) } : {}),
            };
      remember(key, selected);
      const reply = await execute(key, selected, current);
      if (reply === null) throw Error('Подготовка истекла. Повторите команду.');
      return reply;
    })();
    pending.set(requestKey, operation);
    const owned = {
      promise: operation,
      operation: actionOperation(action),
    };
    accountPending.set(accountKey, owned);
    void operation
      .finally(() => {
        if (pending.get(requestKey) === operation) pending.delete(requestKey);
        if (accountPending.get(accountKey) === owned) accountPending.delete(accountKey);
      })
      .catch(() => {});
    return operation;
  }
  return { saveAssistantAppointment };
}
