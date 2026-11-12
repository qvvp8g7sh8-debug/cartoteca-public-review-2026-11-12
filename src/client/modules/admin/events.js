function bindAdminEvents({
  $,
  token,
  show,
  request,
  message,
  changeView,
  lists,
  reloadSummary,
  loadAudit,
}) {
  const pending = new window.WeakMap();
  function requestId() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const text = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    return [
      text.slice(0, 8),
      text.slice(8, 12),
      text.slice(12, 16),
      text.slice(16, 20),
      text.slice(20),
    ].join('-');
  }
  function payload(form) {
    const values = new FormData(form),
      kind = form.dataset.adminCommand;
    const body = { expectedRevision: Number(form.dataset.revision) };
    body[
      kind === 'profile' || kind === 'subscription' || kind === 'organizationAccess'
        ? 'organizationId'
        : kind.startsWith('case')
          ? 'caseId'
          : 'accountId'
    ] = form.dataset.id;
    if (values.has('reason')) body.reason = values.get('reason').trim();
    if (kind === 'profile')
      body.changes = Object.fromEntries(
        ['name', 'city', 'phone'].map((key) => [key, values.get(key)]),
      );
    if (kind === 'subscription') {
      body.plan = values.get('plan');
      body.limits = {
        patients: Number(values.get('patients')),
        photos: Number(values.get('photos')),
        publicBooking: values.has('publicBooking'),
        automaticNotifications: values.has('automaticNotifications'),
      };
    }
    if (kind === 'accountAccess' || kind === 'organizationAccess')
      body.status = values.get('status');
    if (kind === 'emailRecovery') {
      body.email = values.get('email').trim();
      body.identityConfirmed = values.has('identityConfirmed');
      body.password = values.get('password');
    }
    if (kind === 'caseState') {
      body.state = values.get('state');
      if (values.has('improvementState')) body.improvementState = values.get('improvementState');
      body.claim = values.has('claim');
    }
    if (kind === 'caseMessage') {
      body.kind = values.get('kind');
      body.text = values.get('text').trim();
    }
    return body;
  }
  async function mutate(form) {
    if (form.dataset.busy) return;
    const body = payload(form),
      { password, ...safe } = body;
    const signature = JSON.stringify([form.dataset.route, safe]);
    let operation = pending.get(form);
    if (operation?.unknown && operation.signature !== signature) {
      message(
        'Результат предыдущего действия неизвестен. Повторите его с прежними данными, прежде чем менять форму.',
        true,
      );
      return;
    }
    if (!operation || operation.signature !== signature) operation = { id: requestId(), signature };
    body.requestId = operation.id;
    pending.set(form, operation);
    const kind = form.dataset.adminCommand;
    if (
      [
        'accountAccess',
        'organizationAccess',
        'subscription',
        'sessions',
        'cancelRecovery',
        'emailRecovery',
      ].includes(kind) &&
      !confirm(
        kind === 'accountAccess'
          ? 'Это действие влияет на все организации пользователя. Выполнить?'
          : kind === 'organizationAccess'
            ? 'Изменить доступ выбранной организации? Подписка не изменится.'
            : kind === 'emailRecovery'
              ? 'Отправить подтверждение новой почте после выполненной вами проверки личности?'
              : 'Выполнить действие для выбранной записи?',
      )
    )
      return;
    form.dataset.busy = '1';
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    message('Выполняем…');
    try {
      let result;
      try {
        result = await request(form.dataset.route, { method: 'POST', body: JSON.stringify(body) });
      } catch (error) {
        if (error.unknown) {
          const saved = await request('/api/admin/operation?requestId=' + operation.id).catch(
            () => null,
          );
          if (!saved?.result) throw error;
          result = saved.result;
        } else throw error;
      }
      pending.delete(form);
      const record = form.closest('[data-admin-record]');
      delete record.dataset.dirty;
      await lists.reloadRecord(record);
      await reloadSummary();
      message(
        result.pending
          ? 'Запрос сохранён. Подтверждение поставлено в почтовую очередь; прежний вход пока действует.'
          : result.queued
            ? 'Ответ сохранён и поставлен в почтовую очередь. Обращение не закрыто автоматически.'
            : 'Изменения сохранены.',
      );
    } catch (error) {
      operation.unknown = Boolean(error.unknown);
      if (!operation.unknown) pending.delete(form);
      message(
        operation.unknown
          ? 'Ответ сервера не получен. Не меняйте данные: повторите действие, дубликат не создастся.'
          : error.message,
        true,
      );
    } finally {
      if (form.querySelector('[name="password"]'))
        form.querySelector('[name="password"]').value = '';
      delete form.dataset.busy;
      button.disabled = false;
    }
  }
  for (const [kind, c] of Object.entries(lists.config)) {
    if (c.search) $(c.search).addEventListener('input', () => lists.search(kind));
    for (const selector of [c.status, c.plan].filter(Boolean))
      $(selector).addEventListener('change', () => lists.load(kind));
    $(c.more).addEventListener('click', () => lists.load(kind, true));
  }
  $('#admin-audit-more').addEventListener('click', () => loadAudit(true));
  $('#admin-audit-event').addEventListener('change', () => loadAudit());
  let auditSearchTimer;
  $('#admin-audit-search').addEventListener('input', () => {
    clearTimeout(auditSearchTimer);
    auditSearchTimer = setTimeout(() => {
      void loadAudit();
    }, 250);
  });
  $('#admin-audit-clear').addEventListener('click', () => loadAudit(false, null));
  $('#admin-support-clear').addEventListener('click', () => {
    lists.related('support', null);
    void lists.load('support');
  });
  $('#admin-setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = form.querySelector('button');
    $('#admin-error').textContent = '';
    if ($('#admin-password').value !== $('#admin-repeat').value) {
      $('#admin-error').textContent = 'Пароли не совпадают.';
      return;
    }
    button.disabled = true;
    try {
      await request('/api/admin/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          token,
          email: $('#admin-email').value.trim(),
          password: $('#admin-password').value,
          displayName: $('#admin-name').value,
        }),
      });
      form.reset();
      show('#admin-created');
    } catch (error) {
      $('#admin-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('#admin-logout').addEventListener('click', async () => {
    try {
      await request('/api/auth/logout', { method: 'POST', body: '{}' });
      location.replace('/');
    } catch (error) {
      message(error.message, true);
    }
  });
  document.addEventListener('input', (event) => {
    const record = event.target.closest('[data-admin-record]');
    if (record) record.dataset.dirty = '1';
  });
  document.addEventListener('change', (event) => {
    const record = event.target.closest('[data-admin-record]');
    if (record) record.dataset.dirty = '1';
  });
  document.addEventListener('click', (event) => {
    const summary = event.target.closest('[data-admin-record]>summary');
    if (!summary) return;
    const record = summary.closest('[data-admin-record]');
    if (record.open && record.dataset.dirty) {
      if (!confirm('Закрыть карточку без сохранения изменений?')) event.preventDefault();
      else delete record.dataset.dirty;
    }
  });
  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-admin-command]');
    if (!form) return;
    event.preventDefault();
    void mutate(form);
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-admin-older-messages]');
    if (!button || button.disabled) return;
    const record = button.closest('[data-admin-record]');
    button.disabled = true;
    try {
      const data = await request(
        '/api/admin/support/messages?' +
          new URLSearchParams({
            id: record.dataset.id,
            before: button.dataset.before,
            beforeId: button.dataset.beforeId,
          }),
      );
      if (!record.isConnected) return;
      record
        .querySelector('.admin-thread')
        .insertAdjacentHTML('afterbegin', createAdminRecords().supportMessages(data.items));
      if (data.next) {
        button.dataset.before = data.next.before;
        button.dataset.beforeId = data.next.beforeId;
      } else button.hidden = true;
    } catch (error) {
      message(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest(
      '[data-admin-view], [data-admin-jump], [data-admin-related], [data-admin-close]',
    );
    if (!button) return;
    if (button.hasAttribute('data-admin-close')) {
      const record = button.closest('[data-admin-record]');
      if (record.dataset.dirty && !confirm('Закрыть карточку без сохранения изменений?')) return;
      delete record.dataset.dirty;
      record.open = false;
      record.querySelector('summary').focus();
      return;
    }
    if (button.dataset.adminRelated === 'support') {
      lists.related('support', button.dataset.organization);
      void changeView('support');
      return;
    }
    if (button.dataset.adminRelated === 'audit') {
      void changeView('audit', button.dataset.organization);
      return;
    }
    if (button.dataset.adminFilter) {
      const target = button.dataset.adminJump;
      $(target === 'support' ? '#admin-support-state' : '#admin-org-status').value =
        button.dataset.adminFilter;
    }
    void changeView(button.dataset.adminView || button.dataset.adminJump);
  });
}
