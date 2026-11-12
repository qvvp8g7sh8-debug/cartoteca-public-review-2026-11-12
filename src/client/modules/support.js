function createSupport(state, actions) {
  let info = null,
    checking = null,
    lastCheck = 0,
    versionTimer = null,
    versionEpoch = 0,
    departed = false;
  let draft = '',
    draftScope = '',
    supportContact = '',
    serverForm = false;
  let submitting = false;
  const loadedVersion = document.querySelector('meta[name="cartoteca-build"]')?.content || '';
  function supportSettingsHtml() {
    const scope = [state.account?.id, state.account?.organizationId].join(':');
    if (scope !== draftScope) {
      draftScope = scope;
      draft = '';
      actions.resetSupportRequestScope(scope);
    }
    return actions.settingsSectionHtml(
      'Техподдержка',
      'support-settings',
      actions.supportRequestFormHtml(draft, serverForm) +
        [
          '<details class="support-extra">',
          '<summary>Частые вопросы</summary>',
          '<div class="support-help">',
          '<details>',
          '<summary>Не сохраняются изменения</summary>',
          '<p>Проверьте соединение и текст ошибки. При конфликте записи откройте её заново. При потере связи не закрывайте заполненную форму: восстановите соединение и повторите сохранение.</p>',
          '</details>',
        ].join('') +
        [
          '<details>',
          '<summary>Не приходит сообщение в Telegram</summary>',
          '<p>Проверьте, что клиент запустил бота по персональной ссылке, напоминания включены и существует будущая запись. В карточке можно нажать «Отправить сейчас».</p>',
          '</details>',
        ].join('') +
        [
          '<details>',
          '<summary>После обновления виден старый интерфейс</summary>',
          '<p>Картотека проверяет версию при возвращении во вкладку. Если появилась новая версия, сохраните изменения и нажмите «Обновить картотеку». Очищать данные браузера не нужно.</p>',
          '</details>',
          '</div>',
          '</details>',
        ].join(''),
    );
  }
  function supportReport() {
    return [
      'Картотека — техническая информация',
      'Версия интерфейса: ' + (loadedVersion || 'не определена'),
      'Версия сервера: ' + (info?.version || 'не проверена'),
      'Раздел: ' + state.currentView,
      'Экран: ' + window.innerWidth + ' × ' + window.innerHeight,
      'Связь устройства: ' + (navigator.onLine === false ? 'нет сети' : 'есть сеть'),
      'Проверено: ' + new Date().toISOString(),
    ].join('\n');
  }
  function renderSupport() {
    if (typeof document === 'undefined' || !document.defaultView) return;
    const root = actions.$('#support-settings');
    if (!root) return;
    const contact = root.querySelector('#support-contact');
    const connected = serverForm || Boolean(supportContact),
      button = root.querySelector('#support-open-telegram');
    button.disabled = !connected || submitting;
    button.textContent = submitting
      ? 'Отправляем…'
      : serverForm
        ? 'Отправить'
        : 'Продолжить в Telegram';
    root.querySelector('#support-description').readOnly = submitting;
    const contactText = serverForm
      ? ''
      : connected
        ? ''
        : !info
          ? 'Нет связи с сервером. Текст остаётся в форме — попробуйте отправить позже.'
          : 'Поддержка пока не подключена. Текст остаётся в форме; отправка сейчас недоступна.';
    contact.textContent = contactText;
    contact.hidden = connected;
    contact.className = 'form-hint';
    const privacyHelp = root.querySelector('#support-privacy-help');
    const delivery = serverForm
      ? 'Обращение сохранится в картотеке и будет передано поддержке. Ответим на почту вашей учётной записи. Повторно вводить контакты не нужно.'
      : 'Откроется чат поддержки. Проверьте текст и нажмите «Отправить» в Telegram. Ответ придёт в этот же чат.';
    const helpText =
      delivery +
      ' Не указывайте пароли, токены и персональные данные клиентов. Автоматически прикладываются только технические сведения: версия, раздел, размер экрана и состояние связи. Данные карточек не включаются.';
    const helpButton = privacyHelp.querySelector('[data-settings-help]');
    if (helpButton.dataset.helpText !== helpText) helpButton.dataset.helpText = helpText;
    if (!connected) root.querySelector('#support-chat-fallback').hidden = true;
    if (!submitting) actions.renderSupportReceipt();
  }
  function showVersionNotice() {
    if (typeof document === 'undefined' || !document.defaultView) return;
    if (!loadedVersion || !info || info.version === loadedVersion) return;
    if (actions.$('#app-version-notice')) return;
    const banner = document.createElement('div');
    banner.id = 'app-version-notice';
    banner.className = 'app-version-notice';
    banner.setAttribute('role', 'status');
    banner.innerHTML = [
      '<span>Доступна новая версия картотеки. Сохраните изменения перед обновлением.</span>',
      '<button type="button" ',
      'class="secondary" ',
      'id="support-reload">Обновить картотеку</button>',
    ].join('');
    document.querySelector('#workspace').before(banner);
  }
  async function checkAppVersion(force = false) {
    if (departed) return;
    if (checking) return checking.promise;
    if (!force && Date.now() - lastCheck < 60000) {
      renderSupport();
      return;
    }
    lastCheck = Date.now();
    const check = {
      epoch: versionEpoch,
      controller: new AbortController(),
      timer: null,
      promise: null,
    };
    const current = () => !departed && check.epoch === versionEpoch && checking === check;
    checking = check;
    check.timer = setTimeout(() => check.controller.abort(), 8000);
    check.promise = (async () => {
      try {
        const response = await fetch('/api/app/info', {
          cache: 'no-store',
          signal: check.controller.signal,
        });
        if (!response.ok) throw Error();
        const result = await response.json();
        if (!current()) return;
        if (!/^[a-f0-9]{16}$/.test(result.version)) throw Error();
        info = {
          version: result.version,
          supportTelegram: /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}$/.test(
            result.supportTelegram || '',
          )
            ? result.supportTelegram
            : '',
        };
        supportContact = info.supportTelegram;
        serverForm = result.supportForm === true;
        showVersionNotice();
      } catch {
        if (current()) info = null;
      } finally {
        clearTimeout(check.timer);
        if (current()) {
          checking = null;
          renderSupport();
        }
      }
    })();
    return check.promise;
  }
  function preparedMessage() {
    const input = actions.$('#support-description');
    const text = input?.value.trim() || '';
    if (!text || text.length > 1500) {
      input?.setAttribute('aria-invalid', 'true');
      actions.setSupportMessage(
        text
          ? 'Сократите сообщение до 1500 символов.'
          : 'Напишите, что случилось или какой у вас вопрос.',
        'error',
      );
      input?.focus();
      return null;
    }
    input.removeAttribute('aria-invalid');
    return 'Обращение в поддержку Картотеки\n\n' + text + '\n\n' + supportReport();
  }
  function reloadUpdatedApp() {
    const reason =
      state.busy || submitting
        ? 'Дождитесь завершения сохранения или отправки.'
        : draft.trim()
          ? 'Сначала отправьте обращение или очистите поле сообщения перед обновлением.'
          : actions.$('#editor')?.open
            ? 'Сначала сохраните или закройте открытую форму записи.'
            : actions.hasUnsavedSettings()
              ? 'Есть несохранённые настройки. Сохраните или отмените изменения перед обновлением.'
              : '';
    if (reason) return actions.toast(reason);
    location.reload();
  }
  function scheduleVersionCheck() {
    window.clearTimeout(versionTimer);
    versionTimer = null;
    if (!loadedVersion || departed || document.visibilityState === 'hidden') return;
    const epoch = versionEpoch;
    const timer = window.setTimeout(async () => {
      if (departed || epoch !== versionEpoch || versionTimer !== timer) return;
      versionTimer = null;
      await checkAppVersion();
      if (!departed && epoch === versionEpoch && versionTimer === null) scheduleVersionCheck();
    }, 300000);
    versionTimer = timer;
  }
  async function submitSupport() {
    if (submitting) return;
    if (!preparedMessage()) return;
    const input = actions.$('#support-description');
    const diagnostics = {
      version: loadedVersion,
      view: ['clients', 'card', 'calendar', 'services', 'settings'].includes(state.currentView)
        ? state.currentView
        : 'settings',
      width: window.innerWidth,
      height: window.innerHeight,
      online: navigator.onLine !== false,
    };
    const body = { description: input.value.trim(), diagnostics },
      scope = draftScope;
    draft = input.value;
    actions.clearSupportReceipt();
    submitting = true;
    renderSupport();
    actions.setSupportMessage('Отправляем сообщение…', 'pending');
    input.readOnly = true;
    try {
      const accepted = await actions.sendSupportRequest(body);
      if (scope !== draftScope || !accepted) return;
      draft = '';
      input.value = '';
      input.defaultValue = '';
      const activeInput = actions.$('#support-description');
      if (activeInput) {
        activeInput.value = '';
        activeInput.defaultValue = '';
      }
    } catch (e) {
      if (scope === draftScope)
        actions.setSupportMessage(
          e.name === 'TimeoutError' || e.name === 'TypeError'
            ? 'Нет подтверждения от сервера. Текст сохранён в форме; повторите отправку — дубль не создастся.'
            : e.message,
          'error',
        );
    } finally {
      submitting = false;
      input.readOnly = false;
      renderSupport();
    }
  }
  function bindSupportEvents() {
    document.addEventListener('input', (e) => {
      if (!e.target.closest('#support-form')) return;
      if (e.target.id === 'support-description') {
        draft = e.target.value;
        e.target.removeAttribute('aria-invalid');
      }
      if (e.target.id === 'support-description' && draft.trim()) actions.clearSupportReceipt();
      actions.setSupportMessage('');
      actions.$('#support-chat-fallback').hidden = true;
    });
    document.addEventListener('submit', (e) => {
      if (e.target.id !== 'support-form') return;
      e.preventDefault();
      const message = actions.$('#support-message');
      if (serverForm) {
        void submitSupport();
        return;
      }
      if (!supportContact) {
        actions.setSupportMessage(
          'Отправка пока недоступна. Текст сохранён в форме; попробуйте позже.',
          'error',
        );
        return;
      }
      const text = preparedMessage();
      if (!text) return;
      const url = new URL(supportContact);
      url.searchParams.set('text', text);
      const fallback = actions.$('#support-chat-fallback');
      fallback.href = url.href;
      fallback.hidden = false;
      try {
        window.open(url.href, '_blank', 'noopener,noreferrer');
        actions.setSupportMessage(
          'Нажмите «Отправить» в Telegram. Если чат не открылся, воспользуйтесь ссылкой ниже. Здесь ничего ещё не отправлено.',
        );
      } catch {
        actions.setSupportMessage('Браузер не открыл Telegram. Используйте ссылку ниже.', 'error');
      }
    });
    document.addEventListener(
      'toggle',
      (e) => {
        if (e.target.open && e.target.querySelector?.('#support-settings')) {
          void checkAppVersion();
          void actions.refreshSupportReceipt();
        }
      },
      true,
    );
    window.addEventListener('focus', () => {
      if (loadedVersion) void checkAppVersion();
      void actions.refreshSupportReceipt();
    });
    window.addEventListener('online', () => {
      if (loadedVersion) void checkAppVersion(true);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (loadedVersion) void checkAppVersion();
        void actions.refreshSupportReceipt();
      }
      scheduleVersionCheck();
    });
    window.addEventListener('pageshow', () => {
      departed = false;
      if (loadedVersion) void checkAppVersion();
      scheduleVersionCheck();
    });
    window.addEventListener('pagehide', () => {
      departed = true;
      versionEpoch += 1;
      window.clearTimeout(versionTimer);
      versionTimer = null;
      const previous = checking;
      checking = null;
      if (previous) {
        lastCheck = 0;
        clearTimeout(previous.timer);
        previous.timer = null;
        previous.controller.abort();
      }
    });
    if (loadedVersion) {
      void checkAppVersion();
      scheduleVersionCheck();
    }
    document.addEventListener('click', (e) => {
      if (e.target.closest('#support-reload')) {
        reloadUpdatedApp();
        return;
      }
    });
  }
  return { supportSettingsHtml, checkAppVersion, bindSupportEvents };
}
