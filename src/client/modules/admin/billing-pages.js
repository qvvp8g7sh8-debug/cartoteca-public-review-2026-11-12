function createAdminBillingPages({ request, view, content, isCurrent, restorePending, message }) {
  const remembered = new Map();
  let organizationId = null,
    token = 0,
    organizationSerial = 0,
    orderSerial = 0,
    nextOffset = null,
    nextCursor = null,
    total = null,
    applied = { status: 'all', q: '' };
  const scopeKey = () => organizationId || 'platform';
  const current = (node, capturedToken) =>
    node?.isConnected && content()?.contains(node) && isCurrent(capturedToken);
  function controls(selector, disabled) {
    content()
      ?.querySelectorAll(selector)
      .forEach((node) => {
        node.disabled = disabled;
      });
  }
  function setOrganizationState(data = {}) {
    if (Number.isSafeInteger(data.total)) total = data.total;
    const root = content(),
      count = root?.querySelectorAll('[data-billing-organization-id]').length || 0,
      text = 'Показано ' + count + (Number.isSafeInteger(total) ? ' из ' + total : '');
    const label = root?.querySelector('[data-billing-organization-count]');
    if (label) label.textContent = text;
    for (const button of root?.querySelectorAll('[data-billing-organization-more]') || [])
      button.hidden = nextOffset == null;
    const hint = root?.querySelector('[data-billing-trial-list-hint]');
    if (hint)
      hint.textContent =
        nextOffset == null
          ? ''
          : 'В выборе кабинета показаны загруженные записи. Остальные можно загрузить здесь.';
  }
  function setOrderState() {
    const root = content(),
      count = root?.querySelectorAll('[data-admin-order-id]').length || 0;
    const label = root?.querySelector('[data-billing-orders-count]');
    if (label) label.textContent = 'Показано заказов: ' + count;
    const empty = root?.querySelector('[data-billing-orders-empty]');
    if (empty) {
      empty.hidden = count > 0;
      empty.textContent = nextCursor
        ? 'В этой части истории совпадений пока нет. Продолжите поиск.'
        : 'По этим условиям заказов нет.';
    }
    const more = root?.querySelector('[data-billing-orders-more]');
    if (more) {
      more.hidden = !nextCursor;
      more.textContent = nextCursor && !count ? 'Продолжить поиск' : 'Показать ещё 50 заказов';
    }
  }
  function permitReplacement(section) {
    if (section.querySelector('[data-busy]')) {
      message('Дождитесь результата действия по заказу.');
      return false;
    }
    const dirty = [...section.querySelectorAll('[data-admin-payment-review][data-dirty]')];
    if (dirty.length && !confirm('Обновить список заказов без сохранения введённых изменений?'))
      return false;
    return true;
  }
  async function loadOrganizations() {
    if (nextOffset == null) return;
    const root = content(),
      list = root?.querySelector('[data-billing-organization-list]');
    if (!list || list.hasAttribute('aria-busy')) return;
    const serial = ++organizationSerial,
      capturedToken = token,
      offset = nextOffset;
    const result = root.querySelector('[data-billing-organization-message]');
    controls('[data-billing-organization-more]', true);
    list.setAttribute('aria-busy', 'true');
    result.textContent = 'Загружаем кабинеты…';
    try {
      const data = await request(
        '/api/admin/billing/organizations?offset=' + encodeURIComponent(offset),
      );
      if (!current(list, capturedToken) || serial !== organizationSerial) return;
      const ids = new Set(
        [...list.querySelectorAll('[data-billing-organization-id]')].map(
          (node) => node.dataset.billingOrganizationId,
        ),
      );
      const items = (data.organizations || []).filter((item) => {
        if (ids.has(item.organizationId)) return false;
        ids.add(item.organizationId);
        return true;
      });
      list.insertAdjacentHTML('beforeend', view.organizationRowsHtml(items));
      const select = root.querySelector('[data-admin-package-trial] [name="organizationId"]');
      if (select)
        for (const item of items) {
          if ([...select.options].some((option) => option.value === item.organizationId)) continue;
          const option = document.createElement('option');
          option.value = item.organizationId;
          option.textContent = item.organizationName;
          select.append(option);
        }
      nextOffset = data.nextOffset ?? null;
      setOrganizationState(data);
      result.textContent = '';
    } catch (error) {
      if (current(list, capturedToken) && serial === organizationSerial)
        result.textContent = 'Список не дополнен. ' + error.message;
    } finally {
      if (current(list, capturedToken) && serial === organizationSerial) {
        list.removeAttribute('aria-busy');
        controls('[data-billing-organization-more]', false);
      }
    }
  }
  async function loadOrders(more = false, initial = false) {
    const root = content(),
      section = root?.querySelector('.paid-package-orders'),
      form = section?.querySelector('[data-billing-orders-filter]');
    if (!form || section.hasAttribute('aria-busy')) return;
    form.elements.q.value = form.elements.q.value.trim();
    if (!form.reportValidity()) return;
    const filters = {
      status: form.elements.status.value,
      q: form.elements.q.value,
      ...(form.elements.serviceCode ? { serviceCode: form.elements.serviceCode.value } : {}),
    };
    if (
      filters.status !== applied.status ||
      filters.q !== applied.q ||
      filters.serviceCode !== applied.serviceCode
    )
      more = false;
    if (!more && !initial && !permitReplacement(section)) {
      form.elements.status.value = applied.status;
      form.elements.q.value = applied.q;
      if (form.elements.serviceCode) form.elements.serviceCode.value = applied.serviceCode || '';
      return;
    }
    if (more && !nextCursor) return;
    const serial = ++orderSerial,
      capturedToken = token,
      parameters = {
        ...filters,
        ...(organizationId ? { organizationId } : {}),
        ...(more ? { before: nextCursor } : {}),
      };
    const result = section.querySelector('[data-billing-orders-message]'),
      list = section.querySelector('[data-billing-orders-list]');
    const locks = new Map();
    if (!more)
      for (const control of section.querySelectorAll(
        '[data-admin-payment-review] fieldset, [data-admin-payment-review] [type="submit"]',
      )) {
        locks.set(control, control.disabled);
        control.disabled = true;
      }
    controls(
      '[data-billing-orders-filter] input, [data-billing-orders-filter] select, [data-billing-orders-filter] button, [data-billing-orders-more]',
      true,
    );
    section.setAttribute('aria-busy', 'true');
    result.textContent = 'Загружаем заказы…';
    try {
      const data = await request('/api/admin/billing/orders?' + new URLSearchParams(parameters));
      if (!current(section, capturedToken) || serial !== orderSerial) return;
      if (!more) list.innerHTML = '';
      const ids = new Set(
        [...list.querySelectorAll('[data-admin-order-id]')].map(
          (node) => node.dataset.adminOrderId,
        ),
      );
      list.insertAdjacentHTML(
        'beforeend',
        view.orderRowsHtml(
          (data.orders || []).filter((item) => {
            const id = item.checkoutId || item.id;
            if (ids.has(id)) return false;
            ids.add(id);
            return true;
          }),
        ),
      );
      applied = filters;
      remembered.set(scopeKey(), filters);
      nextCursor = data.nextCursor || null;
      setOrderState();
      restorePending();
      result.textContent = '';
    } catch (error) {
      if (current(section, capturedToken) && serial === orderSerial)
        result.textContent = 'Список заказов не обновлён. ' + error.message;
    } finally {
      if (current(section, capturedToken) && serial === orderSerial) {
        section.removeAttribute('aria-busy');
        for (const [control, disabled] of locks)
          if (control.isConnected) control.disabled = disabled;
        controls(
          '[data-billing-orders-filter] input, [data-billing-orders-filter] select, [data-billing-orders-filter] button, [data-billing-orders-more]',
          false,
        );
      }
    }
  }
  function init(data, target, generation) {
    organizationId = target;
    token = generation;
    organizationSerial++;
    orderSerial++;
    nextOffset = data.nextOffset ?? null;
    total = data.organizationTotal ?? null;
    nextCursor = data.ordersNextCursor || null;
    applied = { status: 'all', q: '' };
    setOrganizationState();
    setOrderState();
    const filters = remembered.get(scopeKey()),
      form = content()?.querySelector('[data-billing-orders-filter]');
    if (filters && form && (filters.status !== 'all' || filters.q || filters.serviceCode)) {
      form.elements.status.value = filters.status;
      form.elements.q.value = filters.q;
      if (form.elements.serviceCode) form.elements.serviceCode.value = filters.serviceCode || '';
      void loadOrders(false, true);
    }
  }
  function bind() {
    document.addEventListener('submit', (event) => {
      if (!event.target.matches?.('[data-billing-orders-filter]')) return;
      event.preventDefault();
      void loadOrders();
    });
    document.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-billing-organization-more]')) void loadOrganizations();
      if (event.target.closest?.('[data-billing-orders-more]')) void loadOrders(true);
      if (event.target.closest?.('[data-billing-orders-reset]')) {
        const form = content()?.querySelector('[data-billing-orders-filter]');
        if (!form) return;
        form.elements.status.value = 'all';
        form.elements.q.value = '';
        if (form.elements.serviceCode) form.elements.serviceCode.value = '';
        void loadOrders();
      }
    });
  }
  return { init, bind };
}
