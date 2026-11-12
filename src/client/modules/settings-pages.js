function createSettingsPages(state, actions) {
  function settingsSectionVisible(selector) {
    const element = typeof selector === 'string' ? actions.$(selector) : selector;
    return (
      state.currentView === 'settings' &&
      state.sessionReady !== false &&
      !document.hidden &&
      Boolean(element?.isConnected) &&
      !element.closest('[hidden], details:not([open]), dialog:not([open])')
    );
  }
  function sizeSettingsPage() {
    const panel = actions.$('.settings-panel.settings-pages');
    if (!panel || state.currentView !== 'settings') return;
    const landscape = document.body.classList.contains('phone-landscape');
    const height = window.visualViewport?.height || window.innerHeight;
    const nav = document.querySelector('.topbar .app-nav'),
      bar = document.querySelector('.topbar'),
      fixed =
        nav && window.getComputedStyle(nav).position === 'fixed'
          ? nav
          : bar && window.getComputedStyle(bar).position === 'fixed'
            ? bar
            : null;
    const bounds = fixed?.getBoundingClientRect();
    const bottom = fixed && bounds.top > height / 2 ? Math.max(0, height - bounds.top) : 0;
    const workspace = landscape && panel.closest('.workspace');
    const workspaceBottom = workspace
      ? workspace.getBoundingClientRect().bottom -
        (parseFloat(window.getComputedStyle(workspace).paddingBottom) || 0)
      : height;
    const available = landscape
      ? Math.min(height + (window.visualViewport?.offsetTop || 0), workspaceBottom) -
        panel.getBoundingClientRect().top
      : height - panel.getBoundingClientRect().top - bottom - 16;
    panel.style.setProperty(
      '--settings-space',
      `${Math.max(landscape ? 0 : 220, Math.floor(available))}px`,
    );
    const tiles = panel.querySelector('.settings-tiles');
    if (!landscape && tiles && window.matchMedia('(min-width: 981px)').matches) {
      // The page is anchored to the panel, outside the independently scrolling menu.
      panel.style.setProperty('--settings-desktop-top', `${tiles.offsetTop}px`);
      panel.style.setProperty(
        '--settings-desktop-bottom',
        `${Math.max(0, panel.clientHeight - tiles.offsetTop - tiles.offsetHeight)}px`,
      );
    } else {
      panel.style.removeProperty('--settings-desktop-top');
      panel.style.removeProperty('--settings-desktop-bottom');
    }
  }
  function syncSettingsPage(block = null) {
    const panel = actions.$('.settings-panel');
    const tiles = panel?.querySelector('.settings-tiles');
    if (!tiles) return;
    if (block?.open)
      for (const other of tiles.children)
        if (other !== block && other.matches('details.settings-tile[open]')) other.open = false;
    if (!panel.classList.contains('settings-pages')) return;
    const active = tiles.querySelector(':scope > details.settings-tile[open]');
    if (active) {
      panel.dataset.settingsOpen = active.querySelector('.settings-accordion-content')?.id || '';
      tiles.dataset.settingsOpen = panel.dataset.settingsOpen;
    } else {
      delete panel.dataset.settingsOpen;
      delete tiles.dataset.settingsOpen;
    }
    sizeSettingsPage();
  }
  function mountSettingsPages() {
    const panel = actions.$('.settings-panel.settings-pages');
    if (!panel) return;
    if (
      !document.body.classList.contains('phone-landscape') &&
      window.matchMedia('(min-width: 980px)').matches
    ) {
      const first = panel.querySelector('.settings-tiles > details.settings-tile');
      if (first) first.open = true;
    }
    syncSettingsPage();
  }
  function bindSettingsPageEvents() {
    const root = actions.$('#global-view');
    root.addEventListener(
      'toggle',
      (event) => {
        const block = event.target;
        if (!block.matches('.settings-tiles > details.settings-tile')) return;
        syncSettingsPage(block);
        if (block.open) {
          block.querySelector('.settings-page-title')?.focus({ preventScroll: true });
          void actions.syncVisibleTelegram({ force: true });
        }
      },
      true,
    );
    root.addEventListener('click', (event) => {
      const back = event.target.closest('[data-settings-back]');
      if (!back || state.busy) return;
      const block = back.closest('details.settings-tile');
      if (!block) return;
      block.open = false;
      syncSettingsPage();
      block.querySelector(':scope > summary')?.focus({ preventScroll: true });
    });
    window.addEventListener('resize', sizeSettingsPage);
    window.visualViewport?.addEventListener('resize', sizeSettingsPage);
    document.addEventListener('phone-layout-change', sizeSettingsPage);
  }
  return { mountSettingsPages, bindSettingsPageEvents, settingsSectionVisible };
}
