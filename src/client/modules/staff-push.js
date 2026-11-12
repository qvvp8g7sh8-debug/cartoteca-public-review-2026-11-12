function createStaffPushUI(state, actions) {
  let root = null,
    key = '',
    snapshot = null,
    busy = false,
    loading = false,
    message = '',
    draft = null,
    lastPermission = '',
    statusController = null;
  const cancelStatus = () => statusController?.abort();
  window.addEventListener('pagehide', cancelStatus);
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const current = () => root?.isConnected && scope() === key && state.currentView === 'settings';
  const supported = () =>
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  const registration = () => navigator.serviceWorker.getRegistration('/');
  const call = (route, body, signal) =>
    actions.request('/api/push/staff/' + route, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
  const items = [
    ['new-request', 'Новая онлайн-запись'],
    ['confirmation', 'Ответ или подтверждение'],
    ['created', 'Создана запись'],
    ['moved', 'Запись перенесена'],
    ['cancelled', 'Запись отменена'],
    ['completed', 'Приём завершён'],
    ['no_show', 'Отмечена неявка'],
    ['restored', 'Запись восстановлена'],
    ['removed', 'Запись удалена'],
    ['updated', 'Другие изменения записи'],
    ['reminder', 'Начало рабочего дня'],
  ];
  function preferencesHtml(prefs) {
    const disabled = busy || !snapshot?.available || window.Notification.permission !== 'granted';
    const selected = prefs.events.flatMap((event) =>
      event === 'change'
        ? [
            'created',
            'moved',
            'cancelled',
            'completed',
            'no_show',
            'restored',
            'removed',
            'updated',
          ]
        : [event],
    );
    const events = items
      .map(
        ([id, label]) =>
          `<label><input type="checkbox" name="event" value="${id}" ${selected.includes(id) ? 'checked' : ''}><span>${label}</span></label>`,
      )
      .join('');
    const periods = [15, 30, 45, 60, 120]
      .map(
        (value) =>
          `<option value="${value}" ${prefs.leadMinutes === value ? 'selected' : ''}>${value < 60 ? value + ' минут' : value / 60 + (value === 60 ? ' час' : ' часа')}</option>`,
      )
      .join('');
    return [
      `<form data-push-preferences><fieldset ${disabled ? 'disabled' : ''}>`,
      '<legend>Какие уведомления получать</legend>',
      `<div class="staff-push-events">${events}</div>`,
      `<div data-push-reminder ${prefs.events.includes('reminder') ? '' : 'hidden'}><label class="staff-push-period">До начала работы<select name="leadMinutes">${periods}</select></label>`,
      '<p class="form-hint">Один раз перед рабочим днём по вашему графику.</p></div>',
      '<div class="staff-notification-actions"><button type="submit" class="primary">Сохранить</button>',
      '<button type="button" class="secondary" data-push-test>Проверить уведомления</button></div></fieldset></form>',
      `<button type="button" class="text-btn danger" data-push-disconnect ${busy ? 'disabled' : ''}>Отключить на этом устройстве</button>`,
    ].join('');
  }
  function render() {
    if (!current()) return;
    lastPermission = supported() ? window.Notification.permission : '';
    const device = snapshot?.device,
      denied = supported() && window.Notification.permission === 'denied';
    const status = !supported()
      ? 'Недоступны здесь'
      : denied
        ? 'Запрещены в браузере'
        : !snapshot
          ? message
            ? 'Не удалось проверить'
            : 'Проверяем…'
          : device?.enabled && window.Notification.permission === 'granted'
            ? device.preferences?.events.length
              ? 'Включены'
              : 'События не выбраны'
            : snapshot && !snapshot.available
              ? 'Сервис недоступен'
              : 'Выключены';
    const prefs = device?.preferences ||
      snapshot?.preferences || { events: items.map((x) => x[0]), leadMinutes: 120 };
    const linked = supported() && device?.enabled && window.Notification.permission === 'granted';
    const body =
      '<p class="staff-channel-intro">Настройки применяются только к этому устройству.</p>' +
      (!supported()
        ? '<p class="staff-channel-unavailable">В этом браузере Push недоступны.</p><details class="staff-channel-help"><summary>Как включить на iPhone</summary><p>Добавьте Картотеку на главный экран и откройте её с иконки.</p></details>'
        : denied
          ? '<p class="staff-channel-unavailable">Разрешите уведомления в настройках браузера или телефона, затем обновите статус.</p>'
          : snapshot && !snapshot.available
            ? '<p class="staff-channel-unavailable">Сервис сейчас недоступен. Можно проверить доступность позже.</p>'
            : '') +
      (device?.enabled
        ? preferencesHtml(prefs)
        : supported() && !denied && snapshot?.available
          ? `<button type="button" class="primary" data-push-connect ${busy ? 'disabled' : ''}>Включить на этом устройстве</button>`
          : '') +
      `<button type="button" class="text-btn staff-channel-refresh" data-push-refresh ${busy ? 'disabled' : ''}>Обновить статус</button>`;
    const changed = actions.renderStaffChannelPanel(root, {
      id: 'push',
      name: 'Push-уведомления',
      status,
      linked,
      loading: !snapshot && !message,
      body,
      message,
    });
    const form = root.querySelector('[data-push-preferences]');
    if (form && changed) {
      actions.markSettingsSaved(form);
      if (draft) {
        for (const field of form.querySelectorAll('[name="event"]'))
          field.checked = draft.events.includes(field.value);
        form.querySelector('[name="leadMinutes"]').value = String(draft.leadMinutes);
        form.querySelector('[data-push-reminder]').hidden = !draft.events.includes('reminder');
      }
    }
  }
  async function syncStaffPush() {
    if (!current() || !actions.settingsSectionVisible(root) || loading || busy) return;
    const expected = key,
      expectedRoot = root,
      controller = new window.AbortController();
    statusController = controller;
    window.addEventListener('beforeunload', cancelStatus);
    loading = true;
    try {
      const statusCurrent = () =>
        current() &&
        key === expected &&
        root === expectedRoot &&
        actions.settingsSectionVisible(root);
      const reg = supported() ? await registration() : null;
      if (!statusCurrent()) return;
      const sub = await reg?.pushManager.getSubscription();
      if (!statusCurrent()) return;
      const value = await call('status', { endpoint: sub?.endpoint || '' }, controller.signal);
      if (current() && key === expected && root === expectedRoot) {
        const changed = JSON.stringify(snapshot) !== JSON.stringify(value);
        if (snapshot?.device?.id !== value.device?.id) draft = null;
        snapshot = value;
        if (changed || lastPermission !== (supported() ? window.Notification.permission : ''))
          render();
      }
    } catch (error) {
      if (current() && key === expected) {
        message = error.message;
        render();
      }
    } finally {
      if (statusController === controller) {
        statusController = null;
        window.removeEventListener('beforeunload', cancelStatus);
      }
      loading = false;
      if (current() && (key !== expected || root !== expectedRoot)) void syncStaffPush();
    }
  }
  async function change(kind, preferences) {
    if (!current() || busy || state.busy || !snapshot) return;
    const expected = key,
      device = snapshot.device,
      operationCurrent = () => current() && key === expected;
    busy = true;
    render();
    try {
      if (kind === 'connect') {
        // Ask while still in the direct click gesture; never prompt on mount/background refresh.
        const permission = await window.Notification.requestPermission();
        if (!operationCurrent()) return;
        if (permission !== 'granted')
          throw Error('Уведомления не разрешены. Измените разрешение в настройках устройства.');
        const reg = await registration();
        if (!operationCurrent()) return;
        if (!reg) throw Error('Обновите страницу, чтобы подготовить уведомления.');
        let sub = await reg.pushManager.getSubscription();
        if (!operationCurrent()) return;
        let status = await call('status', { endpoint: sub?.endpoint || '' });
        if (!operationCurrent()) return;
        if (!status.available) throw Error('Сервис уведомлений сейчас недоступен.');
        const bytes = Uint8Array.from(
          window.atob(status.publicKey.replace(/-/g, '+').replace(/_/g, '/')),
          (x) => x.charCodeAt(0),
        );
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: bytes,
          });
          if (!operationCurrent()) return;
          // An empty-endpoint preflight cannot describe the newly created subscription.
          status = await call('status', { endpoint: sub.endpoint });
          if (!operationCurrent()) return;
        }
        if (!status.available) throw Error('Сервис уведомлений сейчас недоступен.');
        if (typeof status.bindingExpectation !== 'string' || !status.bindingExpectation)
          throw Error(
            'Не удалось проверить подключение уведомлений. Обновите статус и попробуйте снова.',
          );
        // A subscription belongs to the browser origin and may already be reused by another account.
        if (!operationCurrent()) return;
        const value = await call('connect', {
          subscription: sub.toJSON(),
          bindingExpectation: status.bindingExpectation,
        });
        if (current() && key === expected) snapshot = value;
      } else if (kind === 'disconnect') {
        if (
          !(await actions.confirmAction(
            'Отключить пуш-уведомления?',
            'Изменится только это устройство. Telegram, MAX и другие устройства останутся подключены.',
            'Отключить',
          ))
        )
          return;
        if (!current() || key !== expected) return;
        const value = await call('disconnect', { deviceId: device.id });
        if (!current() || key !== expected) return;
        snapshot = value;
        draft = null;
      } else if (kind === 'test') {
        await call('test', { deviceId: device.id });
        if (!current() || key !== expected) return;
        message =
          'Проверка поставлена в очередь. Получение сообщения на телефоне подтвердит доставку.';
      } else {
        const value = await call('settings', { deviceId: device.id, preferences });
        if (!current() || key !== expected) return;
        snapshot = value;
        message = 'События сохранены';
        draft = null;
      }
    } catch (error) {
      if (key === expected) message = error.message;
    } finally {
      busy = false;
      if (current() && key === expected) render();
      else if (current()) void syncStaffPush();
    }
  }
  function mountStaffPush({ refresh = true } = {}) {
    const next = actions.$('#staff-push');
    if (next === root && key === scope()) return;
    if (key !== scope()) {
      snapshot = null;
      message = '';
      draft = null;
    }
    root = next;
    key = scope();
    if (!root) return;
    render();
    root.addEventListener('click', (event) => {
      for (const kind of ['connect', 'disconnect', 'test'])
        if (event.target.closest(`[data-push-${kind}]`)) void change(kind);
      if (event.target.closest('[data-push-refresh]')) void syncStaffPush();
    });
    root.addEventListener('submit', (event) => {
      if (!event.target.matches('[data-push-preferences]')) return;
      event.preventDefault();
      const form = new FormData(event.target);
      void change('settings', {
        events: form.getAll('event'),
        leadMinutes: Number(form.get('leadMinutes')),
      });
    });
    root.addEventListener('change', (event) => {
      const form = event.target.closest('[data-push-preferences]');
      if (!form) return;
      const values = new FormData(form);
      draft = { events: values.getAll('event'), leadMinutes: Number(values.get('leadMinutes')) };
      form.querySelector('[data-push-reminder]').hidden = !draft.events.includes('reminder');
    });
    if (refresh) void syncStaffPush();
  }
  async function disconnectPushOnLogout() {
    if (!supported()) return;
    const expected = scope(),
      reg = await registration();
    if (scope() !== expected) return;
    const sub = await reg?.pushManager.getSubscription();
    if (!sub || scope() !== expected) return;
    const value = await call('status', { endpoint: sub.endpoint });
    if (scope() !== expected) return;
    // Disable only this account's server device; the shared browser subscription stays intact.
    if (value.device) await call('disconnect', { deviceId: value.device.id });
  }
  async function openStaffPushTarget() {
    if (!location.hash.startsWith('#staff-push=') || !state.multiUser) return;
    try {
      const value = JSON.parse(decodeURIComponent(location.hash.slice(12))),
        expected = scope();
      history.replaceState(null, '', location.pathname);
      if (!value.accountId || value.accountId !== state.account?.id) {
        actions.toast('Уведомление другой учётной записи. Откройте календарь.');
        return;
      }
      if (value.organizationId !== state.account?.organizationId) {
        actions.toast('Уведомление другой организации. Выберите нужную организацию вручную.');
        return;
      }
      if (value.kind === 'request') {
        await actions.openManagement('requests');
        if (scope() !== expected) return;
        if (value.id) await actions.openBookingRequestTarget(value.id);
        return;
      }
      if (value.patientId && value.id) {
        const patient = await actions.ensurePatient(value.patientId);
        if (scope() !== expected) return;
        if (!patient?.appointments?.some((a) => a.id === value.id)) {
          actions.toast('Запись уже изменена или недоступна');
          return;
        }
        await actions.openAppointmentActions({
          ...patient.appointments.find((a) => a.id === value.id),
          patientId: patient.id,
        });
      } else await actions.setView('calendar');
    } catch {
      actions.toast('Запись недоступна. Откройте календарь.');
    }
  }
  return { mountStaffPush, syncStaffPush, disconnectPushOnLogout, openStaffPushTarget };
}
