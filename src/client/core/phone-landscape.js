function createPhoneLandscape(state, actions) {
  let bound = false,
    frame = 0,
    arrangement = null,
    positionedGrid = null,
    geometryKey = '';
  const anchors = new WeakMap();

  function phoneContext() {
    const width = window.screen?.width || window.innerWidth;
    const height = window.screen?.height || window.innerHeight;
    return (
      state.multiUser &&
      window.matchMedia('(pointer: coarse)').matches &&
      Math.min(width, height) <= 520
    );
  }
  function landscape() {
    return (
      phoneContext() &&
      window.innerWidth >= 540 &&
      window.innerWidth <= 1024 &&
      window.innerHeight <= 500 &&
      window.innerWidth > window.innerHeight
    );
  }
  function rememberGrid(grid) {
    const scroll = grid?.closest('.time-scroll');
    const row = grid?.querySelector('.time-row');
    if (!scroll || !row) return null;
    const scale = row.getBoundingClientRect().height / 60;
    const column = row.firstElementChild?.getBoundingClientRect().width;
    if (!scale || !column) return null;
    const anchor = {
      minute: Number(grid.dataset.firstMinute || 0) + scroll.scrollTop / scale,
      column: scroll.scrollLeft / column,
    };
    anchors.set(grid, anchor);
    return anchor;
  }
  function restoreGrid(grid, anchor) {
    const scroll = grid?.closest('.time-scroll');
    const row = grid?.querySelector('.time-row');
    if (!scroll || !row || !anchor) return;
    scroll.scrollTop =
      (anchor.minute - Number(grid.dataset.firstMinute || 0)) *
      (row.getBoundingClientRect().height / 60);
    scroll.scrollLeft = anchor.column * (row.firstElementChild?.getBoundingClientRect().width || 0);
  }
  function restoreControls() {
    if (!arrangement) return;
    for (const { node, parent, next } of arrangement.moves.slice().reverse()) {
      if (arrangement.panel.isConnected)
        parent.insertBefore(node, next?.parentNode === parent ? next : null);
    }
    for (const node of arrangement.added) node.remove();
    arrangement = null;
  }
  function arrangeControls(panel) {
    if (arrangement?.panel === panel) return;
    restoreControls();
    const toolbar = panel.querySelector('.calendar-actions');
    const mode = toolbar?.querySelector('.calendar-mode');
    if (!toolbar || !mode) return;
    arrangement = { panel, moves: [], added: [] };
    function move(node, parent, next = null) {
      if (!node) return;
      arrangement.moves.push({ node, parent: node.parentNode, next: node.nextSibling });
      parent.insertBefore(node, next);
    }
    const date = panel.querySelector('.date-picker-toggle');
    move(date, toolbar, toolbar.querySelector('[data-calendar-next]'));
    if (date) {
      const label = document.createElement('span');
      label.className = 'phone-landscape-date-label';
      label.textContent = new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
      }).format(state.calendarAnchorDate);
      date.append(label);
      arrangement.added.push(label);
    }
    move(panel.querySelector('.mobile-today'), toolbar, mode);
    const filters = document.createElement('div');
    filters.className = 'phone-calendar-filters';
    toolbar.closest('.calendar-toolbar').after(filters);
    arrangement.added.push(filters);
    move(toolbar.querySelector('.calendar-booking-tools [data-open-work-schedule]'), filters);
    move(panel.querySelector('.calendar-selection'), filters);
    move(panel.querySelector('.calendar-day-tools'), filters);
    // Month/list use the same schedule control without the hourly-grid wrapper.
    move(
      panel.querySelector(
        '.calendar-work-schedule:not(.calendar-day-tools .calendar-work-schedule)',
      ),
      filters,
    );
    const picker = document.createElement('select');
    picker.dataset.phoneCalendarMode = '';
    picker.setAttribute('aria-label', mode.getAttribute('aria-label') || 'Вид календаря');
    for (const button of mode.querySelectorAll('[data-calendar-mode],[data-load-period]')) {
      const option = document.createElement('option');
      option.value = button.dataset.calendarMode || button.dataset.loadPeriod;
      option.textContent = button.textContent;
      option.selected = button.classList.contains('active');
      picker.append(option);
    }
    mode.after(picker);
    arrangement.added.push(picker);
  }
  function sync() {
    frame = 0;
    const grid = document.querySelector('.calendar-panel .time-grid');
    const anchor = anchors.get(grid) || rememberGrid(grid);
    const active = landscape();
    const nextGeometry = `${active}:${window.innerWidth}`;
    const geometryChanged = grid !== positionedGrid || nextGeometry !== geometryKey;
    state.phoneLandscape = active;
    document.body.classList.toggle('phone-landscape', active);
    if (active) {
      const viewport = window.visualViewport;
      document.body.style.setProperty(
        '--phone-landscape-height',
        `${viewport?.height || window.innerHeight}px`,
      );
      document.body.style.setProperty('--phone-viewport-top', `${viewport?.offsetTop || 0}px`);
      const panel = document.querySelector('.calendar-panel');
      if (panel) arrangeControls(panel);
      else restoreControls();
    } else {
      restoreControls();
      document.body.style.removeProperty('--phone-landscape-height');
      document.body.style.removeProperty('--phone-viewport-top');
    }
    if (grid && geometryChanged && (active || phoneContext())) {
      actions.positionCalendarEvents();
      actions.updateCurrentTime();
      restoreGrid(grid, anchor);
      rememberGrid(grid);
    }
    positionedGrid = grid;
    geometryKey = nextGeometry;
    // Consumers recalculate available height after the shell, without reloading their data.
    document.dispatchEvent(new Event('phone-layout-change'));
  }
  function schedule() {
    if (!phoneContext() && !state.phoneLandscape) return;
    if (!frame) frame = window.requestAnimationFrame(sync);
  }
  function preservePhoneCalendarOnResize() {
    if (!phoneContext()) return false;
    schedule();
    return true;
  }
  function bindPhoneLandscapeEvents() {
    if (bound) return;
    bound = true;
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    window.matchMedia('(pointer: coarse)').addEventListener('change', schedule);
    const root = document.querySelector('#global-view');
    if (root) {
      new window.MutationObserver(schedule).observe(root, { childList: true });
      root.addEventListener(
        'scroll',
        (event) => {
          if (event.target.matches?.('.time-scroll'))
            rememberGrid(event.target.querySelector('.time-grid'));
        },
        true,
      );
    }
    document.addEventListener('change', (event) => {
      const picker = event.target.closest?.('[data-phone-calendar-mode]');
      if (
        !state.phoneLandscape ||
        !picker ||
        !['day', 'week', 'month', 'list'].includes(picker.value)
      )
        return;
      const mode = picker.closest('.calendar-actions').querySelector('.calendar-mode');
      const button = Array.from(mode.children).find(
        (item) => (item.dataset.calendarMode || item.dataset.loadPeriod) === picker.value,
      );
      button?.click();
    });
    sync();
  }
  return { bindPhoneLandscapeEvents, preservePhoneCalendarOnResize };
}
