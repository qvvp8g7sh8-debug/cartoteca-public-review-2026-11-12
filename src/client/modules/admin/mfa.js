function createAdminMfaSettings({ $, request, records }) {
  const { esc } = records;
  let busy = false,
    generation = 0;
  const root = () => $('#admin-mfa-content');
  function message(text) {
    const node = root()?.querySelector('[data-mfa-message]');
    if (node) node.textContent = text;
  }
  function codesHtml(codes) {
    return codes
      ? '<p>Сохраните резервные коды в безопасном месте. Каждый работает один раз. После закрытия они не показываются.</p><textarea readonly rows="5" aria-label="Резервные коды">' +
          esc(codes.join('\n')) +
          '</textarea>'
      : '';
  }
  function render(data, codes = null) {
    root().innerHTML =
      '<p><strong>' +
      (data.enabled ? 'Подтверждение входа включено' : 'Подтверждение входа не включено') +
      '</strong></p>' +
      (data.enabled
        ? '<p>Осталось резервных кодов: ' +
          esc(data.recoveryRemaining ?? codes?.length ?? '—') +
          '. Сброс пароля не отключает эту защиту.</p>'
        : '<p>Подключите приложение для одноразовых кодов. Защита включится после проверки кода; входы сотрудников не меняются.</p>') +
      codesHtml(codes) +
      '<form data-admin-mfa-form><fieldset><label class="field">Текущий пароль<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label>' +
      (data.enabled
        ? '<label class="field">Код приложения или резервный код<input name="code" required maxlength="64" autocomplete="one-time-code"></label><label class="field">Действие<select name="action"><option value="recovery">Заменить резервные коды</option><option value="disable">Отключить подтверждение входа</option></select></label>'
        : '<input name="action" type="hidden" value="prepare">') +
      '</fieldset><button type="submit" class="secondary">' +
      (data.enabled ? 'Выполнить' : 'Настроить подтверждение входа') +
      '</button></form><p role="status" data-mfa-message></p>';
  }
  async function load() {
    const serial = ++generation;
    try {
      const data = await request('/api/admin/security/mfa');
      if (serial === generation && root()?.isConnected) render(data);
    } catch (error) {
      message(error.message);
    }
  }
  function prepared(data) {
    root().innerHTML =
      '<p>Добавьте Картотеку в приложение-аутентификатор и введите шестизначный код. Настройка действует10минут.</p>' +
      '<img data-mfa-qr width="240" height="240" alt="QR-код подключения приложения"><label class="field">Секрет для ручного ввода<input readonly data-mfa-secret></label>' +
      '<form data-admin-mfa-form data-setup-id="' +
      esc(data.setupId) +
      '"><fieldset><input type="hidden" name="action" value="enable"><label class="field">Код из приложения<input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label></fieldset><button type="submit" class="secondary">Включить защиту</button></form><p role="status" data-mfa-message></p>';
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qr))
      throw Error('Не удалось подготовить QR-код.');
    root().querySelector('[data-mfa-qr]').src = data.qr;
    root().querySelector('[data-mfa-secret]').value = data.secret;
  }
  async function submit(form) {
    if (busy || !form.reportValidity()) return;
    const action = form.elements.action.value;
    if (
      action === 'disable' &&
      !confirm('Отключить подтверждение входа? Другие сеансы будут завершены.')
    )
      return;
    busy = true;
    const serial = ++generation,
      fieldset = form.querySelector('fieldset'),
      button = form.querySelector('[type="submit"]');
    const values = new FormData(form),
      body =
        action === 'enable'
          ? { setupId: form.dataset.setupId, code: String(values.get('code') || '') }
          : {
              password: String(values.get('password') || ''),
              ...(action === 'prepare'
                ? { requestId: (form.dataset.requestId ||= window.crypto.randomUUID()) }
                : { code: String(values.get('code') || '') }),
            };
    fieldset.disabled = true;
    button.disabled = true;
    message('Проверяем…');
    try {
      const data = await request('/api/admin/security/mfa/' + action, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (serial !== generation || !root()?.isConnected) return;
      if (action === 'prepare') prepared(data);
      else {
        render(data, data.recoveryCodes);
        message(
          data.recoveryCodes
            ? 'Защита настроена. Сохраните резервные коды.'
            : data.enabled
              ? 'Защита включена. Если коды не были получены, создайте новые кодом приложения.'
              : 'Подтверждение входа отключено.',
        );
      }
    } catch (error) {
      if (serial === generation) message(error.message);
    } finally {
      busy = false;
      if (form.isConnected) {
        fieldset.disabled = false;
        button.disabled = false;
        const password = form.elements.password;
        if (password) password.value = '';
      }
    }
  }
  function bind() {
    const details = $('#admin-mfa-settings');
    details?.addEventListener('toggle', () => {
      if (details.open && !busy) void load();
      else if (!details.open) {
        generation++;
        if (root())
          root().innerHTML =
            '<p role="status" data-mfa-message>Откройте настройки для проверки состояния.</p>';
      }
    });
    document.addEventListener('submit', (event) => {
      if (event.target.matches?.('[data-admin-mfa-form]')) {
        event.preventDefault();
        void submit(event.target);
      }
    });
    window.addEventListener('pagehide', () => {
      generation++;
      if (root()) root().textContent = '';
    });
  }
  return { bind };
}
