function createProfileOverview(state, actions) {
  const drafts = new window.WeakMap();
  const fields = (form) => [...form.querySelectorAll('input[name]')];
  const values = (form) => JSON.stringify(fields(form).map((field) => [field.name, field.value]));
  function showProfile(root, editing = root.dataset.profileEditing === 'true') {
    root.dataset.profileEditing = String(editing);
    const editor = editing || window.matchMedia('(min-width: 980px)').matches;
    root.querySelector('[data-profile-editor]').hidden = !editor;
    root.querySelector('[data-profile-overview]').hidden = editor;
  }
  function profileOverviewHtml(result) {
    const { account, organization: org, specialty = '', canEditOrganization } = result;
    const row = (title, value) =>
      `<div class="profile-overview-row"><dt>${actions.esc(title)}</dt><dd>${actions.esc(value || 'Не указано')}</dd></div>`;
    return [
      '<div class="profile-overview-identity">',
      `<span class="profile-overview-avatar" aria-hidden="true">${actions.esc(actions.initials(account.displayName))}</span>`,
      `<div><strong>${actions.esc(account.displayName)}</strong><span>${actions.esc(state.roleNames[actions.accountRole()] || actions.accountRole())}</span></div></div>`,
      '<h4 class="profile-group-heading">Ваш аккаунт</h4>',
      '<dl class="profile-overview-list">',
      row('Почта для входа', account.email),
      row('Специальность', specialty),
      ...(org
        ? [
            '</dl><h4 class="profile-group-heading">Для клиентов</h4><dl class="profile-overview-list">',
            row('Название для клиентов', org.name),
            row('Город', org.city),
            row('Телефон организации', org.phone),
            ...(result.canEditContactPhone
              ? [row('Ваш телефон для клиентов', result.contactPhone)]
              : []),
          ]
        : []),
      '</dl><div class="profile-overview-actions"><button type="button" class="primary" data-profile-edit>Редактировать профиль</button></div>',
      org && !canEditOrganization
        ? '<p class="form-hint">Сведения организации изменяет владелец.</p>'
        : '',
      '<p data-profile-result role="status" aria-live="polite"></p>',
    ].join('');
  }
  function syncProfileOverview(result, form) {
    const root = form.closest('#profile-settings');
    if (!root) return;
    root.querySelector('[data-profile-overview]').innerHTML = profileOverviewHtml(result);
    const data = {
      displayName: result.account.displayName,
      specialty: result.specialty || '',
      expectedSpecialty: result.specialty || '',
      organizationName: result.organization?.name || '',
      city: result.organization?.city || '',
      phone: result.organization?.phone || '',
      contactPhone: result.contactPhone || '',
      expectedContactPhone: result.contactPhone || '',
    };
    for (const field of fields(form))
      if (Object.hasOwn(data, field.name)) field.value = data[field.name];
    drafts.set(form, {
      baseline: values(form),
      fields: fields(form).map((field) => [field.name, field.value]),
    });
    const editing = !root.querySelector('[data-profile-editor]').hidden;
    showProfile(root, false);
    if (editing) {
      root.querySelector('[data-profile-result]').textContent = 'Профиль сохранён';
      if (root.querySelector('[data-profile-editor]').hidden)
        root.querySelector('[data-profile-edit]')?.focus({ preventScroll: true });
    }
    actions.markSettingsSaved(form);
  }
  function bindProfileOverviewEvents() {
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-profile-edit], [data-profile-cancel]');
      if (!button || state.busy) return;
      const root = button.closest('#profile-settings');
      const form = root?.querySelector('#account-profile-form');
      if (!form) return;
      const expectedAccount = state.account;
      const draft = drafts.get(form);
      if (button.hasAttribute('data-profile-cancel')) {
        if (
          draft &&
          values(form) !== draft.baseline &&
          !(await actions.confirmAction(
            'Отменить изменения профиля?',
            'Введённые сведения не будут сохранены.',
            'Отменить изменения',
            'Продолжить редактирование',
          ))
        )
          return;
        if (state.busy || state.account !== expectedAccount || !root.isConnected) return;
        for (const [name, value] of draft?.fields || []) form.elements[name].value = value;
        actions.markSettingsSaved(form);
        showProfile(root, false);
        if (root.querySelector('[data-profile-editor]').hidden)
          root.querySelector('[data-profile-edit]')?.focus({ preventScroll: true });
      } else {
        showProfile(root, true);
        root.querySelector('[data-profile-result]').textContent = '';
        form.elements.displayName.focus({ preventScroll: true });
      }
    });
    window.matchMedia('(min-width: 980px)').addEventListener('change', () => {
      const root = actions.$('#profile-settings');
      if (root?.querySelector('[data-profile-editor]')) showProfile(root);
    });
  }
  return { profileOverviewHtml, syncProfileOverview, bindProfileOverviewEvents };
}
