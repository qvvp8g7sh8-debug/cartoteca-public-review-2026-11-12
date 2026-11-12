function createProfile(state, actions) {
  function profileSettingsHtml() {
    return actions.settingsSectionHtml(
      'Мой профиль',
      'profile-settings',
      '<p>Загружаем данные регистрации…</p>',
    );
  }
  function renderProfile(result, root) {
    const {
      account,
      organization: org,
      canEditOrganization,
      canEditContactPhone,
      contactPhone = '',
      specialty = '',
    } = result;
    const esc = actions.esc;
    const organizationFields =
      canEditOrganization && org
        ? [
            '<h4 class="profile-group-heading">Для клиентов</h4>',
            '<label class="field profile-organization-name"><span class="profile-field-label">Название для клиентов</span>',
            `<input name="organizationName" required maxlength="120" value="${esc(org.name)}"></label>`,
            '<label class="field profile-contact-field"><span class="profile-field-label">Город</span>',
            `<input name="city" maxlength="120" autocomplete="address-level2" value="${esc(org.city)}"></label>`,
            '<label class="field profile-contact-field"><span class="profile-field-label">Контактный телефон</span>',
            `<input name="phone" maxlength="40" type="tel" autocomplete="tel" value="${esc(org.phone)}"></label>`,
          ].join('')
        : '';

    root.innerHTML = [
      '<section data-profile-overview>' + actions.profileOverviewHtml(result) + '</section>',
      '<section data-profile-editor hidden aria-label="Редактирование профиля">',
      '<form id="account-profile-form">',
      '<div class="form-grid profile-grid">',
      '<h4 class="profile-group-heading">Ваш аккаунт</h4>',
      '<label class="field profile-display-name"><span class="profile-field-label">Имя и фамилия</span>',
      `<input name="displayName" required maxlength="120" autocomplete="name" value="${esc(account.displayName)}"></label>`,
      '<div class="field"><div class="settings-label-row"><label for="profile-login-email">Почта для входа</label>',
      actions.settingsHelpHtml(
        'Данные профиля',
        'Данные взяты из регистрации. Изменение профиля не меняет пароль и почту для входа.',
      ),
      `</div><input id="profile-login-email" type="email" readonly value="${esc(account.email)}"></div>`,
      org
        ? [
            '<div class="field"><div class="settings-label-row"><label for="profile-specialty">Специальность</label>',
            actions.settingsHelpHtml(
              'Специальность',
              'Необязательное поле. Например: тренер, парикмахер, консультант. Специальность используется в приглашениях и уведомлениях клиентам.',
            ),
            `</div><input id="profile-specialty" name="specialty" maxlength="120" placeholder="Необязательно" value="${esc(specialty)}"></div>`,
            `<input type="hidden" name="expectedSpecialty" value="${esc(specialty)}">`,
          ].join('')
        : '',
      organizationFields,
      canEditContactPhone
        ? '<h4 class="profile-group-heading">Для клиентов</h4><label class="field profile-contact-field"><span class="profile-field-label">Телефон для клиентов</span>' +
          `<input name="contactPhone" maxlength="40" type="tel" autocomplete="tel" value="${esc(contactPhone)}">` +
          '<small class="form-hint">Этот номер может быть показан клиентам на публичной странице онлайн-записи.</small></label>' +
          `<input type="hidden" name="expectedContactPhone" value="${esc(contactPhone)}">`
        : '',
      '</div>',
      org && !canEditOrganization
        ? [
            '<div class="settings-label-row profile-organization-info">',
            `<span>Организация: ${esc(org.name)}</span>`,
            actions.settingsHelpHtml(
              'Сведения организации',
              'Сведения об организации изменяет владелец. Личные поля доступны в вашем профиле.',
            ),
            '</div>',
          ].join('')
        : '',
      '<div class="profile-save-row"><button class="primary" type="submit">Сохранить профиль</button>',
      '<button type="button" class="secondary" data-profile-cancel>Отмена</button>',
      '<p id="profile-message" role="status" aria-live="polite"></p></div>',
      '</form>',
      '</section>',
      org && actions.canManageTeam()
        ? '<section id="organization-time-zone-settings" aria-label="Время организации"><p class="form-hint">Загрузка часового пояса…</p></section>'
        : '',
    ].join('');
    actions.syncProfileOverview(result, root.querySelector('#account-profile-form'));
    void actions.mountOrganizationTimeZone();
  }
  async function loadAccountProfile() {
    const root = actions.$('#profile-settings');
    if (!root || root.querySelector('form')) return;
    const account = state.account;
    try {
      const result = await actions.readBackground('/api/account/profile');
      if (!root.isConnected || state.account !== account) return;
      renderProfile(result, root);
    } catch (e) {
      if (root.isConnected && state.account === account)
        root.innerHTML =
          '<p class="error" role="status">' +
          actions.esc(e.message) +
          '</p><button type="button" class="secondary" id="retry-profile">Повторить загрузку</button>';
    }
  }
  function bindProfileEvents() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#retry-profile')) void actions.loadAccountProfile();
    });
    document.addEventListener('submit', async (e) => {
      if (e.target.id !== 'account-profile-form') return;
      e.preventDefault();
      if (state.busy) return;
      const account = state.account,
        form = e.target,
        button = form.querySelector('button[type="submit"]'),
        message = form.querySelector('#profile-message');
      const f = new FormData(form),
        values = { displayName: f.get('displayName') };
      if (form.elements.specialty) {
        values.specialty = f.get('specialty');
        values.expectedSpecialty = f.get('expectedSpecialty');
      }
      if (form.elements.contactPhone) {
        values.contactPhone = f.get('contactPhone');
        values.expectedContactPhone = f.get('expectedContactPhone');
      }
      if (form.elements.organizationName)
        values.organization = {
          name: f.get('organizationName'),
          city: f.get('city'),
          phone: f.get('phone'),
        };
      state.busy = true;
      button.disabled = true;
      message.textContent = '';
      try {
        const result = await actions.request('/api/account/profile', {
          method: 'POST',
          body: JSON.stringify(values),
        });
        if (state.account !== account || !form.isConnected) return;
        state.account.displayName = result.account.displayName;
        if (form.elements.expectedSpecialty)
          form.elements.expectedSpecialty.value = result.specialty;
        const heading = actions.$('#account-profile-name');
        if (heading)
          heading.textContent =
            result.account.displayName === state.roleNames[actions.accountRole()]
              ? 'Мой аккаунт'
              : result.account.displayName;
        message.textContent = 'Профиль сохранён';
        actions.syncProfileOverview(result, form);
        actions.toast('Профиль сохранён');
        if (state.teamAccess)
          state.teamAccess.members.forEach((m) => {
            if (m.accountId === state.account.id) {
              m.displayName = result.account.displayName;
              m.specialty = result.specialty;
            }
          });
        if (actions.canManageTeam()) await actions.loadTeamAccess();
      } catch (e) {
        if (message.isConnected) message.textContent = e.message;
      } finally {
        state.busy = false;
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  return { profileSettingsHtml, loadAccountProfile, bindProfileEvents };
}
