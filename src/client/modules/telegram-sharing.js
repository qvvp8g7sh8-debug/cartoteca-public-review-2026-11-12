function createTelegramSharing(state, actions) {
  const fallbackText =
    'Здравствуйте!\n\nПожалуйста, подключите уведомления о записи в Telegram, чтобы получать напоминания о приёме и подтверждать, что придёте.\n\nОткройте ссылку и нажмите «Запустить»:';
  let sharing = false,
    returnFocus = null,
    current = null,
    guardTimer;
  const accountKey = () => [state.account?.id, state.account?.organizationId].join(':');
  function validInvitation(invitation) {
    try {
      const url = new URL(invitation.url);
      return (
        invitation.accountKey === accountKey() &&
        Boolean(state.data?.some((p) => p.id === invitation.patientId)) &&
        state.selectedId === invitation.patientId &&
        url.protocol === 'https:' &&
        url.hostname === 't.me' &&
        !url.username &&
        !url.password &&
        /^\/[A-Za-z0-9_]+$/.test(url.pathname) &&
        Boolean(url.searchParams.get('start')) &&
        invitation.expiresAt > Date.now()
      );
    } catch {
      return false;
    }
  }
  function contactPhone(value) {
    const raw = actions.normalizePatientPhoneText(value);
    if (!raw) return '';
    let digits = raw.replace(/\D/g, '');
    if (raw.startsWith('+7') && !/^7\d{10}$/.test(digits)) return '';
    if (!raw.startsWith('+') && digits.startsWith('00')) digits = digits.slice(2);
    else if (!raw.startsWith('+') && /^8\d{10}$/.test(digits)) digits = '7' + digits.slice(1);
    else if (!raw.startsWith('+') && !/^7\d{10}$/.test(digits)) return '';
    return /^[1-9]\d{6,14}$/.test(digits) ? digits : '';
  }
  function currentIsValid() {
    return (
      current &&
      validInvitation(current.invitation) &&
      state.data.find((p) => p.id === current.invitation.patientId)?.phone === current.phone
    );
  }
  function nativeShareAvailable(data) {
    try {
      return (
        window.isSecureContext === true &&
        typeof navigator.share === 'function' &&
        (!navigator.canShare || navigator.canShare(data))
      );
    } catch {
      return false;
    }
  }
  function showTelegramShareOptions(invitation) {
    if (!validInvitation(invitation)) {
      dismissTelegramShare();
      actions.toast('Ссылка недоступна или устарела. Откройте клиента и создайте новую ссылку.');
      return;
    }
    const invitationText =
      typeof invitation.invitationText === 'string' && invitation.invitationText.trim()
        ? invitation.invitationText
        : fallbackText;
    const patient = state.data.find((p) => p.id === invitation.patientId),
      phone = contactPhone(patient.phone),
      message =
        invitationText +
        '\n' +
        invitation.url +
        '\n\nСсылка действует 24 часа и предназначена только для вас.';
    let dialog = actions.$('#telegram-share-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'telegram-share-dialog';
      dialog.setAttribute('aria-labelledby', 'telegram-share-title');
      document.body.append(dialog);
      dialog.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (e.target.closest('[data-close-telegram-share]')) {
          dismissTelegramShare();
          return;
        }
        if (
          !e.target.closest(
            '[data-share-channel],[data-copy-telegram-message],[data-copy-telegram-link],[data-native-telegram-share]',
          )
        )
          return;
        if (!currentIsValid()) {
          e.preventDefault();
          dismissTelegramShare();
          actions.toast('Клиент или ссылка изменились. Откройте отправку заново.');
          return;
        }
        if (e.target.closest('[data-native-telegram-share]')) {
          nativeShare();
          return;
        }
        if (e.target.closest('[data-copy-telegram-link]')) {
          const input = dialog.querySelector('[data-telegram-invitation-url]'),
            saved = current;
          try {
            await navigator.clipboard.writeText(saved.invitation.url);
            if (current === saved && currentIsValid()) actions.toast('Ссылка скопирована');
          } catch {
            if (current === saved && currentIsValid()) {
              input.closest('details').open = true;
              input.focus();
              input.select();
              actions.toast('Ссылка выделена — скопируйте её');
            }
          }
          return;
        }
        if (e.target.closest('[data-copy-telegram-message]')) {
          const input = dialog.querySelector('textarea'),
            saved = current;
          try {
            await navigator.clipboard.writeText(input.value);
            if (current === saved && currentIsValid())
              actions.toast('Сообщение скопировано — вставьте его в чат клиента');
          } catch {
            if (current === saved && currentIsValid()) {
              input.closest('details').open = true;
              input.focus();
              input.select();
              actions.toast('Сообщение выделено — скопируйте его');
            }
          }
        }
      });
      dialog.addEventListener('close', () => {
        clearTimeout(guardTimer);
        current = null;
        dialog.replaceChildren();
        if (returnFocus?.isConnected) returnFocus.focus();
        returnFocus = null;
      });
    }
    if (!dialog.open)
      returnFocus =
        document.activeElement.closest('.telegram-service-menu')?.querySelector('summary') ||
        document.activeElement;
    for (const menu of document.querySelectorAll('.telegram-service-menu[open]')) menu.open = false;
    current = { invitation, phone: patient.phone, message };
    const shareUrl =
      'https://t.me/share/url?url=' +
      encodeURIComponent(invitation.url) +
      '&text=' +
      encodeURIComponent(
        invitationText + '\n\nСсылка действует 24 часа и предназначена только для вас.',
      );
    const telegramUrl = phone
      ? 'https://t.me/+' + phone + '?text=' + encodeURIComponent(message)
      : shareUrl;
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const smsUrl = phone
      ? 'sms:+' + phone + (ios ? '&' : '?') + 'body=' + encodeURIComponent(message)
      : '';
    const channel = (name, url, style = 'secondary') =>
      url
        ? '<a class="' +
          style +
          '" data-share-channel="' +
          name +
          '" href="' +
          actions.esc(url) +
          '" ' +
          (name === 'sms' ? '' : 'target="_blank" rel="noopener noreferrer"') +
          '>' +
          { telegram: 'Telegram', whatsapp: 'WhatsApp', sms: 'СМС' }[name] +
          '</a>'
        : '<button class="secondary" type="button" disabled title="Укажите номер в международном формате">' +
          { whatsapp: 'WhatsApp', sms: 'СМС' }[name] +
          '</button>';
    const qr =
      typeof invitation.qrDataUrl === 'string' &&
      /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(invitation.qrDataUrl)
        ? '<details class="telegram-share-qr"><summary>Показать QR-код клиенту</summary><img src="' +
          invitation.qrDataUrl +
          [
            '" ',
            'width="220" ',
            'height="220" ',
            'alt="Персональная ссылка подключения Telegram">',
            '<p class="form-hint">Попросите клиента отсканировать код и запустить бота.</p>',
            '</details>',
          ].join('')
        : '';
    const others = nativeShareAvailable({ title: 'Подключение уведомлений', text: message })
      ? '<button class="secondary" type="button" data-native-telegram-share>Другие приложения</button>'
      : '';
    dialog.innerHTML =
      [
        '<div class="dialog-heading">',
        '<h2 id="telegram-share-title">Отправить приглашение</h2>',
        '<button class="icon-btn" ',
        'type="button" data-close-telegram-share aria-label="Закрыть">×</button>',
        '</div>',
        '<div class="telegram-share-recipient">',
        '<strong>',
      ].join('') +
      actions.esc(patient.name || 'Имя не указано') +
      '</strong><span>' +
      actions.esc(patient.phone || 'Телефон не указан') +
      '</span></div><p class="form-hint">Откройте чат, проверьте получателя и нажмите «Отправить» в приложении.</p><div class="telegram-share-actions">' +
      channel('telegram', telegramUrl, 'primary') +
      channel(
        'whatsapp',
        phone ? 'https://wa.me/' + phone + '?text=' + encodeURIComponent(message) : '',
      ) +
      channel('sms', smsUrl) +
      '</div>' +
      (!phone
        ? '<p class="form-hint">Для WhatsApp и СМС укажите полный номер с кодом страны. В Telegram можно выбрать клиента из контактов.</p>'
        : '') +
      '<div class="telegram-share-secondary"><button class="secondary" type="button" data-copy-telegram-link>Копировать ссылку</button>' +
      others +
      [
        '<button class="text-btn" ',
        'type="button" data-copy-telegram-message>Копировать сообщение</button>',
        '</div>',
        '<details class="telegram-share-link">',
        '<summary>Персональная ссылка · действует 24 часа</summary>',
        '<label class="field">Ссылка подключения<input data-telegram-invitation-url readonly value="',
      ].join('') +
      actions.esc(invitation.url) +
      '"></label></details><details class="telegram-share-message"><summary>Текст сообщения</summary><label class="field">Сообщение для клиента<textarea readonly>' +
      actions.esc(message) +
      '</textarea></label></details>' +
      qr +
      [
        '<details class="telegram-share-help">',
        '<summary>Если чат или сообщение не открылись</summary>',
        '<p class="form-hint">Telegram может скрывать клиента от поиска по номеру. Выберите его вручную. В некоторых приложениях текст нужно вставить самостоятельно.</p>',
        '<a class="secondary" ',
        'data-share-channel="telegram-choice" ',
        'href="',
      ].join('') +
      actions.esc(shareUrl) +
      [
        '" ',
        'target="_blank" ',
        'rel="noopener noreferrer">Выбрать получателя в Telegram</a>',
        '<p class="form-hint">СМС открывает приложение сообщений. На компьютере нужен связанный телефон; отправка оплачивается по тарифу оператора. Если текст не подставился, нажмите «Копировать сообщение».</p>',
        '<a class="text-btn" ',
        'href="https://web.telegram.org/" ',
        'target="_blank" ',
        'rel="noopener noreferrer">Telegram Web</a>',
        '<a class="text-btn" ',
        'href="https://desktop.telegram.org/" ',
        'target="_blank" ',
        'rel="noopener noreferrer">Установить Telegram</a>',
        '</details>',
      ].join('');
    if (!dialog.open) dialog.showModal();
    clearTimeout(guardTimer);
    guardTimer = setTimeout(guardOpenDialog, 250);
  }
  function guardOpenDialog() {
    if (!currentIsValid()) {
      dismissTelegramShare();
      return;
    }
    guardTimer = setTimeout(guardOpenDialog, 250);
  }
  function nativeShare() {
    if (sharing || !currentIsValid()) return;
    const saved = current,
      data = { title: 'Подключение уведомлений', text: saved.message };
    if (!nativeShareAvailable(data)) {
      actions.toast('Используйте Telegram, WhatsApp, СМС или копирование сообщения');
      return;
    }
    // Invoke immediately during the click: awaiting a request first loses user activation.
    sharing = true;
    try {
      Promise.resolve(navigator.share(data))
        .catch((error) => {
          if (error.name !== 'AbortError' && current === saved && currentIsValid())
            actions.toast('Не удалось открыть меню. Выберите способ отправки ниже.');
        })
        .finally(() => {
          sharing = false;
        });
    } catch {
      sharing = false;
      if (current === saved && currentIsValid())
        actions.toast('Не удалось открыть меню. Выберите способ отправки ниже.');
    }
  }
  function shareTelegramInvitation(invitation) {
    showTelegramShareOptions(invitation);
  }
  function dismissTelegramShare() {
    clearTimeout(guardTimer);
    const dialog = actions.$('#telegram-share-dialog');
    if (dialog?.open) dialog.close();
    current = null;
  }
  function bindTelegramSharingEvents() {
    window.addEventListener('pagehide', dismissTelegramShare);
    document.addEventListener(
      'click',
      (e) => {
        if (e.target.closest('#logout-account,[data-view],[data-patient]')) dismissTelegramShare();
      },
      true,
    );
  }
  return { shareTelegramInvitation, showTelegramShareOptions, bindTelegramSharingEvents };
}
