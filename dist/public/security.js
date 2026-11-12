// Generated from src/client/modules/auth/legacy-security.js. Edit the source file.
(() => {
  // Compatibility UI for the isolated legacy server only.
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const names = {
    account_created: 'Создан кабинет',
    password_accepted: 'Введён верный пароль',
    login_verified: 'Подтверждён вход',
    mfa_enabled: 'Включено подтверждение входа',
    mfa_disabled: 'Отключено подтверждение входа',
    sessions_revoked: 'Завершены сеансы',
    password_changed: 'Изменён пароль',
    password_reset: 'Восстановлен пароль',
    password_reset_requested: 'Запрошено восстановление',
    cabinet_saved: 'Сохранена картотека',
    cabinet_exported: 'Скачана копия картотеки',
    backup_created: 'Создана резервная копия',
    backup_restored: 'Восстановлена резервная копия',
    backup_failed: 'Ошибка резервного копирования',
    migration: 'Перенесены данные',
  };
  async function request(route, body) {
    const res = await fetch(route, {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || 'Не удалось выполнить действие.');
    return data;
  }
  async function mount(root) {
    if (!root) return;
    root.innerHTML = '<h3>Безопасность и резервные копии</h3><p>Загрузка…</p>';
    try {
      const state = await request('/api/security');
      if (!root.isConnected) return;
      root.innerHTML = `<h3>Безопасность и резервные копии</h3>
        <p>Восстановление по письму: <strong>${state.mailConfigured ? 'подключено' : 'ожидает настройки почты'}</strong>.</p>
        <p>Подтверждение входа: <strong>${state.mfa ? 'включено' : 'не включено'}</strong>. ${state.mfa ? `Осталось резервных кодов: ${state.recoveryRemaining}.` : 'Можно подключить приложение для одноразовых кодов.'}</p>
        <form id="security-form" class="security-form">
          <label class="field">Текущий пароль картотеки<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>
          ${state.mfa ? '<label class="field">Одноразовый или резервный код<input name="code" autocomplete="one-time-code" maxlength="40" required></label>' : ''}
          <div class="setting-actions"><button type="submit" class="secondary" name="action" value="${state.mfa ? 'disable' : 'prepare'}">${state.mfa ? 'Отключить' : 'Настроить'} подтверждение входа</button></div>
          <label class="field">Новый пароль (для смены пароля)<input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128"></label>
          <button type="submit" class="secondary" name="action" value="password">Изменить пароль и завершить все сеансы</button>
        </form><div id="mfa-setup"></div><p class="error" id="security-error" role="alert"></p>
        <h3>Устройства с доступом</h3><div>${state.sessions.map((s) => `<article class="service-setting"><div><strong>${s.current ? 'Это устройство' : 'Другой сеанс'}</strong><small>${esc(s.device || 'Браузер')} · Вход ${esc(new Date(s.created).toLocaleString('ru-RU'))}</small></div>${s.current ? '' : `<button class="secondary" data-revoke="${esc(s.id)}">Завершить</button>`}</article>`).join('')}</div>
        <button class="secondary" data-revoke="others">Завершить все другие сеансы</button>
        <p>Резервная копия: ${state.backup ? `${state.backup.ok ? 'создана' : 'ошибка'} ${esc(new Date(state.backup.time).toLocaleString('ru-RU'))}` : 'ещё не создана'}. Автоматически — раз в сутки при работающем сервере.</p>
        <details><summary>Последние действия</summary><ul>${state.audit.map((a) => `<li>${esc(new Date(a.time).toLocaleString('ru-RU'))} — ${esc(names[a.event] || 'Действие в кабинете')}</li>`).join('')}</ul></details>`;
      const error = (message) => {
        root.querySelector('#security-error').textContent = message;
      };
      root.querySelectorAll('[data-revoke]').forEach((button) =>
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await request('/api/security/revoke', { id: button.dataset.revoke });
            await mount(root);
          } catch (e) {
            error(e.message);
            button.disabled = false;
          }
        }),
      );
      root.querySelector('#security-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        error('');
        const form = event.currentTarget;
        const action = event.submitter.value;
        const body = Object.fromEntries(new FormData(form));
        if (action === 'password' && body.newPassword.length < 12) {
          error('Новый пароль должен содержать не менее 12 символов.');
          return;
        }
        if (action === 'disable' && !confirm('Отключить дополнительное подтверждение входа?'))
          return;
        const buttons = [...form.querySelectorAll('button')];
        buttons.forEach((b) => (b.disabled = true));
        try {
          if (action === 'prepare') {
            const result = await request('/api/security/mfa/prepare', body);
            form.reset();
            root.querySelector('#mfa-setup').innerHTML =
              `<h4>Добавьте картотеку в приложение для кодов</h4><p>Отсканируйте QR-код на другом устройстве или скопируйте секрет в приложение-аутентификатор на этом телефоне.</p><img class="mfa-qr" src="${esc(result.qr)}" alt="QR-код настройки входа"><label class="field">Секрет для ручного ввода<input readonly value="${esc(result.secret)}"></label><form id="mfa-confirm"><label class="field">Код из приложения<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required maxlength="6"></label><button class="primary">Подтвердить</button></form>`;
            root.querySelector('#mfa-confirm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const b = e.currentTarget.querySelector('button');
              b.disabled = true;
              try {
                const response = await request('/api/security/mfa/enable', {
                  code: new FormData(e.currentTarget).get('code'),
                });
                root.querySelector('#mfa-setup').innerHTML =
                  `<h4>Подтверждение входа включено</h4><p>Сохраните резервные коды отдельно от телефона. Каждый работает один раз, в том числе при восстановлении пароля. После закрытия этой страницы коды больше не показываются.</p><textarea readonly rows="10" aria-label="Резервные коды">${response.codes.map(esc).join('\n')}</textarea><button class="secondary" id="mfa-done">Коды сохранены</button>`;
                form.hidden = true;
                root.querySelector('#mfa-done').onclick = () => mount(root);
              } catch (e) {
                error(e.message);
                b.disabled = false;
              }
            });
          } else if (action === 'disable') {
            await request('/api/security/mfa/disable', body);
            await mount(root);
          } else {
            await request('/api/security/password', body);
            location.replace('/');
          }
        } catch (e) {
          error(e.message);
        } finally {
          buttons.forEach((b) => (b.disabled = false));
        }
      });
    } catch (e) {
      root.textContent = e.message;
    }
  }
  window.CartotecaSecurity = { mount };
})();
