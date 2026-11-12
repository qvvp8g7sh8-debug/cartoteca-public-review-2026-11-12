function createActionConfirmation(state, actions) {
  let pending = null;
  function confirmAction(
    title,
    message,
    acceptLabel = 'Подтвердить',
    cancelLabel = 'Не менять',
    options = {},
  ) {
    if (pending) return Promise.resolve(false);
    let dialog = actions.$('#action-confirmation');
    if (!dialog) {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<dialog id="action-confirmation" class="action-confirmation" aria-labelledby="action-confirmation-title" aria-describedby="action-confirmation-message"><h3 id="action-confirmation-title"></h3><p id="action-confirmation-message"></p><div class="action-confirmation-buttons"><button type="button" class="secondary" data-confirm-cancel autofocus></button><button type="button" class="primary" data-confirm-accept></button></div></dialog>',
      );
      dialog = actions.$('#action-confirmation');
      dialog.addEventListener('click', (event) => {
        if (event.target.closest('[data-confirm-accept]')) dialog.close('accepted');
        else if (event.target.closest('[data-confirm-cancel]')) dialog.close('cancelled');
      });
      dialog.addEventListener('close', () => {
        const current = pending;
        pending = null;
        if (current?.opener?.isConnected) current.opener.focus({ preventScroll: true });
        current?.resolve(dialog.returnValue === 'accepted');
      });
    }
    dialog.querySelector('#action-confirmation-title').textContent = title;
    dialog.querySelector('#action-confirmation-message').textContent = message;
    const cancel = dialog.querySelector('[data-confirm-cancel]');
    const accept = dialog.querySelector('[data-confirm-accept]');
    const preferCancel = options.preferCancel === true;
    dialog.classList.toggle('confirmation-prefer-cancel', preferCancel);
    cancel.textContent = cancelLabel;
    accept.textContent = acceptLabel;
    cancel.className = preferCancel ? 'primary' : 'secondary';
    accept.className = preferCancel ? 'secondary' : 'primary';
    dialog.returnValue = 'cancelled';
    const promise = new Promise((resolve) => {
      pending = { resolve, opener: document.activeElement };
    });
    dialog.showModal();
    return promise;
  }
  return { confirmAction };
}
