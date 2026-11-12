(() => {
  // Authentication UI. Keep document replacement after login for embedded browsers.
  const $ = (selector) => document.querySelector(selector);
  const privacyVersion = $('meta[name="cartoteca-privacy-version"]')?.content;
  let legacySetup = false,
    multiUser = false,
    mode = 'login',
    invitationInfo = null,
    invitationContext = null,
    acceptedOrganizationId = null,
    knownAccountContext = null,
    accountContextChanged = false,
    accountAccessBusy = false,
    accountAccessGeneration = 0;
  const hash = new URLSearchParams(location.hash.slice(1));
  const forceLogin = new URLSearchParams(location.search).get('switch-account') === '1';
  const resetToken = hash.get('reset'),
    verificationToken = hash.get('verify-email'),
    invitationToken = hash.get('invite'),
    emailChangeToken = hash.get('confirm-email-change');
  // Keep an unaccepted invitation in the fragment so a reload restores its form.
  if (resetToken || verificationToken || emailChangeToken)
    history.replaceState(null, '', location.pathname);
  // Keep the renderer alive after authentication. Some embedded browsers can
  // stall while committing a top-level reload immediately after Set-Cookie.
  // Fetching the protected shell and replacing the document avoids that fragile
  // navigation while still letting the browser parse the normal app scripts.
  async function openCabinet(globalAdmin = false) {
    const page = globalAdmin ? 'admin.html' : 'index.html';
    const response = await fetch(`/${page}?signed-in=${Date.now()}`, { cache: 'no-store' });
    if (typeof document === 'undefined' || !document.defaultView) return;
    if (!response.ok) throw Error('Не удалось открыть кабинет после входа.');
    const html = await response.text();
    if (typeof document === 'undefined' || !document.defaultView) return;
    const expectedTitle = globalAdmin
      ? '<title>Управление · Картотека</title>'
      : '<title>Картотека · кабинет</title>';
    if (!html.includes(expectedTitle))
      throw Error('Сессия создана, но нужный раздел пока недоступен. Повторите вход.');
    document.open();
    document.write(html);
    document.close();
  }
  async function post(route, body, accountContext = null) {
    if (accountContext && accountContextChanged) throw changedAccountError();
    let timeout;
    const response = await Promise.race([
      fetch(route, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          ...(accountContext
            ? {
                'X-Cartoteca-Account-Id': accountContext.id,
                'X-Cartoteca-Organization-Id': accountContext.organizationId || '',
              }
            : {}),
        },
        body: JSON.stringify(body),
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error('Сервер слишком долго отвечает. Попробуйте ещё раз.')),
          15000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    const result = await response.json();
    if (response.status === 428 || result.code === 'AUTH_CONTEXT_CHANGED') {
      accountContextChanged = true;
      location.replace('/');
      throw changedAccountError(result.error);
    }
    if (!response.ok)
      throw Object.assign(Error(result.error || 'Не удалось выполнить операцию.'), {
        code: result.code,
        status: response.status,
      });
    return result;
  }
  function changedAccountError(message) {
    return Object.assign(Error(message || 'Учётная запись изменилась. Войдите снова.'), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      outcomeUnknown: false,
    });
  }
  function rememberAccountContext(session) {
    knownAccountContext = session.user?.id
      ? {
          id: session.user.id,
          organizationId: session.organizationId ?? session.user.organizationId ?? null,
        }
      : null;
  }
  function setPrivacyRequired(required) {
    $('#auth-privacy-field').hidden = !required;
    $('#auth-privacy-consent').required = required;
    if (!required) $('#auth-privacy-consent').checked = false;
  }
  function invitationNeedsSetup() {
    return typeof invitationInfo?.passwordSetupRequired === 'boolean'
      ? invitationInfo.passwordSetupRequired
      : !invitationInfo?.existingAccount;
  }
  function setPasswordLabel(text) {
    const label = $('#auth-password-label');
    if (label) label.textContent = text;
  }
  function setAccountAccessBusy(busy) {
    accountAccessBusy = busy;
    $('#account-switch-account').disabled = busy;
    $('#auth-retry').disabled = busy;
  }
  function showAccountAccessProblem(session) {
    if (!$('#account-access-problem'))
      throw Error('Обновите страницу, чтобы проверить доступ к кабинету.');
    accountAccessGeneration++;
    mode = 'access-problem';
    $('#auth-form').hidden = true;
    $('#auth-switch').hidden = true;
    $('#forgot-open').hidden = true;
    $('#forgot-form').hidden = true;
    $('#account-access-problem').hidden = false;
    $('#account-access-message').textContent =
      session.organizationAccess === 'conflict'
        ? 'Учётная запись связана с несколькими организациями. Для каждой организации нужна отдельная учётная запись. Обратитесь в поддержку или войдите с другой почтой.'
        : 'У этой учётной записи нет доступной организации. Попросите владельца проверить доступ или войдите с другой почтой.';
    $('#account-access-error').textContent = '';
    $('#auth-password').value = '';
    $('#auth-repeat').value = '';
    $('#extra-message').textContent = '';
    $('#auth-title').textContent = 'Кабинет недоступен';
    $('#auth-description').textContent = 'Вход выполнен, но доступ к организации требует проверки.';
    $('#auth-retry').hidden = false;
    setAccountAccessBusy(false);
    $('#account-switch-account').focus();
  }
  async function continueSession(session) {
    rememberAccountContext(session);
    if (session.user?.globalAdmin) return openCabinet(true);
    if (multiUser && !(session.organizationId ?? session.user?.organizationId))
      return showAccountAccessProblem(session);
    return openCabinet();
  }
  function setMode(next) {
    mode = next;
    if ($('#auth-mfa-field')) {
      $('#auth-mfa-field').hidden = true;
      $('#auth-mfa-code').required = false;
      $('#auth-mfa-code').value = '';
    }
    document
      .querySelectorAll('[data-auth-mode]')
      .forEach((button) => button.classList.toggle('active', button.dataset.authMode === mode));
    document
      .querySelectorAll('.registration-field')
      .forEach((field) => (field.hidden = mode !== 'register'));
    $('#auth-name').required = mode === 'register';
    $('#auth-name').readOnly = false;
    $('#auth-name').autocomplete = 'name';
    $('#auth-email').readOnly = false;
    $('#auth-organization').required = mode === 'register';
    $('#auth-city').required = mode === 'register';
    $('#auth-phone').required = mode === 'register';
    setPrivacyRequired(mode === 'register');
    $('#auth-repeat-field').hidden = mode !== 'register' && !legacySetup;
    $('#auth-repeat').required = mode === 'register' || legacySetup;
    $('#auth-password').minLength = mode === 'register' || legacySetup ? 12 : 1;
    $('#auth-password').autocomplete =
      mode === 'register' || legacySetup ? 'new-password' : 'current-password';
    setPasswordLabel('Пароль');
    $('#auth-submit').textContent =
      mode === 'register' || legacySetup ? 'Создать профиль' : 'Войти';
    $('#auth-title').textContent =
      mode === 'register'
        ? 'Создание аккаунта'
        : legacySetup
          ? 'Создайте вход в свой кабинет'
          : 'Вход в картотеку';
    $('#auth-description').textContent =
      mode === 'register'
        ? 'Создайте бесплатный аккаунт для работы с клиентами. Подтвердите почту перед первым входом.'
        : legacySetup
          ? 'Укажите почту и придумайте отдельный пароль для картотеки — от 12 символов.'
          : 'Введите почту и пароль.';
    $('#auth-help').textContent =
      mode === 'register'
        ? 'Бесплатно: до 10 клиентов и 50 фотографий, публичная запись и уведомления.'
        : 'Почта используется как логин. Вводите пароль от картотеки.';
    $('#forgot-open').hidden = mode === 'register' || legacySetup;
  }
  document
    .querySelectorAll('[data-auth-mode]')
    .forEach((button) => button.addEventListener('click', () => setMode(button.dataset.authMode)));
  $('#forgot-open').onclick = () => {
    $('#forgot-form').hidden = !$('#forgot-form').hidden;
    $('#forgot-email').value = $('#auth-email').value;
  };
  function extraForm(id, action) {
    $(id).addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button');
      button.disabled = true;
      $('#extra-message').textContent = '';
      try {
        await action();
      } catch (error) {
        $('#extra-message').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
  extraForm('#forgot-form', async () => {
    const result = await post('/api/auth/forgot', { email: $('#forgot-email').value });
    $('#extra-message').textContent =
      result.message +
      (!multiUser && result.resetUrl ? ' Локальная ссылка: ' + result.resetUrl : '');
  });
  extraForm('#verify-form', async () => {
    await post('/api/auth/verify', { code: $('#verify-code').value });
    location.replace('/');
  });
  extraForm('#email-change-form', async () => {
    await post('/api/auth/confirm-email-change', { token: emailChangeToken });
    $('#email-change-form').hidden = true;
    setMode('login');
    $('#auth-form').hidden = false;
    $('#auth-switch').hidden = true;
    $('#auth-title').textContent = 'Адрес для входа изменён';
    $('#auth-description').textContent =
      'Войдите с новой почтой и прежним паролем. Прежние сеансы завершены.';
    $('#extra-message').textContent = 'Новая почта подтверждена.';
    $('#auth-email').focus();
  });
  extraForm('#reset-form', async () => {
    if ($('#reset-password').value !== $('#reset-repeat').value)
      throw Error('Пароли не совпадают.');
    await post('/api/auth/reset', {
      token: resetToken,
      password: $('#reset-password').value,
      code: $('#reset-code').value,
    });
    $('#reset-form').hidden = true;
    $('#auth-form').hidden = false;
    $('#extra-message').textContent = 'Пароль изменён. Войдите с новым паролем.';
  });
  $('#show-password').addEventListener('change', (event) => {
    for (const selector of ['#auth-password', '#auth-repeat'])
      $(selector).type = event.target.checked ? 'text' : 'password';
  });
  $('#account-switch-account')?.addEventListener('click', async () => {
    if (accountAccessBusy) return;
    const generation = ++accountAccessGeneration;
    $('#account-access-error').textContent = '';
    setAccountAccessBusy(true);
    try {
      await post('/api/auth/logout', {}, knownAccountContext);
      if (generation !== accountAccessGeneration) return;
      acceptedOrganizationId = null;
      knownAccountContext = null;
      $('#account-access-problem').hidden = true;
      $('#auth-form').reset();
      $('#auth-form').hidden = false;
      $('#auth-switch').hidden = !multiUser;
      $('#auth-retry').hidden = true;
      $('#extra-message').textContent = '';
      setMode('login');
      $('#auth-email').focus();
    } catch (error) {
      if (generation === accountAccessGeneration)
        $('#account-access-error').textContent = error.message;
    } finally {
      if (generation === accountAccessGeneration && $('#account-access-problem'))
        setAccountAccessBusy(false);
    }
  });
  async function initialize() {
    $('#auth-retry').hidden = true;
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      if (!response.ok) throw Error();
      const state = await response.json();
      rememberAccountContext(state);
      multiUser = Boolean(state.multiUser);
      if (
        state.user &&
        !forceLogin &&
        !resetToken &&
        !verificationToken &&
        !invitationToken &&
        !emailChangeToken
      ) {
        await continueSession(state);
        return;
      }
      const accessProblem = $('#account-access-problem');
      if (accessProblem) accessProblem.hidden = true;
      legacySetup = !multiUser && !state.configured;
      $('#auth-switch').hidden = !multiUser;
      $('#auth-form').hidden = false;
      if (emailChangeToken) {
        $('#auth-form').hidden = true;
        $('#auth-switch').hidden = true;
        $('#forgot-open').hidden = true;
        $('#auth-title').textContent = 'Подтверждение новой почты';
        $('#auth-description').textContent =
          'Смена адреса подготовлена поддержкой по вашему обращению.';
        $('#email-change-form').hidden = false;
        return;
      }
      if (verificationToken) {
        $('#auth-form').hidden = true;
        $('#auth-switch').hidden = true;
        $('#auth-title').textContent = 'Подтверждаем почту';
        await post('/api/auth/verify-email', { token: verificationToken });
        $('#auth-title').textContent = 'Почта подтверждена';
        $('#auth-description').textContent = 'Теперь можно войти в картотеку.';
        $('#auth-form').hidden = false;
        $('#auth-switch').hidden = false;
      }
      if (resetToken) {
        $('#auth-form').hidden = true;
        $('#auth-switch').hidden = true;
        $('#reset-form').hidden = false;
        $('#auth-title').textContent = 'Новый пароль';
        $('#auth-description').textContent = 'Установите новый пароль картотеки.';
        return;
      }
      if (invitationToken) {
        $('#auth-form').hidden = true;
        $('#auth-switch').hidden = true;
        invitationInfo = await post('/api/auth/invitations/info', { token: invitationToken });
        const needsSetup = invitationNeedsSetup();
        const nextContext = `${invitationInfo.email}\n${needsSetup}`;
        if (nextContext !== invitationContext) {
          for (const selector of ['#auth-name', '#auth-password', '#auth-repeat'])
            $(selector).value = '';
          $('#auth-privacy-consent').checked = false;
          $('#auth-error').textContent = '';
          invitationContext = nextContext;
        }
        mode = 'invite';
        $('#auth-switch').hidden = true;
        $('#auth-email').value = invitationInfo.email;
        $('#auth-email').readOnly = true;
        if (!needsSetup) $('#auth-name').value = '';
        $('#auth-name').closest('label').hidden = !needsSetup;
        $('#auth-name').required = needsSetup;
        $('#auth-name').autocomplete = 'off';
        setPrivacyRequired(needsSetup);
        $('#auth-repeat-field').hidden = !needsSetup;
        $('#auth-repeat').required = needsSetup;
        $('#auth-password').minLength = needsSetup ? 12 : 1;
        $('#auth-password').autocomplete = needsSetup ? 'new-password' : 'current-password';
        setPasswordLabel(needsSetup ? 'Придумайте пароль' : 'Пароль');
        $('#forgot-open').hidden = true;
        $('#auth-help').textContent = needsSetup
          ? 'Укажите своё имя, придумайте собственный пароль от 12 символов и повторите его.'
          : 'Введите прежний пароль от Картотеки. Он не будет изменён.';
        $('#auth-submit').textContent = 'Принять приглашение';
        $('#auth-title').textContent = 'Принять приглашение';
        $('#auth-description').textContent =
          `Организация: ${invitationInfo.organizationName}. Ваша роль: ${invitationInfo.roleName}.`;
        $('#extra-message').textContent = '';
        if (state.user && state.user.email !== invitationInfo.email)
          $('#extra-message').textContent =
            `Сейчас выполнен вход как ${state.user.email}. Приглашение предназначено для ${invitationInfo.email}. ` +
            (needsSetup
              ? 'Создайте свой пароль для приглашённого аккаунта. Пароль текущего аккаунта не нужен.'
              : 'Введите пароль получателя, а не текущего аккаунта.');
        $('#auth-form').hidden = false;
      } else setMode('login');
      (invitationToken ? $('#auth-password') : $('#auth-email')).focus();
    } catch (error) {
      $('#auth-description').textContent = error.message || 'Не удалось подключиться к картотеке.';
      $('#auth-retry').hidden = false;
    }
  }
  $('#auth-retry').addEventListener('click', initialize);
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#auth-error').textContent = '';
    if (mode === 'invite' && invitationNeedsSetup() && !$('#auth-name').value.trim()) {
      $('#auth-error').textContent = 'Укажите своё имя для приглашённого аккаунта.';
      $('#auth-name').focus();
      return;
    }
    if (
      (mode === 'register' || (mode === 'invite' && invitationNeedsSetup())) &&
      !$('#auth-privacy-consent').checked
    ) {
      $('#auth-error').textContent = 'Дайте согласие на обработку персональных данных.';
      return;
    }
    if (
      (mode === 'register' || legacySetup || (mode === 'invite' && invitationNeedsSetup())) &&
      $('#auth-password').value !== $('#auth-repeat').value
    ) {
      $('#auth-error').textContent = 'Пароли не совпадают.';
      return;
    }
    const submit = $('#auth-submit');
    const originalLabel = submit.textContent;
    submit.disabled = true;
    submit.textContent = mode === 'login' && !legacySetup ? 'Входим…' : 'Подождите…';
    try {
      if (mode === 'register') {
        const result = await post('/api/auth/register', {
          email: $('#auth-email').value.trim(),
          password: $('#auth-password').value,
          displayName: $('#auth-name').value,
          organizationName: $('#auth-organization').value,
          city: $('#auth-city').value,
          phone: $('#auth-phone').value,
          privacyConsent: $('#auth-privacy-consent').checked,
          privacyConsentVersion: privacyVersion,
        });
        $('#auth-form').reset();
        $('#extra-message').textContent = result.message;
        setMode('login');
      } else if (mode === 'invite') {
        const accepted = await post('/api/auth/invitations/accept', {
          token: invitationToken,
          privacyConsent: $('#auth-privacy-consent').checked,
          privacyConsentVersion: privacyVersion,
          email: invitationInfo.email,
          password: $('#auth-password').value,
          ...(invitationNeedsSetup()
            ? {
                passwordConfirmation: $('#auth-repeat').value,
                displayName: $('#auth-name').value.trim(),
              }
            : {}),
        });
        history.replaceState(null, '', location.pathname);
        acceptedOrganizationId = accepted.organizationId;
        $('#extra-message').textContent = 'Приглашение принято. Теперь войдите.';
        setMode('login');
        $('#auth-switch').hidden = true;
        $('#auth-email').readOnly = true;
        $('#auth-email').value = invitationInfo.email;
        $('#auth-name').value = '';
        $('#auth-repeat').value = '';
        $('#auth-password').value = '';
        $('#auth-password').focus();
      } else {
        const result = await post(legacySetup ? '/api/auth/setup' : '/api/auth/login', {
          email: $('#auth-email').value.trim(),
          password: $('#auth-password').value,
          ...(multiUser && $('#auth-mfa-field') && !$('#auth-mfa-field').hidden
            ? { oneTimeCode: $('#auth-mfa-code').value }
            : {}),
        });
        if (typeof document === 'undefined' || !document.defaultView) return;
        $('#auth-form').reset();
        if (result.requiresMfa) {
          $('#auth-form').hidden = true;
          $('#verify-form').hidden = false;
          $('#auth-description').textContent = 'Подтвердите вход кодом из приложения.';
          $('#verify-code').focus();
        } else {
          accountContextChanged = false;
          rememberAccountContext(result);
          if (acceptedOrganizationId) {
            await post(
              '/api/auth/select-organization',
              { organizationId: acceptedOrganizationId },
              {
                id: result.user.id,
                organizationId: result.organizationId ?? result.user.organizationId ?? null,
              },
            );
            await openCabinet(Boolean(result.user?.globalAdmin));
          } else await continueSession(result);
        }
      }
    } catch (error) {
      if (typeof document !== 'undefined' && document.defaultView) {
        if (
          multiUser &&
          ['MFA_REQUIRED', 'MFA_INVALID'].includes(error.code) &&
          $('#auth-mfa-field')
        ) {
          $('#auth-mfa-field').hidden = false;
          $('#auth-mfa-code').required = true;
          $('#auth-mfa-code').value = '';
          $('#auth-mfa-code').focus();
        }
        const message = $('#auth-error');
        if (message)
          message.textContent =
            error.message === 'Failed to fetch'
              ? 'Нет связи с сервером. Попробуйте ещё раз.'
              : error.message;
      }
    } finally {
      submit.disabled = false;
      submit.textContent = mode === 'login' ? 'Войти' : originalLabel;
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  initialize();
})();
