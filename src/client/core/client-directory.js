function createClientDirectory(state, actions) {
  let key = '',
    meta = null,
    pending = false,
    sequence = 0,
    timer,
    error = '',
    owner = null,
    deferredPage = null;
  const requests = new Set();
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const listVisible = () =>
    state.currentView === 'clients' ||
    (state.currentView === 'card' && Boolean((actions.$('#search')?.value || '').trim()));
  const sameOwner = () => owner?.account === state.account && owner?.scope === scope();
  async function directoryRequest(url) {
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 12000);
    requests.add(controller);
    try {
      return await actions.request(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }
  function query() {
    return {
      q: (actions.$('#search')?.value || '').trim().toLowerCase(),
      sort: state.patientSort,
      filter: state.currentView === 'clients' ? state.clientFilter : 'all',
      today: actions.cabinetToday(),
      limit: '20',
    };
  }
  function queryKey() {
    return JSON.stringify([state.account?.id, state.account?.organizationId, query()]);
  }
  function initializeDirectory(cabinet) {
    if (!state.pagedReads) return;
    invalidateDirectory();
    key = queryKey();
    owner = { account: state.account, scope: scope() };
    meta = cabinet;
    error = '';
  }
  function invalidateDirectory() {
    key = '';
    owner = deferredPage = null;
    sequence++;
    pending = false;
    clearTimeout(timer);
    timer = null;
    for (const controller of requests) controller.abort();
  }
  function ownDirectory() {
    const next = queryKey();
    if (key === next && sameOwner()) return false;
    invalidateDirectory();
    key = next;
    owner = { account: state.account, scope: scope() };
    meta = null;
    error = '';
    state.directory = [];
    return true;
  }
  function passiveCurrent(page) {
    return (
      page.sequence === sequence &&
      page.account === state.account &&
      page.scope === scope() &&
      page.key === key &&
      page.key === queryKey()
    );
  }
  async function fetchPage(append = false, retry = true, passive = null) {
    if (!state.pagedReads) return;
    if (passive) {
      if (!passiveCurrent(passive)) return;
      if (!listVisible()) {
        invalidateDirectory();
        return;
      }
      if (pending) return;
      if (document.visibilityState === 'hidden') {
        deferredPage = passive;
        return;
      }
      if (deferredPage === passive) deferredPage = null;
    } else if (ownDirectory()) append = false;
    if (pending || (append && !meta?.nextCursor)) return;
    pending = true;
    error = '';
    const requestId = sequence,
      account = state.account,
      requestScope = scope(),
      params = new URLSearchParams(query());
    if (append) params.set('cursor', meta.nextCursor);
    if (listVisible()) actions.renderList();
    try {
      const result = await directoryRequest('/api/cabinet/directory?' + params);
      if (requestId !== sequence || state.account !== account || requestScope !== scope()) return;
      meta = result;
      const ids = new Set(state.directory.map((p) => p.id));
      state.directory = append
        ? [...state.directory, ...result.directory.filter((p) => !ids.has(p.id))]
        : result.directory;
    } catch (e) {
      if (requestId !== sequence || state.account !== account || requestScope !== scope()) return;
      if (e.status === 409 && retry) {
        pending = false;
        sequence++;
        state.directory = [];
        meta = null;
        const next = passive ? { ...passive, sequence, key: queryKey(), retry: false } : null;
        await fetchPage(false, false, next);
        return;
      }
      error = e.message;
    } finally {
      if (requestId === sequence && state.account === account && requestScope === scope()) {
        pending = false;
        if (listVisible()) actions.renderList();
      }
    }
  }
  function directoryView() {
    if (!state.pagedReads) return null;
    if (!listVisible()) {
      invalidateDirectory();
      return null;
    }
    if (ownDirectory()) {
      const passive = {
        account: state.account,
        scope: scope(),
        sequence,
        key,
        retry: true,
      };
      const scheduled = setTimeout(
        () => {
          if (timer === scheduled) timer = null;
          void fetchPage(false, true, passive);
        },
        query().q ? 160 : 0,
      );
      timer = scheduled;
    }
    return {
      items: state.directory,
      total: meta?.total || 0,
      matched: meta?.matched || 0,
      counts: meta?.counts || {},
      loading: pending || (!meta && !error),
      error,
      more: Boolean(meta?.nextCursor),
    };
  }
  function flushDirectoryReads() {
    if (document.visibilityState === 'hidden' || !state.account || state.sessionReady === false)
      return;
    if (!listVisible()) {
      if (deferredPage) invalidateDirectory();
      return;
    }
    if (!deferredPage && key && sameOwner() && key === queryKey()) return;
    if (!sameOwner() || key !== queryKey()) {
      actions.renderList();
      return;
    }
    const next = deferredPage;
    deferredPage = null;
    if (next) return fetchPage(false, next.retry, next);
  }
  function loadDirectoryMore() {
    return fetchPage(Boolean(meta?.nextCursor));
  }
  async function loadAppointmentDirectory(q = '', { signal } = {}) {
    if (!state.pagedReads) {
      const records = actions
        .clientRecords()
        .filter((p) => actions.patientMatchesSearch(p, q))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return {
        patients: records
          .slice(0, 10)
          .map(({ id, name, phone, designation }) => ({ id, name, phone, designation })),
        matched: records.length,
      };
    }
    const params = new URLSearchParams({ q, sort: 'first', limit: '10' }),
      result = await actions.request('/api/cabinet/directory?' + params, { signal });
    return {
      patients: result.directory.map(({ id, name, phone, designation }) => ({
        id,
        name,
        phone,
        designation,
      })),
      matched: result.matched,
    };
  }
  document.addEventListener('click', (e) => {
    if (state.pagedReads && e.target.closest('#directory-retry, #directory-more'))
      void loadDirectoryMore();
  });
  window.addEventListener('pagehide', invalidateDirectory);
  return {
    initializeDirectory,
    invalidateDirectory,
    directoryView,
    flushDirectoryReads,
    loadDirectoryMore,
    loadAppointmentDirectory,
  };
}
