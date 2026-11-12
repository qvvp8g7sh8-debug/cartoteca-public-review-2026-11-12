function createPaidServices(state, actions) {
  const entries = new WeakMap(),
    operations = new Map(),
    selector = '#paid-services-settings';
  let bound = false;
  const identity = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const operationKey = (entry, service = 'voice-assistant') => entry.identity + '\u0000' + service;
  const terminal = (payment) => ['succeeded', 'canceled', 'rejected'].includes(payment?.status);
  function finishKnownOperation(entry, payment) {
    const returnedId = payment?.checkoutId || payment?.id;
    if (!terminal(payment) || !returnedId) return;
    for (const [key, operation] of operations)
      if (
        key.startsWith(entry.identity + '\u0000') &&
        (operation.result?.checkoutId || operation.result?.id) === returnedId
      )
        operations.delete(key);
  }
  function paidServicesSettingsHtml() {
    if (!state.multiUser || actions.accountRole() !== 'owner') return '';
    return actions.settingsSectionHtml(
      'Пакеты и оплата',
      'paid-services-settings',
      '<div class="paid-services"><p>Услуги, подключённые к вашей организации.</p><p role="status" data-paid-message>Откройте раздел, чтобы посмотреть пакет и доступные задачи.</p><button type="button" class="secondary" data-paid-refresh>Обновить</button></div>',
    );
  }
  function entryFor(root) {
    let entry = entries.get(root);
    if (!entry || entry.account !== state.account || entry.identity !== identity()) {
      entry?.controller?.abort();
      entry = { account: state.account, identity: identity(), generation: 0, snapshot: null };
      entries.set(root, entry);
    }
    return entry;
  }
  function current(root, entry) {
    return (
      root.isConnected &&
      actions.$(selector) === root &&
      state.account === entry.account &&
      identity() === entry.identity &&
      state.sessionReady !== false
    );
  }
  function visible(root, entry) {
    return (
      current(root, entry) &&
      state.currentView === 'settings' &&
      !document.hidden &&
      !root.closest('[hidden], details:not([open])')
    );
  }
  function message(root, text, error = false) {
    const node = root.querySelector('[data-paid-message]');
    if (!node) return;
    node.textContent = text;
    node.dataset.status = error ? 'error' : '';
  }
  function render(root, entry) {
    const pendingServices = new Map();
    for (const service of entry.snapshot.services || [{ code: 'voice-assistant' }])
      pendingServices.set(service.code, operations.get(operationKey(entry, service.code)));
    root.innerHTML = actions.paidServicesContentHtml(
      entry.snapshot,
      entry.payment,
      pendingServices,
    );
    for (const form of root.querySelectorAll('[data-paid-checkout]')) {
      const operation = operations.get(operationKey(entry, form.dataset.serviceCode));
      if (!operation) continue;
      form.elements.packageId.value = operation.body.packageId;
      form.elements.receiptEmail.value = operation.body.receiptEmail;
      form.elements.acceptTerms.checked = true;
      form.querySelector('fieldset').disabled = true;
      const button = form.querySelector('[type="submit"]');
      button.disabled = false;
      button.textContent =
        operation.result?.status === 'pending' && operation.result.confirmationUrl
          ? 'Продолжить оплату'
          : 'Проверить прежний заказ';
      message(root, 'Незавершённый запрос оплаты. Повтор сохранит прежний номер операции.', true);
    }
  }
  async function load(root, selectedCheckoutId = null) {
    const entry = entryFor(root);
    if (!visible(root, entry) || entry.busy) return;
    entry.controller?.abort();
    const controller = new AbortController(),
      generation = ++entry.generation,
      checkoutId =
        selectedCheckoutId ||
        new URLSearchParams(location.search).get('checkoutId') ||
        new URLSearchParams(location.search).get('payment') ||
        [...operations].find(([key]) => key.startsWith(entry.identity + '\u0000'))?.[1]?.result
          ?.checkoutId;
    entry.controller = controller;
    root.setAttribute('aria-busy', 'true');
    message(root, 'Загружаем пакет…');
    try {
      let payment = null;
      if (checkoutId && /^[a-f0-9-]{36}$/i.test(checkoutId))
        payment = await actions.request(
          '/api/billing/payment?id=' + encodeURIComponent(checkoutId),
          {
            signal: controller.signal,
          },
        );
      if (!visible(root, entry) || generation !== entry.generation) return;
      const data = await actions.request('/api/billing', { signal: controller.signal });
      if (!visible(root, entry) || generation !== entry.generation) return;
      entry.snapshot = data;
      entry.payment = payment;
      finishKnownOperation(entry, payment);
      render(root, entry);
      if (
        payment?.status === 'succeeded' &&
        (payment.package?.serviceCode || 'voice-assistant') === 'voice-assistant'
      ) {
        message(root, 'Оплата подтверждена. Состояние пакета показано выше.');
        const scope = await actions
          .request('/api/assistant/scope', {
            signal: controller.signal,
            assistantRequest: true,
          })
          .catch(() => null);
        if (scope && current(root, entry) && generation === entry.generation)
          actions.applyAssistantScope(scope);
      } else if (payment)
        message(
          root,
          actions.paidPaymentMessage(payment),
          ['review', 'rejected', 'uncertain'].includes(payment.status),
        );
    } catch (error) {
      if (visible(root, entry) && generation === entry.generation && !controller.signal.aborted)
        message(root, error.message, true);
    } finally {
      if (current(root, entry) && generation === entry.generation) {
        root.removeAttribute('aria-busy');
        entry.controller = null;
      }
    }
  }
  async function checkout(root, form) {
    const entry = entryFor(root);
    if (!visible(root, entry) || entry.busy || actions.accountRole() !== 'owner') return;
    const service = form.dataset.serviceCode || 'voice-assistant',
      key = operationKey(entry, service);
    let operation = operations.get(key);
    if (!operation) {
      if (
        entry.payment &&
        !terminal(entry.payment) &&
        (entry.payment.package?.serviceCode || 'voice-assistant') === service
      )
        return;
      if (!entry.snapshot?.paymentReady || !entry.snapshot.available || !form.reportValidity())
        return;
      const values = new FormData(form),
        selected = entry.snapshot.packages.find((item) => item.id === values.get('packageId'));
      if (!selected?.enabled) return;
      operation = {
        body: {
          packageId: selected.id,
          packageVersion: selected.version,
          requestId: window.crypto.randomUUID(),
          receiptEmail: String(values.get('receiptEmail')).trim(),
          acceptedTermsVersion: entry.snapshot.termsVersion,
        },
      };
      entry.busy = true;
      const confirmed = await actions.confirmAction(
        'Перейти к оплате пакета?',
        selected.title +
          ': ' +
          actions.paidPriceText(selected.priceKopecks) +
          ' на ' +
          (selected.periodMonths || 1) +
          ' мес., ' +
          (selected.quotaUnit === 'access' ? 'доступ на срок' : selected.taskLimit + ' единиц') +
          '. Автоматического продления нет.',
        'Перейти к оплате',
      );
      entry.busy = false;
      if (!confirmed || !visible(root, entry)) return;
      operations.set(key, operation);
    }
    entry.controller?.abort();
    entry.generation++;
    entry.busy = true;
    render(root, entry);
    form = [...root.querySelectorAll('[data-paid-checkout]')].find(
      (item) => (item.dataset.serviceCode || 'voice-assistant') === service,
    );
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    message(root, 'Готовим оплату…');
    try {
      operation.result = await actions.request('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify(operation.body),
      });
      if (!visible(root, entry)) return;
      if (terminal(operation.result)) {
        finishKnownOperation(entry, operation.result);
        entry.busy = false;
        await load(root);
        if (operation.result.status === 'succeeded' && service === 'voice-assistant') {
          const scope = await actions
            .request('/api/assistant/scope', {
              assistantRequest: true,
            })
            .catch(() => null);
          if (scope && current(root, entry)) actions.applyAssistantScope(scope);
        }
        if (visible(root, entry))
          message(
            root,
            actions.paidPaymentMessage(operation.result),
            operation.result.status === 'rejected',
          );
        return;
      }
      if (operation.result.status !== 'pending' || !operation.result.confirmationUrl) {
        render(root, entry);
        message(
          root,
          actions.paidPaymentMessage(operation.result),
          ['review', 'uncertain'].includes(operation.result.status),
        );
        return;
      }
      const confirmation = new URL(operation.result.confirmationUrl);
      if (
        confirmation.protocol !== 'https:' ||
        confirmation.username ||
        confirmation.password ||
        confirmation.hostname !== 'yoomoney.ru' ||
        confirmation.port ||
        confirmation.hash ||
        !(
          confirmation.pathname.startsWith('/checkout/payments/') ||
          confirmation.pathname === '/api-pages/v2/payment-confirm/epl'
        )
      )
        throw Error('Не удалось получить защищённую ссылку оплаты. Обновите статус пакета.');
      actions.toast('Открываем страницу оплаты.');
      location.assign(confirmation.href);
    } catch (error) {
      if (error.outcomeUnknown) operation.uncertain = true;
      if (!error.outcomeUnknown && !operation.result && !operation.uncertain)
        operations.delete(key);
      if (current(root, entry)) {
        render(root, entry);
        message(
          root,
          error.outcomeUnknown
            ? 'Ответ не получен. Повторите прежний запрос, чтобы избежать повторного платежа.'
            : operation.uncertain
              ? error.message + ' Результат прежнего заказа пока неизвестен. Проверяйте только его.'
              : error.message,
          true,
        );
      }
    } finally {
      entry.busy = false;
      if (button.isConnected) button.disabled = false;
      if (current(root, entry)) root.removeAttribute('aria-busy');
    }
  }
  async function toggleService(root, button) {
    const entry = entryFor(root),
      code = button.dataset.paidToggle;
    if (!visible(root, entry) || entry.busy || actions.accountRole() !== 'owner') return;
    entry.connectionOperations ||= new Map();
    let operation = entry.connectionOperations.get(code);
    if (!operation) {
      operation = {
        serviceCode: code,
        enabled: button.dataset.enabled !== 'true',
        expectedRevision: Number(button.dataset.revision),
        requestId: window.crypto.randomUUID(),
      };
      entry.connectionOperations.set(code, operation);
    }
    entry.busy = true;
    button.disabled = true;
    try {
      const data = await actions.request('/api/billing/services/connection', {
        method: 'POST',
        body: JSON.stringify(operation),
      });
      if (!current(root, entry)) return;
      entry.connectionOperations.delete(code);
      entry.snapshot = data;
      render(root, entry);
      message(
        root,
        operation.enabled
          ? 'Услуга возобновлена.'
          : 'Услуга приостановлена. Другие подключения сохранены.',
      );
      if (code === 'voice-assistant') {
        const scope = await actions
          .request('/api/assistant/scope', { assistantRequest: true })
          .catch(() => null);
        if (scope && current(root, entry)) actions.applyAssistantScope(scope);
      }
    } catch (error) {
      if (!error.unknown && !error.outcomeUnknown) entry.connectionOperations.delete(code);
      if (current(root, entry)) message(root, error.message, true);
    } finally {
      entry.busy = false;
      if (button.isConnected) button.disabled = false;
    }
  }
  function bindPaidServicesEvents() {
    if (bound) return;
    bound = true;
    document.addEventListener(
      'toggle',
      (event) => {
        const root = event.target.querySelector?.(selector);
        if (!root || !event.target.matches('details.settings-tile')) return;
        if (event.target.open) void load(root);
        else entryFor(root).controller?.abort();
      },
      true,
    );
    document.addEventListener('click', (event) => {
      const root = event.target.closest?.(selector);
      if (root && event.target.closest('[data-paid-refresh]')) void load(root);
      const order = event.target.closest?.('[data-paid-check-order]');
      if (root && order) void load(root, order.dataset.paidCheckOrder);
      const toggle = event.target.closest?.('[data-paid-toggle]');
      if (root && toggle) void toggleService(root, toggle);
    });
    document.addEventListener('submit', (event) => {
      const form = event.target.closest?.('[data-paid-checkout]');
      if (!form) return;
      event.preventDefault();
      void checkout(form.closest(selector), form);
    });
    const cancel = () => {
      const root = actions.$(selector);
      if (root) entryFor(root).controller?.abort();
    };
    window.addEventListener('pagehide', cancel);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancel();
    });
  }
  return { paidServicesSettingsHtml, bindPaidServicesEvents };
}
