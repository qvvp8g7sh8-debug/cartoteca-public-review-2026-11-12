function createClientContact(state, actions) {
  let dialog = null,
    returnFocus = null,
    dialogScope = '';
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const dismiss = () => {
    if (dialog?.open) dialog.close();
  };
  function contactNumber(raw) {
    const text = actions.normalizePatientPhoneText(raw);
    if (!text) return '';
    let number = text.replace(/\D/g, '');
    if (text.startsWith('+7') && !/^7\d{10}$/.test(number)) return '';
    if (!text.startsWith('+')) {
      if (/^8\d{10}$/.test(number)) number = '7' + number.slice(1);
      if (/^9\d{9}$/.test(number)) number = '7' + number;
    }
    return /^[1-9]\d{7,14}$/.test(number) ? number : '';
  }
  function deviceCanCall() {
    return (
      /Android|iPhone|iPad|iPod|Windows Phone/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
      (navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches) ||
      window.matchMedia('(max-width: 700px)').matches
    );
  }
  function clientContactActionsHtml(patient, { labels = false } = {}) {
    const number = contactNumber(patient.phone);
    const icon = (name, fallback) =>
      `<span class="client-contact-icon" aria-hidden="true"><img src="/icons/contact-${name}-gloss-v1.png" width="96" height="96" alt="" decoding="async" draggable="false">${fallback}</span>`;
    const messageIcon = icon(
      'message',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z"/></svg>',
    );
    const callIcon = icon(
      'call',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 3 4 5-2 3c2 3 3 4 6 6l3-2 5 4c-1 3-4 4-7 2C8 18 4 14 2 8c-1-3 0-4 3-5Z"/></svg>',
    );
    return (
      '<span class="client-contact-actions">' +
      `<button type="button" class="client-contact-action" data-client-message="${actions.esc(patient.id)}" title="${number ? 'Написать в личный чат' : 'Укажите телефон клиента'}" aria-label="Написать клиенту" ${number ? '' : 'disabled'}>${messageIcon}${labels ? '<span class="client-contact-label">Написать</span>' : ''}</button>` +
      (deviceCanCall()
        ? number
          ? `<a class="client-contact-action" href="tel:+${number}" title="Позвонить клиенту" aria-label="Позвонить клиенту">${callIcon}${labels ? '<span class="client-contact-label">Позвонить</span>' : ''}</a>`
          : `<button type="button" class="client-contact-action" disabled title="Укажите телефон клиента" aria-label="Позвонить клиенту">${callIcon}${labels ? '<span class="client-contact-label">Позвонить</span>' : ''}</button>`
        : '') +
      '</span>'
    );
  }
  function bindClientContactEvents() {
    const updateIcon = (event) => {
      const image = event.target;
      if (!image?.matches?.('.client-contact-icon > img')) return;
      image.parentElement.classList.toggle(
        'is-image-ready',
        event.type === 'load' && image.naturalWidth > 0,
      );
    };
    document.addEventListener('load', updateIcon, true);
    document.addEventListener('error', updateIcon, true);
    window.addEventListener('pagehide', dismiss);
    document.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('#logout-account,[data-view],[data-patient]')) dismiss();
      },
      true,
    );
    document.addEventListener('click', (event) => {
      const row = event.target.closest('.client-list-row');
      if (row && !state.busy && !event.target.closest('button,a,input,summary')) {
        row.querySelector('[data-patient]')?.click();
        return;
      }
      const button = event.target.closest('[data-client-message]');
      if (!button || button.disabled || state.busy) return;
      const patientId = button.dataset.clientMessage,
        editor = button.closest('#editor'),
        mode = state.editorMode;
      if (
        editor &&
        mode?.kind === 'appointmentActions' &&
        (!editor.open || mode.account !== state.account || mode.patientId !== patientId)
      )
        return;
      const patient =
        (editor && mode?.kind === 'appointmentActions' ? mode.inspectorPatient : null) ||
        (editor ? state.data : actions.clientRecords()).find((p) => p.id === patientId);
      if (!patient || patient.id !== patientId) return;
      const number = contactNumber(patient.phone);
      if (!number) return;
      if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.id = 'client-contact-dialog';
        dialog.className = 'client-contact-dialog';
        document.body.append(dialog);
        dialog.addEventListener('click', (e) => {
          if (dialogScope !== scope()) {
            e.preventDefault();
            dismiss();
            return;
          }
          if (e.target.closest('[data-close-client-contact]')) dialog.close();
        });
        dialog.addEventListener('close', () => {
          dialog.replaceChildren();
          if (returnFocus?.isConnected) returnFocus.focus();
          returnFocus = null;
          dialogScope = '';
        });
      }
      returnFocus = button;
      dialogScope = scope();
      dialog.setAttribute('aria-labelledby', 'client-contact-title');
      dialog.innerHTML =
        '<div class="client-contact-heading"><h2 id="client-contact-title">Написать клиенту</h2><button type="button" data-close-client-contact aria-label="Закрыть">×</button></div>' +
        `<p>${actions.esc(patient.name || 'Клиент')}</p><p class="form-hint">Откроется личный чат в вашем мессенджере. Сообщение не отправляется автоматически и не связано с ботом.</p>` +
        `<div class="client-contact-options"><a class="secondary" href="https://t.me/+${number}" target="_blank" rel="noopener noreferrer">Telegram</a>` +
        `<a class="secondary" href="https://wa.me/${number}" target="_blank" rel="noopener noreferrer">WhatsApp</a></div>` +
        '<p class="form-hint">Доступность чата зависит от регистрации и настроек приватности клиента. Для MAX пока нужна личная ссылка профиля — подключение к боту её не заменяет.</p>';
      dialog.showModal();
    });
  }
  return { clientContactActionsHtml, bindClientContactEvents };
}
