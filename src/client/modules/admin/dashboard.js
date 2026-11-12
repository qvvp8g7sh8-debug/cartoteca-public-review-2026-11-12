(() => {
  const $ = (selector) => document.querySelector(selector);
  const token = new URLSearchParams(location.hash.slice(1)).get('setup') || '';
  let accountContext = null,
    contextChanged = false;
  const requests = new Set();
  const contextError = () =>
    Object.assign(Error('Учётная запись изменилась. Откройте кабинет заново.'), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      unknown: false,
      outcomeUnknown: false,
    });
  function rejectContext() {
    if (!contextChanged) {
      contextChanged = true;
      for (const controller of requests) controller.abort();
      show('#admin-denied');
      $('#admin-denied p').textContent = contextError().message;
      location.replace('/');
    }
    return contextError();
  }
  const show = (id) => {
    for (const section of [
      '#admin-loading',
      '#admin-setup',
      '#admin-created',
      '#admin-dashboard',
      '#admin-denied',
    ])
      $(section).hidden = section !== id;
  };
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    contextChanged = true;
    for (const controller of requests) controller.abort();
    show('#admin-loading');
    $('#admin-identity').textContent = '';
    $('#admin-logout').hidden = true;
    location.reload();
  });
  function message(text, error = false) {
    $('#admin-message').textContent = text;
    $('#admin-message').dataset.status = error ? 'error' : 'success';
  }
  async function request(route, options = {}) {
    const context = accountContext,
      publicRoute = [
        '/api/auth/session',
        '/api/auth/logout',
        '/api/admin/bootstrap',
        '/api/admin/bootstrap-status',
      ].includes(route.split('?')[0]);
    if (contextChanged || (!publicRoute && !context?.accountId)) throw contextError();
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 15000);
    requests.add(controller);
    try {
      const response = await fetch(route, {
        cache: 'no-store',
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          ...options.headers,
          ...(context
            ? {
                'X-Cartoteca-Account-Id': context.accountId,
                'X-Cartoteca-Organization-Id': context.organizationId,
              }
            : {}),
        },
      });
      const result = await response.json();
      if (contextChanged || context !== accountContext) throw contextError();
      if (response.status === 428 || result.code === 'AUTH_CONTEXT_CHANGED') throw rejectContext();
      if (!response.ok) {
        const error = Error(result.error || 'Не удалось выполнить операцию.');
        error.status = response.status;
        error.unknown =
          options.method === 'POST' && response.status >= 500 && result.code !== 'UPLOAD_CAPACITY';
        throw error;
      }
      return result;
    } catch (error) {
      if (contextChanged) throw contextError();
      if (!error.status) error.unknown = options.method === 'POST';
      throw error;
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
    }
  }
  const records = createAdminRecords(),
    details = createAdminDetails(records);
  const overview = createAdminOverview({ $, records });
  const lists = createAdminLists({ $, request, records, details, message });
  const voice = createAdminVoice({ $, request, records, message });
  const billing = createAdminBilling({ $, request, records, message, changeView });
  createAdminMfaSettings({ $, request, records }).bind();
  voice.bind();
  billing.bind();
  createAdminNavigation({ $ }).bind();
  let auditNext = null,
    auditOrg = null,
    auditGeneration = 0,
    viewGeneration = 0;
  async function reloadSummary() {
    overview.renderOverview(await request('/api/admin/overview'));
    void billing.loadOverview();
  }
  async function loadAudit(more = false, organizationId = undefined) {
    const generation = ++auditGeneration;
    if (organizationId !== undefined) auditOrg = organizationId;
    const parameters = {};
    parameters.q = $('#admin-audit-search').value.trim();
    if (auditOrg) parameters.organizationId = auditOrg;
    if ($('#admin-audit-event').value) parameters.event = $('#admin-audit-event').value;
    if (more && auditNext) parameters.before = auditNext;
    $('#admin-audit-more').disabled = true;
    try {
      const data = await request('/api/admin/audit?' + new URLSearchParams(parameters));
      if (generation !== auditGeneration) return;
      overview.renderAudit(data.items, more);
      auditNext = data.next;
      $('#admin-audit-more').hidden = !auditNext;
      $('#admin-audit-clear').hidden = !auditOrg;
    } catch (error) {
      message(error.message, true);
    } finally {
      if (generation === auditGeneration) $('#admin-audit-more').disabled = false;
    }
  }
  async function changeView(view, organizationId) {
    if (
      ![
        'overview',
        'organizations',
        'accounts',
        'support',
        'audit',
        'system',
        'voice-assistant',
        'billing',
      ].includes(view)
    )
      return;
    const dirty = [
      ...document.querySelectorAll(
        '[data-admin-record][data-dirty], [data-admin-voice-draft][data-dirty], [data-admin-package-form][data-dirty], [data-admin-package-trial][data-dirty], [data-admin-package-payments][data-dirty], [data-admin-payment-review][data-dirty]',
      ),
    ];
    if (dirty.length && !confirm('Перейти в другой раздел без сохранения изменений?')) return;
    for (const item of dirty) delete item.dataset.dirty;
    const generation = ++viewGeneration;
    document.querySelectorAll('[data-admin-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.adminView === view);
      button.setAttribute('aria-pressed', String(button.dataset.adminView === view));
    });
    document.querySelectorAll('[data-admin-section]').forEach((section) => {
      section.hidden = section.dataset.adminSection !== view;
    });
    try {
      if (view === 'overview') await reloadSummary();
      else if (view === 'voice-assistant') await voice.load();
      else if (view === 'billing') await billing.load({ organizationId });
      else if (lists.config[view]) await lists.load(view);
      else if (view === 'audit') await loadAudit(false, organizationId);
      else {
        const system = await request('/api/admin/system');
        if (generation === viewGeneration) overview.renderSystem(system);
      }
    } catch (error) {
      message(error.message, true);
    }
  }
  bindAdminEvents({
    $,
    token,
    show,
    request,
    message,
    changeView,
    lists,
    reloadSummary,
    loadAudit,
  });
  async function initialize() {
    try {
      if (token) {
        history.replaceState(null, '', location.pathname);
        const status = await request(
          '/api/admin/bootstrap-status?token=' + encodeURIComponent(token),
        );
        if (!status.valid) {
          show('#admin-denied');
          $('#admin-denied p').textContent = status.exists
            ? 'Главный администратор уже создан.'
            : 'Ссылка недействительна или истекла.';
          return;
        }
        show('#admin-setup');
        return;
      }
      const session = await request('/api/auth/session');
      if (!session.user?.globalAdmin) {
        show('#admin-denied');
        return;
      }
      accountContext = {
        accountId: session.user.id,
        organizationId: session.user.organizationId || '',
      };
      $('#admin-identity').textContent = session.user.displayName + ' · ' + session.user.email;
      await reloadSummary();
      $('#admin-logout').hidden = false;
      show('#admin-dashboard');
      const caseId = new URLSearchParams(location.hash.slice(1)).get('case');
      if (caseId) {
        await changeView('support');
        // The case may be outside the first page: fetch only this authorized record.
        const ticket = await request('/api/admin/support/case?id=' + encodeURIComponent(caseId));
        $('#admin-support-list').innerHTML = records.supportRecord({
          ...ticket,
          excerpt: ticket.description.slice(0, 160),
        });
        $('#admin-support-more').hidden = true;
        $('#admin-support-count').textContent = 'Выбранное обращение';
        lists.bindRecords($('#admin-support-list'));
        const row = $('#admin-support-list [data-admin-record]');
        row.open = true;
      }
    } catch (error) {
      show('#admin-denied');
      $('#admin-denied p').textContent = error.message;
    }
  }
  void initialize();
})();
