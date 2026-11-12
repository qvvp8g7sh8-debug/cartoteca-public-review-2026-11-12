function createAdminLists({ $, request, records, details, message }) {
  const config = {
    organizations: {
      route: 'organizations',
      container: '#admin-organizations',
      search: '#admin-org-search',
      count: '#admin-org-result-count',
      more: '#admin-org-more',
      status: '#admin-org-status',
      plan: '#admin-org-plan',
      render: records.organizationRecord,
    },
    accounts: {
      route: 'accounts',
      container: '#admin-accounts',
      search: '#admin-account-search',
      count: '#admin-account-result-count',
      more: '#admin-account-more',
      status: '#admin-account-status',
      render: records.accountRecord,
    },
    support: {
      route: 'support',
      container: '#admin-support-list',
      count: '#admin-support-count',
      more: '#admin-support-more',
      status: '#admin-support-state',
      render: records.supportRecord,
    },
  };
  const state = Object.fromEntries(
    Object.keys(config).map((key) => [key, { generation: 0, next: null, loaded: 0, filters: {} }]),
  );
  let timer = null;
  function filters(kind) {
    const c = config[kind],
      result = { ...state[kind].filters };
    if (c.search) result.q = $(c.search).value.trim();
    if (c.status) result[kind === 'support' ? 'state' : 'status'] = $(c.status).value;
    if (c.plan) result.plan = $(c.plan).value;
    return result;
  }
  async function load(kind, more = false) {
    const c = config[kind],
      current = state[kind];
    const dirty = $(c.container).querySelector('[data-admin-record][data-dirty]');
    if (!more && dirty) {
      if (!confirm('Обновить список без сохранения открытой карточки?')) return;
      delete dirty.dataset.dirty;
    }
    const generation = ++current.generation;
    const parameters = { ...filters(kind) };
    if (more && current.next)
      Object.assign(
        parameters,
        typeof current.next === 'string' ? { cursor: current.next } : current.next,
      );
    $(c.more).disabled = true;
    $(c.count).textContent = 'Загружаем…';
    try {
      const data = await request('/api/admin/' + c.route + '?' + new URLSearchParams(parameters));
      if (generation !== current.generation) return;
      if (!more) {
        $(c.container).innerHTML = '';
        current.loaded = 0;
      }
      const existing = new Set(
        [...$(c.container).querySelectorAll('[data-id]')].map((row) => row.dataset.id),
      );
      const items = data.items.filter((item) => !existing.has(item.id));
      $(c.container).insertAdjacentHTML('beforeend', items.map(c.render).join(''));
      current.loaded += items.length;
      current.next = data.nextCursor || data.next || null;
      $(c.count).textContent = 'Показано ' + current.loaded + ' из ' + data.total;
      $(c.more).hidden = !current.next;
      if (!current.loaded)
        $(c.container).innerHTML =
          '<p class="admin-no-results">По вашему запросу ничего не найдено.</p>';
      bindRecords($(c.container));
    } catch (error) {
      if (generation === current.generation) {
        $(c.count).textContent = 'Список не обновлён';
        message(error.message, true);
      }
    } finally {
      if (generation === current.generation) $(c.more).disabled = false;
    }
  }
  async function reloadRecord(record) {
    const kind = record.dataset.kind;
    const serial = Number(record.dataset.loading || 0) + 1;
    record.dataset.loading = serial;
    const body = record.querySelector('.admin-detail-body');
    body.setAttribute('aria-busy', 'true');
    try {
      const route = kind === 'support' ? '/api/admin/support/case' : '/api/admin/' + kind;
      const data = await request(route + '?id=' + encodeURIComponent(record.dataset.id));
      if (!record.isConnected || !record.open || Number(record.dataset.loading) !== serial) return;
      const renderer =
        records[
          kind === 'organization'
            ? 'organizationRecord'
            : kind === 'account'
              ? 'accountRecord'
              : 'supportRecord'
        ];
      const template = document.createElement('template');
      template.innerHTML = renderer(
        kind === 'support' ? { ...data, excerpt: data.description.slice(0, 160) } : data,
      );
      record.querySelector('summary').innerHTML =
        template.content.querySelector('summary').innerHTML;
      body.innerHTML = details[kind](data);
      delete record.dataset.dirty;
    } catch (error) {
      if (record.isConnected && Number(record.dataset.loading) === serial) {
        message(error.message, true);
        if (!body.children.length)
          body.innerHTML = '<p>Карточка не загружена. Закройте и откройте её снова.</p>';
      }
    } finally {
      if (Number(record.dataset.loading) === serial) body.removeAttribute('aria-busy');
    }
  }
  function bindRecords(container) {
    container.querySelectorAll('[data-admin-record]').forEach((record) => {
      if (record.dataset.bound) return;
      record.dataset.bound = '1';
      record.addEventListener('toggle', async () => {
        if (!record.open) return;
        const other = container.querySelector(
          '[data-admin-record][open]:not([data-id="' + record.dataset.id + '"])',
        );
        if (other) {
          if (
            other.dataset.dirty &&
            !confirm('Закрыть предыдущую карточку без сохранения изменений?')
          ) {
            record.open = false;
            return;
          }
          other.open = false;
          delete other.dataset.dirty;
        }
        if (!record.dataset.dirty) await reloadRecord(record);
      });
    });
  }
  function search(kind) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void load(kind);
    }, 250);
  }
  function related(kind, organizationId) {
    if (state[kind]) state[kind].filters = organizationId ? { organizationId } : {};
    if (kind === 'support') $('#admin-support-clear').hidden = !organizationId;
  }
  return { load, search, reloadRecord, related, bindRecords, config };
}
