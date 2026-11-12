function createManagement(state, actions) {
  const wideLayout = window.matchMedia?.('(min-width: 981px)');
  let section = 'services',
    activeScope = '';
  const sections = [
    {
      id: 'services',
      label: 'Услуги',
      description: 'Каталог и выбор услуг для записи',
      icon: '<path d="M3 4v8l9 9 9-9-9-9H4a1 1 0 0 0-1 1Z"/><circle cx="7" cy="7" r="1.4"/>',
    },
    {
      id: 'schedule',
      label: 'Рабочее время',
      description: 'Дни, часы и перерывы сотрудников',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    },
    {
      id: 'requests',
      label: 'Заявки',
      description: 'Приём и согласование онлайн-записей',
      icon: '<path d="M4 4h16v16H4zM7 8h10M7 12h5m1 4 2 2 4-4"/>',
    },
  ];
  function resetScope() {
    const key = JSON.stringify([state.account?.id, state.account?.organizationId]);
    if (key !== activeScope) {
      activeScope = key;
      section = 'services';
    }
    if (!state.multiUser) section = 'services';
  }
  function managementHtml() {
    resetScope();
    const available = state.multiUser ? sections : sections.slice(0, 1);
    const content =
      section === 'schedule'
        ? actions.workScheduleSettingsHtml()
        : section === 'requests'
          ? actions.bookingRequestsPanelHtml()
          : actions.servicesHtml();
    return [
      '<section class="global-panel management-panel" aria-label="Управление">',
      '<header class="management-heading"><h2>Управление</h2></header>',
      '<div class="management-tabs" role="tablist" aria-label="Разделы управления" aria-orientation="horizontal">',
      ...available.map((item) =>
        [
          `<button type="button" role="tab" id="management-tab-${item.id}" data-management-tab="${item.id}" aria-controls="management-content" aria-selected="${section === item.id}" tabindex="${section === item.id ? 0 : -1}">`,
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
          item.id === 'services' && !state.multiUser
            ? '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'
            : item.icon,
          state.multiUser
            ? `</svg><span class="management-tab-copy"><span>${item.label}</span><small>${item.description}</small></span>`
            : `</svg><span>${item.label}</span>`,
          item.id === 'requests'
            ? '<span class="booking-inbox-count" data-booking-request-count hidden></span>'
            : '',
          '</button>',
        ].join(''),
      ),
      `</div><div id="management-content" class="management-content" role="tabpanel" aria-labelledby="management-tab-${section}" tabindex="0">`,
      content,
      '</div></section>',
    ].join('');
  }
  function mountManagement() {
    if (state.currentView !== 'services') return;
    actions.renderBookingInbox();
    if (section === 'schedule') void actions.loadWorkSchedules();
    if (section === 'requests') actions.mountBookingRequests();
  }
  async function openManagement(next = 'services') {
    if (state.busy) return;
    resetScope();
    if (!sections.some((item) => item.id === next) || (!state.multiUser && next !== 'services'))
      return;
    if (next !== 'services') actions.configureServiceView({ editing: false });
    section = next;
    await actions.setView('services');
  }
  async function openBookingSettings() {
    await actions.setView('settings');
    const root = actions.$('#online-booking-settings');
    const accordion = root?.closest('details');
    if (accordion) {
      accordion.open = true;
      accordion.querySelector('summary')?.focus();
      accordion.scrollIntoView?.({ block: 'start' });
    }
  }
  function bindManagementEvents() {
    const root = actions.$('#global-view');
    wideLayout?.addEventListener('change', () => {
      root.querySelector('.management-tabs')?.setAttribute('aria-orientation', 'horizontal');
    });
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-management-tab],[data-open-booking-settings]');
      if (!button || state.busy) return;
      event.stopPropagation();
      if (button.hasAttribute('data-open-booking-settings')) {
        await openBookingSettings();
        return;
      }
      if (state.currentView === 'services' && button.dataset.managementTab === section) return;
      await openManagement(button.dataset.managementTab);
      actions.$('[data-management-tab][aria-selected="true"]')?.focus({ preventScroll: true });
    });
    root.addEventListener('keydown', async (event) => {
      const tab = event.target.closest('[role="tab"][data-management-tab]');
      if (
        !tab ||
        state.busy ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
      )
        return;
      event.preventDefault();
      const tabs = [...root.querySelectorAll('[data-management-tab]')];
      const index = tabs.indexOf(tab);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + tabs.length) %
              tabs.length;
      if (tabs[next] !== tab) await openManagement(tabs[next].dataset.managementTab);
      actions.$('[data-management-tab][aria-selected="true"]')?.focus({ preventScroll: true });
    });
  }
  return { managementHtml, mountManagement, openManagement, bindManagementEvents };
}
