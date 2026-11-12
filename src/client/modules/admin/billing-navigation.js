function createAdminBillingNavigation({ content, scope }) {
  const selected = new Map();
  function activate(key, focus = false) {
    const root = content(),
      tabs = [...(root?.querySelectorAll('[data-admin-billing-tab]') || [])],
      target = tabs.find((tab) => tab.dataset.adminBillingTab === key) || tabs[0];
    if (!target) return;
    key = target.dataset.adminBillingTab;
    for (const tab of tabs) {
      const active = tab === target;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of root.querySelectorAll('[data-admin-billing-panel]'))
      panel.hidden = panel.dataset.adminBillingPanel !== key;
    selected.set(scope() || 'platform', key);
    if (focus) target.focus();
  }
  function restore() {
    activate(selected.get(scope() || 'platform') || 'cabinets');
  }
  function bind() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest?.('[data-admin-billing-tab]');
      if (target && content()?.contains(target)) activate(target.dataset.adminBillingTab);
    });
    document.addEventListener('keydown', (event) => {
      const target = event.target.closest?.('[data-admin-billing-tab]');
      if (
        !target ||
        !content()?.contains(target) ||
        !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
      )
        return;
      event.preventDefault();
      const tabs = [...content().querySelectorAll('[data-admin-billing-tab]')],
        index = tabs.indexOf(target);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activate(tabs[next].dataset.adminBillingTab, true);
    });
    document.addEventListener(
      'invalid',
      (event) => {
        if (!content()?.contains(event.target)) return;
        const panel = event.target.closest('[data-admin-billing-panel]');
        if (panel) activate(panel.dataset.adminBillingPanel);
        for (
          let detail = event.target.closest('details');
          detail && content().contains(detail);
          detail = detail.parentElement.closest('details')
        )
          detail.open = true;
      },
      true,
    );
  }
  return { restore, bind };
}
