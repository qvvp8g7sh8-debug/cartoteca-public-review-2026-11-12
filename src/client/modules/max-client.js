function createMaxClient(state, actions) {
  const invitations = new Map(),
    statuses = new Map(),
    preparing = new Map();
  let pendingRead = null;
  const key = (id) => [state.account?.id, state.account?.organizationId, id].join(':');
  const current = (id, savedKey) =>
    state.currentView === 'card' && state.selectedId === id && key(id) === savedKey;
  const mark = '<span class="connection-max-mark" aria-hidden="true">MAX</span>';
  function render(root, id, result) {
    const saved = key(id),
      pending = invitations.get(saved);
    if (result.linked || pending?.expiresAt <= Date.now()) {
      if (pending) {
        pending.expiresAt = 0;
        actions.dismissMaxInvitation();
      }
      invitations.delete(saved);
    }
    statuses.set(saved, result);
    const invitation = invitations.get(saved);
    const signature = JSON.stringify([result, invitation?.url]);
    if (root.dataset.maxSignature === signature) return;
    root.dataset.maxSignature = signature;
    const attr = result.linked
      ? 'data-max-unlink'
      : invitation
        ? 'data-max-invitation'
        : 'data-max-link';
    const disabled = result.linked ? !result.canDisconnect : !invitation && !result.canConnect;
    const title = result.linked
      ? result.compatible
        ? 'MAX подключён. Нажмите, чтобы отключить.'
        : 'Привязку нужно обновить. Отключите её и подключите MAX заново.'
      : disabled
        ? 'Подключение MAX готовится: сначала проверка хранения и настройка бота.'
        : 'Подключить клиента к MAX';
    const label = result.linked
      ? result.compatible
        ? '<span class="connection-check" aria-hidden="true">✓</span> Подключён'
        : 'Переподключить'
      : invitation
        ? 'Приглашение'
        : disabled
          ? 'Недоступно'
          : 'Не подключён · подключить';
    root.innerHTML =
      '<button type="button" class="connection-service connection-max' +
      (result.linked && result.compatible ? ' is-linked' : disabled ? ' is-future' : '') +
      '" ' +
      attr +
      '="' +
      actions.esc(id) +
      '"' +
      (disabled ? ' disabled' : '') +
      ' title="' +
      actions.esc(title) +
      '" aria-label="' +
      actions.esc(title) +
      '">' +
      mark +
      '<span><strong>MAX</strong><small>' +
      label +
      '</small></span></button>';
    actions.updateClientServiceSummary(
      id,
      'max',
      result.linked ? (result.compatible ? 'linked' : 'reconnect') : 'unlinked',
    );
  }
  async function loadPatientMax(id = state.selectedId, { force = false } = {}) {
    const root = actions.$('#patient-max-connection');
    if (!state.multiUser || !state.account || !id || !root || root.dataset.patientId !== id) return;
    const owningDocument = root.ownerDocument,
      owningWindow = owningDocument.defaultView;
    if (!owningWindow || !root.isConnected) return;
    const savedKey = key(id),
      account = state.account;
    if (!current(id, savedKey)) return;
    if (
      !force &&
      pendingRead?.key === savedKey &&
      pendingRead.account === account &&
      pendingRead.root === root &&
      !pendingRead.controller.signal.aborted
    )
      return pendingRead.task;
    // A completed link/unlink needs a post-write read, never an older polling result.
    pendingRead?.controller.abort();
    const controller = new owningWindow.AbortController(),
      owned = { key: savedKey, account, root, controller, task: null },
      timeout = owningWindow.setTimeout(() => controller.abort(), 12000);
    let retired = false;
    const active = () =>
      !retired &&
      pendingRead === owned &&
      state.account === account &&
      root.isConnected &&
      root === actions.$('#patient-max-connection') &&
      current(id, savedKey);
    const cancel = () => {
      retired = true;
      controller.abort();
    };
    const hidden = () => {
      if (owningDocument.hidden) cancel();
    };
    const observer = new owningWindow.MutationObserver(() => {
      if (!active()) cancel();
    });
    pendingRead = owned;
    observer.observe(owningDocument.body, { childList: true, subtree: true });
    owningWindow.addEventListener('pagehide', cancel);
    owningDocument.addEventListener('visibilitychange', hidden);
    owned.task = (async () => {
      try {
        const url = '/api/max/patient?patientId=' + encodeURIComponent(id);
        let result = await actions.request(
          url + (actions.patientView()?.patient.id === id ? '&view=card' : ''),
          { signal: controller.signal },
        );
        if (active() && result.viewUnsupported === true) {
          await actions.ensurePatient(id);
          if (!active()) return;
          result = await actions.request(url, { signal: controller.signal });
        }
        if (active() && !controller.signal.aborted) render(root, id, result);
      } catch {
        if (!active()) return;
        delete root.dataset.maxSignature;
        root.innerHTML =
          '<button type="button" class="connection-service is-future" disabled title="Не удалось прочитать состояние MAX. Повторим автоматически.">' +
          mark +
          '<span><strong>MAX</strong><small>Недоступен</small></span></button>';
        actions.updateClientServiceSummary(id, 'max', 'unavailable');
      } finally {
        owningWindow.clearTimeout(timeout);
        observer.disconnect();
        owningWindow.removeEventListener('pagehide', cancel);
        owningDocument.removeEventListener('visibilitychange', hidden);
        if (pendingRead === owned) pendingRead = null;
      }
    })();
    return owned.task;
  }
  async function prepare(id) {
    const savedKey = key(id),
      pending = invitations.get(savedKey);
    if (pending?.expiresAt > Date.now()) return pending;
    if (preparing.has(savedKey)) return preparing.get(savedKey);
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 8000);
    const task = (async () => {
      try {
        const result = await actions.request('/api/max/link', {
          method: 'POST',
          body: JSON.stringify({ patientId: id }),
          signal: controller.signal,
        });
        if (!current(id, savedKey)) return null;
        const invitation = {
          ...result,
          patientId: id,
          accountKey: [state.account?.id, state.account?.organizationId].join(':'),
        };
        invitations.set(savedKey, invitation);
        return invitation;
      } finally {
        clearTimeout(timeout);
        preparing.delete(savedKey);
      }
    })();
    preparing.set(savedKey, task);
    return task;
  }
  function bindMaxClientEvents() {
    document.addEventListener('click', async (event) => {
      const button = event.target.closest(
        '[data-max-link],[data-max-invitation],[data-max-unlink]',
      );
      if (!button) return;
      event.stopImmediatePropagation();
      if (state.busy || button.disabled) return;
      const id = button.dataset.maxLink || button.dataset.maxInvitation || button.dataset.maxUnlink;
      const savedKey = key(id),
        saved = statuses.get(savedKey);
      if (!current(id, savedKey)) return;
      try {
        state.busy = true;
        if (button.hasAttribute('data-max-unlink')) {
          if (
            !saved?.canDisconnect ||
            !window.confirm('Отключить MAX этого клиента? Telegram останется подключённым.')
          )
            return;
          await actions.request('/api/max/unlink', {
            method: 'POST',
            body: JSON.stringify({ patientId: id, bindingId: saved.bindingId }),
          });
        } else {
          const invitation = await prepare(id);
          if (invitation && current(id, savedKey)) actions.showMaxInvitation(invitation);
        }
        if (current(id, savedKey)) await loadPatientMax(id, { force: true });
      } catch (error) {
        if (current(id, savedKey)) actions.toast(error.message);
      } finally {
        state.busy = false;
      }
    });
  }
  return { loadPatientMax, bindMaxClientEvents };
}
