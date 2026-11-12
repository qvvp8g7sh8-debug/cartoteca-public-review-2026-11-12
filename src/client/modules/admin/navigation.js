function createAdminNavigation({ $ }) {
  const root = $('#admin-voice-assistant');
  let bound = false;
  const tabs = () => [...root.querySelectorAll('[data-admin-voice-tab]')];
  function activate(button, focus = false) {
    const key = button.dataset.adminVoiceTab;
    for (const tab of tabs()) {
      const selected = tab === button;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of root.querySelectorAll('[data-admin-voice-panel]'))
      panel.hidden = panel.dataset.adminVoicePanel !== key;
    if (focus) button.focus();
  }
  function bind() {
    if (bound) return;
    bound = true;
    root.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-admin-voice-tab]');
      if (tab) activate(tab);
    });
    root.addEventListener('keydown', (event) => {
      const tab = event.target.closest('[data-admin-voice-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = tabs(),
        index = buttons.indexOf(tab);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      activate(buttons[next], true);
    });
    // Keep native validation usable even when an advanced group is collapsed.
    root.addEventListener(
      'invalid',
      (event) => {
        const panel = event.target.closest('[data-admin-voice-panel]');
        if (panel) {
          const tab = tabs().find(
            (item) => item.dataset.adminVoiceTab === panel.dataset.adminVoicePanel,
          );
          if (tab) activate(tab);
        }
        let detail = event.target.closest('details');
        while (detail && root.contains(detail)) {
          detail.open = true;
          detail = detail.parentElement.closest('details');
        }
      },
      true,
    );
  }
  return { bind };
}
