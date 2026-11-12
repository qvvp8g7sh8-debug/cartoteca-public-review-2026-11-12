function createStaffChannelPanels(state, actions) {
  const bound = new WeakSet(),
    renderedBodies = new WeakMap();
  function mountStaffChannelPanels(root) {
    for (const host of root.querySelectorAll('.staff-channel-host')) {
      if (bound.has(host)) continue;
      bound.add(host);
      const trigger = host.querySelector('[data-staff-channel-open]');
      const dialog = host.querySelector('.staff-channel-dialog');
      const close = () => dialog.close();
      trigger.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.staff-channel-dialog[open]'))
          if (other !== dialog) other.close();
        if (!dialog.open) dialog.showModal();
        trigger.setAttribute('aria-expanded', 'true');
      });
      dialog.querySelector('[data-staff-channel-close]').addEventListener('click', close);
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
      });
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          close();
      });
      dialog.addEventListener('close', () => {
        trigger.setAttribute('aria-expanded', 'false');
        if (trigger.isConnected && !document.querySelector('dialog[open]'))
          trigger.focus({ preventScroll: true });
      });
    }
  }
  function renderStaffChannelPanel(root, view) {
    const { id, name, status, linked, loading, body, message = '' } = view;
    const esc = actions.esc;
    if (!root.querySelector('.staff-channel-host')) {
      root.innerHTML = [
        `<section class="staff-notification-channel staff-channel-host ${id === 'push' ? 'staff-push-channel' : ''}" data-staff-channel="${esc(id)}">`,
        `<button type="button" class="connection-service connection-${esc(id)} staff-channel-trigger" data-staff-channel-open="${esc(id)}" aria-haspopup="dialog" aria-controls="staff-channel-dialog-${esc(id)}" aria-expanded="false">${actions.staffChannelIconHtml(id)}</button>`,
        `<dialog class="staff-channel-dialog" id="staff-channel-dialog-${esc(id)}" aria-labelledby="staff-channel-heading-${esc(id)}" aria-describedby="staff-channel-status-${esc(id)}">`,
        `<header class="staff-channel-dialog-header"><div><h3 id="staff-channel-heading-${esc(id)}">${esc(name)}</h3><p id="staff-channel-status-${esc(id)}" class="staff-channel-status"></p></div>`,
        `<button type="button" class="staff-channel-close" data-staff-channel-close aria-label="Закрыть настройки ${esc(name)}">×</button></header>`,
        '<div class="staff-notification-body staff-channel-content"></div>',
        '<p class="telegram-settings-result staff-channel-message" role="status" aria-live="polite"></p></dialog></section>',
      ].join('');
      mountStaffChannelPanels(root);
    }
    const host = root.querySelector('.staff-channel-host');
    const trigger = host.querySelector('[data-staff-channel-open]');
    trigger.classList.toggle('is-linked', Boolean(linked));
    trigger.classList.toggle('is-loading', Boolean(loading));
    trigger.title = `${name}: ${status}`;
    trigger.setAttribute('aria-label', `${name}: ${status}. Открыть настройки`);
    host.dataset.staffState = linked ? 'ready' : loading ? 'loading' : 'unlinked';
    host.querySelector('.staff-channel-status').textContent = status;
    host.querySelector('.staff-channel-status').classList.toggle('is-linked', Boolean(linked));
    host.querySelector('.staff-channel-message').textContent = message;
    const content = host.querySelector('.staff-channel-content');
    const changed = renderedBodies.get(content) !== body;
    if (changed) {
      const fields = [...content.querySelectorAll('input,select,button,a')];
      const focused = document.activeElement,
        index = fields.indexOf(focused);
      content.innerHTML = body;
      renderedBodies.set(content, body);
      const replacement =
        index >= 0 ? content.querySelectorAll('input,select,button,a')[index] : null;
      if (
        host.querySelector('dialog').open &&
        replacement &&
        !replacement.disabled &&
        replacement.tagName === focused.tagName
      )
        replacement.focus({ preventScroll: true });
    }
    return changed;
  }
  return { renderStaffChannelPanel, mountStaffChannelPanels };
}
