function createDeferredSettings(state, actions, install, load = (url) => import(url)) {
  let pending = null,
    scheduled = false,
    attempt = 0,
    terminalError = null,
    deferred = null,
    departed = false;
  const reloadError = () =>
    Object.assign(
      new Error('Версия приложения обновилась. Сохраните изменения и обновите страницу.'),
      { reloadRequired: true },
    );
  const loadFailure = () => new Error('Не удалось загрузить настройки. Проверьте соединение.');
  const release = () => document.querySelector('meta[name="cartoteca-build"]')?.content;
  const sameLoadContext = (entry) =>
    state.account === entry.account &&
    entry.identity ===
      JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]) &&
    state.settingsBundleId === entry.bundle &&
    release() === entry.release;
  const passiveCurrent = (entry) =>
    sameLoadContext(entry) && !entry.inactive && !document.hidden && !departed;
  const canDiagnose = (entry) =>
    !entry.passive || (sameLoadContext(entry) && (entry.manual || passiveCurrent(entry)));
  function watchPassiveLoad(entry) {
    if (!entry.passive) return () => {};
    const hidden = () => {
      if (!document.hidden) return;
      entry.inactive = true;
      entry.cancelDiagnostic?.();
    };
    const leave = () => {
      entry.inactive = true;
      entry.cancelDiagnostic?.();
    };
    document.addEventListener?.('visibilitychange', hidden);
    window.addEventListener?.('pagehide', leave);
    return () => {
      document.removeEventListener?.('visibilitychange', hidden);
      window.removeEventListener?.('pagehide', leave);
    };
  }
  async function describeLoadFailure(url, entry) {
    if (!canDiagnose(entry)) return loadFailure();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const cancel = () => {
      if (!canDiagnose(entry)) controller.abort();
    };
    entry.cancelDiagnostic = cancel;
    try {
      if (!canDiagnose(entry)) return loadFailure();
      // Import errors hide HTTP status. Inspect only a current load failure, never prefetch APIs.
      const response = await fetch(url, {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!canDiagnose(entry)) return loadFailure();
      if (response.status === 409) return reloadError();
      if (response.status === 401)
        return Object.assign(new Error('Сессия завершилась. Обновите страницу и войдите снова.'), {
          reloadRequired: true,
        });
    } catch {
    } finally {
      clearTimeout(timer);
      if (entry.cancelDiagnostic === cancel) entry.cancelDiagnostic = null;
    }
    return loadFailure();
  }
  async function loadSettings(passive) {
    if (terminalError) throw terminalError;
    if (state.settingsReady) return;
    if (pending) {
      // Explicit navigation may join the same transport and still needs an actionable error.
      if (!passive && sameLoadContext(pending)) {
        pending.manual = true;
        pending.promote?.();
      }
      return pending.promise;
    }
    const entry = {
      account: state.account,
      identity: JSON.stringify([
        state.account?.id,
        state.account?.organizationId,
        state.account?.role,
      ]),
      bundle: state.settingsBundleId,
      release: release(),
      passive,
      manual: !passive,
      inactive: document.hidden || departed,
      cancelDiagnostic: null,
      promise: null,
    };
    const unwatch = watchPassiveLoad(entry);
    const task = (async () => {
      if (!entry.release || !state.settingsBundleId)
        throw new Error('Обновите страницу, чтобы загрузить настройки этой версии.');
      const suffix = attempt++ ? '&attempt=' + attempt : '';
      const resource = document.querySelector(
        'meta[name="cartoteca-resource-app-settings"]',
      )?.content;
      const version = resource && resource !== entry.release ? resource : entry.release;
      const url =
        '/app-settings.js?v=' +
        encodeURIComponent(version) +
        (version !== entry.release ? '&build=' + encodeURIComponent(entry.release) : '') +
        suffix;
      const importKey = JSON.stringify([
        'settings',
        state.account?.id,
        state.account?.organizationId,
        state.account?.role,
        url,
      ]);
      const importModule = () => {
        if (
          !sameLoadContext(entry) ||
          (entry.passive && !entry.manual && (document.hidden || departed))
        )
          throw loadFailure();
        return load(url);
      };
      entry.promote = () =>
        actions
          .scheduleRead?.(importModule, { priority: 'user', key: importKey, timeoutMs: 15000 })
          .catch(() => {});
      let module, timer;
      try {
        module = await Promise.race([
          actions.scheduleRead
            ? actions.scheduleRead(importModule, {
                priority: passive ? 'background' : 'user',
                key: importKey,
                timeoutMs: 15000,
              })
            : load(url),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Settings load timeout')), 15000);
          }),
        ]);
      } catch {
        throw await describeLoadFailure(url, entry);
      } finally {
        clearTimeout(timer);
      }
      if (module.bundleId !== state.settingsBundleId) throw reloadError();
      if (!sameLoadContext(entry))
        throw new Error('Учётная запись изменилась. Повторите открытие настроек.');
      try {
        install(module);
      } catch {
        // A factory/bind failure may already have attached listeners. Never repeat it.
        terminalError = Object.assign(
          new Error('Не удалось подключить настройки. Сохраните изменения и обновите страницу.'),
          { reloadRequired: true },
        );
        throw terminalError;
      }
      state.settingsReady = true;
      cancelDeferredLoad();
    })();
    entry.promise = task;
    pending = entry;
    let resumePassive = false;
    try {
      await task;
    } catch (error) {
      if (passive) {
        if (passiveCurrent(entry))
          actions.toast(
            error.reloadRequired
              ? error.message
              : 'Не удалось загрузить настройки. Откройте их, чтобы повторить загрузку.',
          );
        else if (!entry.manual && entry.inactive && sameLoadContext(entry) && !terminalError)
          resumePassive = true;
      }
      throw error;
    } finally {
      unwatch();
      if (pending === entry) pending = null;
      if (resumePassive) queueSettingsLoad();
    }
  }
  function ensureSettings() {
    return loadSettings(false);
  }
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
  function queueSettingsLoad() {
    if (deferred || departed || state.settingsReady || terminalError) return;
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
    const current = () => deferred === job && !departed && !state.settingsReady;
    const afterPaint = () => {
      job.phase++;
      clearDeferredHandles(job);
      if (!current()) {
        cancelDeferredLoad();
        return;
      }
      if (document.hidden) return;
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
        void loadSettings(true).catch(() => {});
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
      // Keep automatic loading after visible paints; fallback still covers throttled frames.
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
      if (deferred !== job) return;
      if (document.hidden) {
        job.phase++;
        clearDeferredHandles(job);
      } else afterPaint();
    };
    document.addEventListener?.('visibilitychange', job.visible);
    afterPaint();
  }
  function scheduleSettingsLoad() {
    if (scheduled || state.settingsReady) return;
    scheduled = true;
    queueSettingsLoad();
  }
  window.addEventListener?.('pagehide', () => {
    departed = true;
    cancelDeferredLoad();
  });
  window.addEventListener?.('pageshow', () => {
    departed = false;
    if (scheduled && !pending) queueSettingsLoad();
  });
  return { ensureSettings, scheduleSettingsLoad };
}
