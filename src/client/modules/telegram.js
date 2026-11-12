function createTelegram(state, actions) {
  const links = new Map(),
    preparing = new Map();
  let syncing = false,
    queuedForce = false,
    activeContext = [],
    sequence = 0;
  const syncContext = () => [
    JSON.stringify([
      state.account?.id,
      state.account?.organizationId,
      state.currentView,
      state.selectedId,
    ]),
    actions.$('#telegram-settings'),
    actions.$('#staff-notifications'),
    actions.$('#telegram-settings')?.closest('details')?.open,
    actions.$('#staff-notifications')?.closest('details')?.open,
  ];
  const linkKey = (patientId) =>
    [state.account?.id, state.account?.organizationId, patientId].join(':');
  const serviceIcon = (kind) =>
    kind === 'telegram'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 3.4 18.5 20c-.2 1.2-.9 1.5-1.9.9l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6 13.8l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20.2 3c.9-.3 1.7.2 1.5.4Z"/></svg>'
      : kind === 'whatsapp'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a9.7 9.7 0 0 0-8.3 14.8L2.4 22l5.3-1.4A9.8 9.8 0 1 0 12 2Zm5.7 13.8c-.2.7-1.4 1.3-2 1.4-.5.1-1.2.2-3.9-.9-3.3-1.4-5.5-4.8-5.7-5-.2-.2-1.3-1.7-1.3-3.3s.8-2.4 1.1-2.7c.3-.3.7-.4.9-.4h.7c.2 0 .5-.1.8.6l1 2.4c.1.2.1.5 0 .7l-.4.7-.6.7c-.2.2-.4.4-.2.8.2.4.9 1.5 2 2.4 1.4 1.2 2.5 1.6 2.9 1.8.4.2.6.2.8-.1l1.2-1.5c.3-.4.6-.3 1-.2l2.2 1c.4.2.6.3.7.5.1.1.1.7-.1 1.4Z"/></svg>'
        : '<span class="connection-max-mark" aria-hidden="true">MAX</span>';
  function patientConnectionsHtml(patientId) {
    return [
      `<details class="patient-connections" data-patient-id="${actions.esc(patientId)}" aria-labelledby="patient-connections-title">`,
      '<summary><span id="patient-connections-title">Сервисы для уведомлений клиента</span><small class="patient-connections-status" data-telegram="checking" data-max="checking" role="status" aria-live="polite">Проверяем подключение…</small></summary>',
      `<div class="patient-connections-grid"><div id="patient-telegram-connection" data-patient-id="${actions.esc(patientId)}">`,
      '<div class="connection-service is-loading" role="status">',
      serviceIcon('telegram'),
      '<span><strong>Telegram</strong><small>Проверяем…</small></span></div></div>',
      '<button type="button" class="connection-service is-future" disabled aria-label="WhatsApp — пока недоступен">',
      serviceIcon('whatsapp'),
      '<span><strong>WhatsApp</strong><small>Позже</small></span></button>',
      `<div id="patient-max-connection" data-patient-id="${actions.esc(patientId)}"><button type="button" class="connection-service is-future" disabled aria-label="MAX — подключение готовится">`,
      serviceIcon('max'),
      '<span><strong>MAX</strong><small>Готовится</small></span></button></div></div>',
      '</details>',
    ].join('');
  }
  async function prepareTelegramInvitation(patientId, { quiet = false, force = false } = {}) {
    if (!state.multiUser) return;
    const key = linkKey(patientId),
      cached = links.get(key);
    if (!force && cached?.expiresAt > Date.now()) return cached;
    if (preparing.has(key)) return preparing.get(key);
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 8000);
    const task = (async () => {
      try {
        const result = await actions.request('/api/telegram/link', {
          method: 'POST',
          body: JSON.stringify({ patientId }),
          signal: controller.signal,
        });
        if (key !== linkKey(patientId)) return;
        const invitation = {
          url: result.url,
          qrDataUrl: result.qrDataUrl,
          invitationText: result.invitationText,
          expiresAt: Date.now() + 86400000,
          patientId,
          accountKey: [state.account?.id, state.account?.organizationId].join(':'),
        };
        links.set(key, invitation);
        void actions.loadPatientTelegram(patientId);
        return invitation;
      } catch (e) {
        if (!quiet) throw e;
      } finally {
        clearTimeout(timeout);
        preparing.delete(key);
      }
    })();
    preparing.set(key, task);
    return task;
  }
  function renderPatientTelegram(root, patientId, result) {
    const key = linkKey(patientId),
      issued = links.get(key);
    if (result.linked || issued?.expiresAt <= Date.now()) {
      if (issued) issued.expiresAt = 0;
      links.delete(key);
    }
    const pending = links.get(key);
    const signature = JSON.stringify([result, pending?.url]);
    if (root.dataset.telegramSignature === signature) return;
    root.dataset.telegramSignature = signature;
    delete root.dataset.appointmentId;
    root.innerHTML = actions.appointmentPanelHtml(
      result.appointments.filter((a) => actions.isActiveAppointment(a)),
      patientId,
      result,
    );
    const connection = actions.$('#patient-telegram-connection');
    if (!connection || connection.dataset.patientId !== patientId) return;
    const control = result.linked
      ? actions.canManageTeam()
        ? '<button type="button" class="connection-service connection-telegram is-linked" data-telegram-unlink="' +
          actions.esc(patientId) +
          '" aria-label="Telegram подключён. Нажмите, чтобы отключить">'
        : '<div class="connection-service connection-telegram is-linked" role="status" aria-label="Telegram подключён">'
      : '<button type="button" class="connection-service connection-telegram" ' +
        (pending ? 'data-telegram-share="' : 'data-telegram-link="') +
        actions.esc(patientId) +
        '" ' +
        (!pending && !result.bot.connected
          ? 'disabled title="Бот временно не подключён. Проверяем связь автоматически."'
          : '') +
        '>';
    connection.innerHTML =
      control +
      serviceIcon('telegram') +
      '<span><strong>Telegram</strong><small class="connection-service-status">' +
      (result.linked
        ? '<span class="connection-check" aria-hidden="true">✓</span> Подключён'
        : pending
          ? 'Отправить приглашение'
          : result.bot.connected
            ? 'Не подключён · подключить'
            : 'Бот недоступен') +
      '</small></span>' +
      (result.linked && !actions.canManageTeam() ? '</div>' : '</button>');
    actions.updateClientServiceSummary(
      patientId,
      'telegram',
      result.linked ? 'linked' : 'unlinked',
    );
  }
  async function editAppointment(button, complete = false) {
    const patientId = button.dataset.telegramPatient,
      id = complete ? button.dataset.completeAppointment : button.dataset.telegramEdit,
      accountKey = linkKey(patientId);
    if (actions.$('#editor').open) return;
    const cabinet = await actions.request(
      state.lazyReads ? '/api/cabinet/patient?id=' + encodeURIComponent(patientId) : '/api/cabinet',
    );
    if (
      state.currentView !== 'card' ||
      state.selectedId !== patientId ||
      accountKey !== linkKey(patientId) ||
      actions.$('#editor').open
    )
      return;
    const a = cabinet.patients
      .find((p) => p.id === patientId)
      ?.appointments.find((a) => a.id === id);
    if (!a || a.status === 'completed' || (complete && !actions.isActiveAppointment(a))) {
      actions.toast('Запись уже удалена или посещение оформлено');
      await actions.loadPatientTelegram(patientId);
      return;
    }
    if (!actions.canEditRecord(a)) {
      actions.toast('Нет доступа к редактированию этой записи');
      return;
    }
    if (state.lazyReads) actions.rememberPatient(cabinet);
    else {
      state.data = cabinet.patients;
      state.services = cabinet.services;
      state.revision = cabinet.revision;
      actions.rememberCabinet(cabinet);
    }
    if (complete) actions.completeAppointment(id);
    else actions.openAppointmentForm({ ...a, patientId }, 'card');
  }
  async function loadPatientTelegram(patientId = state.selectedId) {
    const root = actions.$('#patient-telegram-body');
    if (!root || !patientId) return;
    void actions.loadPatientMax(patientId);
    const requestId = ++sequence,
      key = linkKey(patientId);
    try {
      const result = await actions.readPatientTelegramStatus(patientId);
      if (
        !result ||
        !root.isConnected ||
        state.selectedId !== patientId ||
        requestId !== sequence ||
        key !== linkKey(patientId)
      )
        return;
      const p = state.data.find((p) => p.id === patientId) || actions.viewPatient();
      if (!p || p.id !== patientId) return;
      for (const a of p.appointments || []) {
        const receipt = result.confirmations.find((c) => c.appointmentId === a.id);
        a.telegramConfirmedAt = receipt?.confirmedAt || null;
        a.notificationConfirmedAt = receipt?.notificationConfirmedAt || null;
        a.notificationConfirmedChannel = receipt?.notificationConfirmedChannel || '';
        const delivery = result.appointments.find((item) => item.appointmentId === a.id);
        if (delivery?.deliveryReady) {
          for (const field of [
            'deliveryReady',
            'deliveryPreference',
            'deliveryRevision',
            'deliveryChannel',
            'deliveryChannels',
            'deliveryStatuses',
            'deliveryStatus',
          ])
            a[field] = delivery[field];
        }
        a.manualConfirmedAt = receipt?.manualConfirmedAt || null;
        a.manualConfirmedBy = receipt?.manualConfirmedBy || '';
        if (receipt) a.confirmationKey = receipt.confirmationKey;
      }
      renderPatientTelegram(root, patientId, result);
    } catch (e) {
      if (
        root.isConnected &&
        state.selectedId === patientId &&
        requestId === sequence &&
        key === linkKey(patientId)
      ) {
        delete root.dataset.telegramSignature;
        let error = root.querySelector('.telegram-status-error');
        if (!error) {
          error = document.createElement('p');
          error.className = 'error telegram-status-error';
          error.setAttribute('role', 'status');
          root.append(error);
        }
        error.textContent = e.message + ' Проверяем повторно автоматически.';
      }
    }
  }
  async function syncVisibleTelegram({ force = false } = {}) {
    if (
      typeof document === 'undefined' ||
      state.busy ||
      !state.multiUser ||
      document.visibilityState === 'hidden'
    )
      return;
    if (syncing) {
      if (force) queuedForce = syncContext().some((value, index) => value !== activeContext[index]);
      return;
    }
    syncing = true;
    activeContext = syncContext();
    try {
      if (state.currentView === 'card' && actions.$('.telegram-patient-panel'))
        await actions.loadPatientTelegram();
      if (state.currentView === 'settings' && state.settingsReady !== false) {
        await Promise.all([
          actions.loadTelegramSettings({ statusOnly: true, force }),
          actions.syncStaffNotifications({ force }),
        ]);
      }
    } finally {
      syncing = false;
      if (queuedForce) {
        queuedForce = false;
        await syncVisibleTelegram({ force: true });
      }
    }
  }
  function bindTelegramEvents() {
    const dismissMenus = (e) => {
      for (const menu of document.querySelectorAll(
        '.telegram-service-menu[open],.patient-actions .patient-connections[open],.patient-actions .patient-more[open]',
      ))
        if (!menu.contains(e.target)) menu.open = false;
    };
    document.addEventListener('pointerdown', dismissMenus, true);
    document.addEventListener('click', dismissMenus, true);
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        // A top-layer dialog owns Escape; do not close a disclosure behind it instead.
        if (document.querySelector('dialog[open]')) return;
        const menus = [
          ...document.querySelectorAll(
            '.telegram-service-menu[open],.patient-actions .patient-connections[open],.patient-actions .patient-more[open]',
          ),
        ];
        if (!menus.length) return;
        for (const menu of menus) menu.open = false;
        menus[0].querySelector('summary').focus();
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    document.addEventListener('click', async (e) => {
      if (e.target.closest('[data-appointment-outcome], [data-card-appointment]')) return;
      if (e.target.closest('.telegram-patient-panel')) e.stopImmediatePropagation();
      const share = e.target.closest('[data-telegram-share]');
      if (share) {
        if (!state.busy)
          actions.shareTelegramInvitation(links.get(linkKey(share.dataset.telegramShare)));
        return;
      }
      const link = e.target.closest('[data-telegram-link]'),
        unlink = e.target.closest('[data-telegram-unlink]'),
        remind = e.target.closest('[data-telegram-remind]'),
        edit = e.target.closest('[data-telegram-edit]');
      const complete = e.target.closest('.telegram-patient-panel [data-complete-appointment]');
      if ((!link && !unlink && !remind && !edit && !complete) || state.busy) return;
      try {
        state.busy = true;
        if (edit || complete) await editAppointment(edit || complete, Boolean(complete));
        if (link) {
          link.disabled = true;
          const status = link.querySelector('.connection-service-status');
          if (status) status.textContent = 'Создаём приглашение…';
          await prepareTelegramInvitation(link.dataset.telegramLink);
          await actions.loadPatientTelegram(link.dataset.telegramLink);
        }
        if (unlink) {
          if (
            window.confirm(
              'Отключить Telegram этого клиента? Неотправленные напоминания будут отменены.',
            )
          ) {
            await actions.request('/api/telegram/unlink', {
              method: 'POST',
              body: JSON.stringify({ patientId: unlink.dataset.telegramUnlink }),
            });
            await actions.loadPatientTelegram(unlink.dataset.telegramUnlink);
          }
        }
        if (remind) {
          remind.disabled = true;
          await actions.request('/api/telegram/remind', {
            method: 'POST',
            body: JSON.stringify({
              patientId: remind.dataset.telegramPatient,
              appointmentId: remind.dataset.telegramRemind,
            }),
          });
          actions.toast('Напоминание поставлено в очередь');
          await actions.loadPatientTelegram(remind.dataset.telegramPatient);
        }
      } catch (e) {
        actions.toast(e.message);
        if (remind?.isConnected) remind.disabled = false;
      } finally {
        state.busy = false;
        if (link?.isConnected) {
          link.disabled = false;
          const status = link.querySelector('.connection-service-status');
          if (status) status.textContent = 'Подключить';
        }
      }
    });
  }
  return {
    loadPatientTelegram,
    prepareTelegramInvitation,
    syncVisibleTelegram,
    bindTelegramEvents,
    patientConnectionsHtml,
  };
}
