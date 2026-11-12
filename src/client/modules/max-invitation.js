function createMaxInvitation(state, actions) {
  let current = null,
    returnFocus = null,
    expiryTimer;
  const accountKey = () => [state.account?.id, state.account?.organizationId].join(':');
  function valid(invitation) {
    try {
      const url = new URL(invitation.url);
      return (
        state.currentView === 'card' &&
        state.selectedId === invitation.patientId &&
        state.data.some((p) => p.id === invitation.patientId) &&
        invitation.accountKey === accountKey() &&
        invitation.expiresAt > Date.now() &&
        url.protocol === 'https:' &&
        url.hostname === 'max.ru' &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.hash &&
        url.pathname === '/id000000000000_1_bot' &&
        /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('start') || '') &&
        [...url.searchParams.keys()].length === 1
      );
    } catch {
      return false;
    }
  }
  function dismissMaxInvitation() {
    clearTimeout(expiryTimer);
    const dialog = actions.$('#max-invitation-dialog');
    if (dialog?.open) dialog.close();
    current = null;
  }
  function copyStatus(dialog, message, kind) {
    const status = dialog.querySelector('[data-max-invitation-status]');
    status.textContent = message;
    status.dataset.kind = kind;
  }
  function showMaxInvitation(invitation) {
    if (!valid(invitation)) {
      actions.toast('Приглашение MAX изменилось или истекло. Создайте новое.');
      return;
    }
    let dialog = actions.$('#max-invitation-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'max-invitation-dialog';
      dialog.className = 'max-invitation-dialog';
      dialog.setAttribute('aria-labelledby', 'max-invitation-title');
      document.body.append(dialog);
      dialog.addEventListener('close', () => {
        clearTimeout(expiryTimer);
        current = null;
        dialog.replaceChildren();
        if (returnFocus?.isConnected) returnFocus.focus();
        returnFocus = null;
      });
      dialog.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (event.target.closest('[data-close-max-invitation]')) return dismissMaxInvitation();
        const copy = event.target.closest('[data-copy-max-invitation]');
        if (!copy) return;
        if (!current || !valid(current)) {
          dismissMaxInvitation();
          actions.toast('Ссылка недоступна. Откройте приглашение заново.');
          return;
        }
        const saved = current,
          message = copy.dataset.copyMaxInvitation === 'message';
        const text = message ? saved.invitationText + '\n\n' + saved.url : saved.url;
        copyStatus(dialog, '', '');
        try {
          await navigator.clipboard.writeText(text);
          if (current === saved && valid(saved))
            copyStatus(
              dialog,
              message ? 'Сообщение скопировано — отправьте клиенту' : 'Ссылка скопирована',
              'success',
            );
        } catch {
          if (current !== saved || !valid(saved)) return;
          const field = dialog.querySelector(message ? 'textarea' : 'input');
          field.closest('details').open = true;
          field.focus();
          field.select();
          copyStatus(
            dialog,
            'Не удалось скопировать автоматически. Текст выделен — скопируйте его вручную.',
            'manual',
          );
        }
      });
    }
    if (!dialog.open) returnFocus = document.activeElement;
    current = invitation;
    const qr =
      typeof invitation.qrDataUrl === 'string' &&
      invitation.qrDataUrl.length < 100000 &&
      /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(invitation.qrDataUrl)
        ? '<details class="telegram-share-qr"><summary>Показать QR-код клиенту</summary><img width="220" height="220" alt="Персональная ссылка подключения MAX" src="' +
          invitation.qrDataUrl +
          '"></details>'
        : '';
    dialog.innerHTML =
      '<div class="dialog-heading"><h2 id="max-invitation-title">Приглашение в MAX</h2>' +
      '<button type="button" class="icon-btn" data-close-max-invitation aria-label="Закрыть">×</button></div>' +
      '<p class="form-hint">Отправьте персональную ссылку клиенту или покажите QR-код. Клиент должен открыть её в своём MAX и запустить бота. Копирование ссылки не означает подключение.</p>' +
      '<div class="telegram-share-actions"><button type="button" class="primary" data-copy-max-invitation="message">Копировать приглашение</button>' +
      '<button type="button" class="secondary" data-copy-max-invitation="link">Копировать ссылку</button></div>' +
      '<p class="max-invitation-status" data-max-invitation-status role="status" aria-live="polite" aria-atomic="true"></p>' +
      '<details><summary>Ссылка · действует 24 часа</summary><label class="field">Ссылка подключения<input readonly value="' +
      actions.esc(invitation.url) +
      '"></label></details>' +
      '<details><summary>Текст сообщения</summary><label class="field">Приглашение<textarea readonly>' +
      actions.esc(invitation.invitationText + '\n\n' + invitation.url) +
      '</textarea></label></details>' +
      qr;
    if (!dialog.open) dialog.showModal();
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(
      dismissMaxInvitation,
      Math.min(86400000, invitation.expiresAt - Date.now()),
    );
  }
  function bindMaxInvitationEvents() {
    window.addEventListener('pagehide', dismissMaxInvitation);
    document.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('#logout-account,[data-view],[data-patient]'))
          dismissMaxInvitation();
      },
      true,
    );
  }
  return { showMaxInvitation, dismissMaxInvitation, bindMaxInvitationEvents };
}
