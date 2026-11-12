function createAssistantHost(state, actions, install, load = (url) => import(url)) {
  let activeKey = '',
    pending = null,
    scheduled = false,
    deferred = null,
    installed = false,
    terminal = false,
    visibleRetry = null;
  const key = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const permitted = (scope) =>
    Boolean(
      state.multiUser &&
      state.account?.organizationId &&
      scope?.enabled === true &&
      scope.organizationId === state.account.organizationId,
    );
  function clearDeferredHandles(job) {
    clearTimeout(job.fallback);
    clearTimeout(job.task);
    if (job.frame !== null) window.cancelAnimationFrame?.(job.frame);
    if (job.secondFrame !== null) window.cancelAnimationFrame?.(job.secondFrame);
    if (job.idle !== null) window.cancelIdleCallback?.(job.idle);
    job.fallback = job.task = job.frame = job.secondFrame = job.idle = null;
  }
  function cancelDeferredLoad() {
    const job = deferred;
    deferred = null;
    if (!job) return;
    job.phase++;
    clearDeferredHandles(job);
    document.removeEventListener?.('visibilitychange', job.visible);
  }
  function resetAssistant() {
    if (visibleRetry) document.removeEventListener?.('visibilitychange', visibleRetry);
    visibleRetry = null;
    state.assistantGeneration++;
    cancelDeferredLoad();
    if (installed) actions.destroyVoiceAssistant();
    state.assistantScope = null;
    state.assistantReady = false;
    activeKey = '';
    scheduled = false;
    pending = null;
  }
  function applyAssistantScope(scope = null) {
    const changed =
      activeKey &&
      (activeKey !== key() || state.assistantScope?.policyVersion !== scope?.policyVersion);
    if (changed || !permitted(scope)) resetAssistant();
    if (!permitted(scope)) return;
    activeKey = key();
    state.assistantScope = scope;
    if (installed) state.assistantReady = true;
    if (state.sessionReady) scheduleAssistantLoad();
  }
  function mountAssistant() {
    if (activeKey && activeKey !== key()) resetAssistant();
    if (installed && state.assistantReady && permitted(state.assistantScope))
      actions.mountVoiceAssistant();
  }
  async function loadAssistant() {
    if (terminal || !permitted(state.assistantScope) || !state.sessionReady) return;
    if (installed) {
      state.assistantReady = true;
      mountAssistant();
      return;
    }
    if (pending) return pending;
    const generation = state.assistantGeneration,
      scopeKey = key();
    const version = document.querySelector('meta[name="cartoteca-build"]')?.content;
    const task = (async () => {
      if (!version || !state.assistantBundleId)
        throw Error('Обновите страницу для запуска помощника.');
      let timer;
      const resource = document.querySelector(
        'meta[name="cartoteca-resource-app-assistant"]',
      )?.content;
      const resourceVersion = resource && resource !== version ? resource : version;
      const url =
        '/app-assistant.js?v=' +
        encodeURIComponent(resourceVersion) +
        (resourceVersion !== version ? '&build=' + encodeURIComponent(version) : '');
      const module = await Promise.race([
        actions.scheduleRead
          ? actions.scheduleRead(
              () => {
                if (
                  generation !== state.assistantGeneration ||
                  scopeKey !== key() ||
                  !permitted(state.assistantScope) ||
                  document.hidden
                )
                  throw Error('Загрузка помощника отложена.');
                return load(url);
              },
              { priority: 'background', timeoutMs: 15000 },
            )
          : load(url),
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error('Помощник не загрузился. Обновите страницу.')),
            15000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (
        generation !== state.assistantGeneration ||
        scopeKey !== key() ||
        !permitted(state.assistantScope)
      )
        return;
      if (module.bundleId !== state.assistantBundleId)
        throw Error('Версия помощника обновилась. Сохраните изменения и обновите страницу.');
      try {
        install(module);
      } catch {
        terminal = true;
        throw Error('Не удалось подключить помощника. Обновите страницу.');
      }
      installed = true;
      state.assistantReady = true;
      mountAssistant();
    })();
    pending = task;
    try {
      await task;
    } finally {
      if (pending === task) pending = null;
    }
  }
  function scheduleAssistantLoad() {
    if (scheduled || !permitted(state.assistantScope) || !state.sessionReady) return;
    scheduled = true;
    const generation = state.assistantGeneration;
    const job = {
      phase: 0,
      fallback: null,
      task: null,
      frame: null,
      secondFrame: null,
      idle: null,
      visible: null,
    };
    deferred = job;
    const current = () => deferred === job && generation === state.assistantGeneration;
    const afterPaint = () => {
      job.phase++;
      clearDeferredHandles(job);
      if (!current() || document.hidden) return;
      const phase = job.phase;
      let started = false;
      const phaseCurrent = () => current() && phase === job.phase;
      const run = () => {
        if (!phaseCurrent()) return;
        if (document.hidden) {
          job.phase++;
          clearDeferredHandles(job);
          return;
        }
        cancelDeferredLoad();
        void loadAssistant().catch((error) => {
          if (generation === state.assistantGeneration) {
            scheduled = false;
            if (!document.hidden) actions.toast(error.message);
            else if (!visibleRetry) {
              visibleRetry = () => {
                if (document.hidden) return;
                document.removeEventListener?.('visibilitychange', visibleRetry);
                visibleRetry = null;
                scheduleAssistantLoad();
              };
              document.addEventListener?.('visibilitychange', visibleRetry);
            }
          }
        });
      };
      const ready = () => {
        if (started || !phaseCurrent()) return;
        started = true;
        clearDeferredHandles(job);
        if (document.hidden) return;
        if (window.requestIdleCallback)
          job.idle = window.requestIdleCallback(run, { timeout: 1000 });
        else job.task = setTimeout(run, 0);
      };
      job.fallback = setTimeout(ready, 1500);
      if (window.requestAnimationFrame)
        job.frame = window.requestAnimationFrame(() => {
          job.frame = null;
          if (!phaseCurrent()) return;
          job.secondFrame = window.requestAnimationFrame(() => {
            job.secondFrame = null;
            ready();
          });
        });
    };
    job.visible = () => {
      if (!current()) return;
      if (document.hidden) {
        job.phase++;
        clearDeferredHandles(job);
      } else afterPaint();
    };
    document.addEventListener?.('visibilitychange', job.visible);
    afterPaint();
  }
  function bindAssistantLifecycle() {
    window.addEventListener('pagehide', resetAssistant);
  }
  return {
    resetAssistant,
    applyAssistantScope,
    mountAssistant,
    scheduleAssistantLoad,
    bindAssistantLifecycle,
  };
}
