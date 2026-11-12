function createServices(state, actions) {
  const view = {
    editing: false,
    category: 'all',
    query: '',
    selectedIds: new Set(),
  };
  let catalogScope = '';
  function serviceView() {
    const staffId = actions.serviceStaffId();
    const scope = JSON.stringify([state.account?.id, state.account?.organizationId, staffId]);
    if (scope !== catalogScope) {
      catalogScope = scope;
      view.selectedIds.clear();
      view.editing = false;
    }
    return Object.freeze({
      editing: view.editing,
      category: view.category,
      query: view.query,
      staffId,
    });
  }
  function configureServiceView(values) {
    serviceView();
    if (values.staffId !== undefined) {
      actions.selectServiceStaff(values.staffId);
      serviceView();
    }
    if (values.editing !== undefined)
      view.editing = Boolean(values.editing) && actions.canEditServices();
    if (values.category !== undefined)
      view.category =
        values.category === 'all' ||
        state.SERVICE_CATEGORIES.some((category) => category.id === values.category)
          ? values.category
          : 'all';
    if (values.query !== undefined) view.query = String(values.query);
  }
  function toggleServiceSelection(id) {
    serviceView();
    if (actions.servicesForStaff(actions.serviceStaffId()).some((service) => service.id === id))
      view.selectedIds.has(id) ? view.selectedIds.delete(id) : view.selectedIds.add(id);
  }
  function removeServiceSelection(id) {
    view.selectedIds.delete(id);
  }
  function clearServiceSelection() {
    view.selectedIds.clear();
  }
  function selectedServices() {
    serviceView();
    return structuredClone(
      actions
        .servicesForStaff(actions.serviceStaffId())
        .filter((service) => view.selectedIds.has(service.id)),
    );
  }
  function serviceCategory(service) {
    if (state.SERVICE_CATEGORIES.some((category) => category.id === service?.category))
      return service.category;
    return 'other';
  }
  function categoryOptions(current = 'other') {
    return state.SERVICE_CATEGORIES.map(
      (category) =>
        `<option value="${actions.esc(category.id)}" ${category.id === current ? 'selected' : ''}>${actions.esc(category.title)}</option>`,
    ).join('');
  }
  function durationMinutes(value) {
    const match = String(value || '')
      .trim()
      .match(/^(\d+)(?:\s*(мин(?:ут(?:а|ы)?)?|м|час(?:а|ов)?|ч))?/i);
    return match ? Number(match[1]) * (/^(час|ч)/i.test(match[2] || '') ? 60 : 1) : 60;
  }
  function formatMinutes(value) {
    const minutes = Number(value) || 0;
    return minutes >= 60 && minutes % 60 === 0
      ? `${minutes / 60} ${actions.plural(minutes / 60, 'час', 'часа', 'часов')}`
      : `${minutes} минут`;
  }
  function serviceResultsHtml() {
    serviceView();
    const normalize = (value) =>
      String(value || '')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/g, 'е');
    const words = normalize(view.query).trim().split(/\s+/).filter(Boolean);
    const groups = state.SERVICE_CATEGORIES.filter(
      (category) => view.category === 'all' || category.id === view.category,
    ).map((category) => ({
      category,
      items: actions.servicesForStaff(actions.serviceStaffId()).filter((service) => {
        if (actions.serviceCategory(service) !== category.id) return false;
        const text = normalize([service.name, service.description, category.title].join(' '));
        return words.every((word) => text.includes(word));
      }),
    }));
    const populated = groups.filter((group) => group.items.length);
    if (!populated.length) {
      const category = groups[0]?.category;
      return [
        `<div class="service-category-empty">`,
        `<p>${words.length ? 'Услуги не найдены. Попробуйте другое название или группу.' : 'Здесь пока нет услуг.'}</p>${!words.length && actions.canEditServices() ? `<button class="text-btn" data-new-service-category="${category?.id || 'other'}">+ Добавить услугу</button>` : ''}</div>`,
      ].join('');
    }
    const rows = populated.map(({ category, items }) => ({
      category,
      html: items
        .map((service) => {
          const detail = [
            view.category === 'all' && category.id !== 'other' ? category.title : '',
            service.description,
          ]
            .filter(Boolean)
            .join(' · ');
          const product = detail
            ? `<small class="service-card-product" title="${actions.esc(detail)}">${actions.esc(detail)}</small>`
            : '';
          const main = [
            `<span class="service-row-main">`,
            `<strong title="${actions.esc(service.name)}">${actions.esc(service.name)}</strong>`,
            `<span class="service-row-meta">`,
            `<span class="service-card-duration">${actions.esc(service.duration)}</span>`,
            `<span aria-hidden="true">·</span>`,
            `<span class="service-card-price">${actions.esc(actions.formatPrice(service.price))}</span>`,
            `</span>${product}</span>`,
          ].join('');
          if (view.editing)
            return [
              `<article class="service-setting service-edit-card">${main}<div class="setting-actions">`,
              `<button class="secondary" `,
              `data-edit-service="${actions.esc(service.id)}">Изменить</button>${actions.canDelete() ? `<button class="text-btn danger" data-delete-service="${actions.esc(service.id)}">Удалить</button>` : ''}</div>`,
              `</article>`,
            ].join('');
          const selected = view.selectedIds.has(service.id);
          return [
            `<button class="service-select-card ${selected ? 'selected' : ''}" `,
            `data-select-service="${actions.esc(service.id)}" `,
            `aria-pressed="${selected}">${main}<span class="service-card-check" `,
            `aria-hidden="true">${selected ? '✓' : '+'}</span>`,
            `</button>`,
          ].join('');
        })
        .join(''),
    }));
    if (view.category === 'all')
      return `<section class="service-result-group" aria-label="Все услуги"><div class="service-category-content">${rows.map((row) => row.html).join('')}</div></section>`;
    return rows
      .map(
        ({ category, html }) =>
          `<section class="service-result-group" aria-label="${actions.esc(category.title)}"><div class="service-category-content">${html}</div></section>`,
      )
      .join('');
  }
  function renderServiceResults() {
    const panel = actions.$('#service-category-panel');
    if (panel) panel.innerHTML = serviceResultsHtml();
    const groupControls = actions.$('[data-service-group-controls]');
    if (groupControls && groupControls.dataset.serviceGroupControls !== view.category) {
      groupControls.innerHTML = actions.serviceGroupControlHtml(view.category);
      groupControls.dataset.serviceGroupControls = view.category;
    }
    const clear = actions.$('#clear-service-search');
    if (clear) clear.hidden = !view.query;
  }
  function servicesHtml() {
    const selected = selectedServices();
    const totalMinutes = selected.reduce(
      (sum, service) => sum + actions.durationMinutes(service.duration),
      0,
    );
    const totalPrice = selected.reduce((sum, service) => sum + (Number(service.price) || 0), 0);
    if (
      view.category !== 'all' &&
      !state.SERVICE_CATEGORIES.some((category) => category.id === view.category)
    )
      view.category = 'all';
    const categories = [{ id: 'all', title: 'Все услуги' }, ...state.SERVICE_CATEGORIES];
    const categoryNav = categories
      .map((category) =>
        [
          `<button class="service-category-tab ${category.id === view.category ? 'active' : ''}" `,
          `data-service-category-tab="${category.id}" `,
          `aria-pressed="${category.id === view.category}" `,
          `aria-controls="service-category-panel">`,
          `<strong>${actions.esc(category.title)}</strong>`,
          `</button>`,
        ].join(''),
      )
      .join('');
    const categorySelect = [
      `<label class="service-category-select">`,
      `<span>Группа</span>`,
      `<select id="service-category-select" `,
      `aria-label="Группа услуг">${categories.map((category) => `<option value="${category.id}" ${category.id === view.category ? 'selected' : ''}>${actions.esc(category.title)}</option>`).join('')}</select>`,
      `</label>`,
    ].join('');
    const search = [
      `<div class="service-catalog-search">`,
      `<svg viewBox="0 0 24 24" `,
      `aria-hidden="true">`,
      `<circle cx="10.5" `,
      `cy="10.5" `,
      `r="6.5"/>`,
      `<path d="m16 16 5 5"/>`,
      `</svg>`,
      `<input id="service-search" `,
      `type="search" `,
      `aria-label="Поиск услуг" `,
      `placeholder="Найти услугу" `,
      `value="${actions.esc(view.query)}" `,
      `autocomplete="off">`,
      `<button type="button" `,
      `id="clear-service-search" `,
      `aria-label="Очистить поиск услуг" ${view.query ? '' : 'hidden'}>×</button>`,
      `</div>`,
    ].join('');
    const catalog = [
      `<div class="service-catalog-layout service-catalog-modern">`,
      `<div class="service-catalog-toolbar">${search}${categorySelect}</div>`,
      `<nav class="service-category-nav" `,
      `aria-label="Группы услуг">${categoryNav}</nav>`,
      `<div class="service-category-panel" `,
      `id="service-category-panel" `,
      `aria-live="polite">${serviceResultsHtml()}</div>`,
      `</div>`,
    ].join('');
    const groupControls = view.editing ? actions.serviceGroupControlHtml(view.category) : '';
    const selectionBar = view.editing
      ? [
          `<div class="service-edit-notice">`,
          `<strong>Режим редактирования включён</strong>`,
          `<span>Изменяйте услуги и распределяйте их по своим группам.</span>`,
          groupControls
            ? `<div class="service-group-controls" data-service-group-controls="${actions.esc(view.category)}">${groupControls}</div>`
            : '',
          `</div>`,
        ].join('')
      : [
          `<div class="service-selection-bar ${selected.length ? 'has-selection' : 'is-empty'}">${
            selected.length
              ? `<div class="service-selection-overview"><div class="selected-services-list" aria-label="Выбранные услуги">${selected
                  .map((service) =>
                    [
                      `<button class="selected-service-card" `,
                      `data-remove-selected-service="${actions.esc(service.id)}" `,
                      `aria-label="Убрать услугу ${actions.esc(service.name)}" `,
                      `title="Убрать из записи">`,
                      `<span>${actions.esc(service.name)}</span>`,
                      `<small>${actions.esc(service.duration)}</small>`,
                      `<b aria-hidden="true">×</b>`,
                      `</button>`,
                    ].join(''),
                  )
                  .join('')}</div></div>`
              : '<div class="service-selection-empty"><span>Выберите одну или несколько услуг для записи</span></div>'
          }<div class="service-selection-actions">${selected.length ? '<button class="text-btn" id="clear-service-selection">Очистить</button>' : ''}<div class="service-create-stack">`,
          `<button class="primary" `,
          `id="create-appointment-from-services" ${selected.length ? '' : 'disabled'}>Создать запись</button>${selected.length ? `<span class="service-selection-total">Итого: ${actions.formatMinutes(totalMinutes)} · ${actions.formatPrice(totalPrice)}</span>` : ''}</div>`,
          `</div>`,
          `</div>`,
        ].join('');
    return [
      `<section class="global-panel services-panel">`,
      actions.serviceStaffHtml(),
      `<div class="services-heading">`,
      `<div>`,
      `<h2>Услуги</h2>`,
      `<p class="global-subtitle">Выберите одну или несколько услуг — общая длительность будет рассчитана автоматически.</p>`,
      `</div>${
        actions.canEditServices()
          ? [
              `<div class="services-heading-actions">`,
              `<button class="primary" `,
              `id="new-service">+ Новая услуга</button>`,
              `<button class="secondary ${view.editing ? 'active' : ''}" `,
              `id="toggle-service-edit" `,
              `aria-pressed="${view.editing}">${view.editing ? 'Завершить редактирование' : 'Редактировать услуги'}</button>`,
              `</div>`,
            ].join('')
          : ''
      }</div>${selectionBar}${catalog}</section>`,
    ].join('');
  }
  async function saveServices() {
    await actions.save();
  }
  function formatPrice(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0
      ? `${new Intl.NumberFormat('ru-RU').format(n)} ₽`
      : 'Цена не указана';
  }

  return {
    serviceView,
    configureServiceView,
    toggleServiceSelection,
    removeServiceSelection,
    clearServiceSelection,
    selectedServices,
    serviceCategory,
    categoryOptions,
    durationMinutes,
    formatMinutes,
    servicesHtml,
    renderServiceResults,
    saveServices,
    formatPrice,
  };
}
