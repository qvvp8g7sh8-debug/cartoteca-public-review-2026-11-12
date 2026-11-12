function createAdminBilling({ $, request, records, message, changeView }) {
  const view = createAdminBillingView({ records }),
    review = createAdminPaymentReviewView({ records }),
    pending = new Map(),
    readLocks = new Map(),
    forms =
      '[data-admin-package-form], [data-admin-package-trial], [data-admin-package-payments], [data-admin-payment-review], [data-admin-financial-action], [data-admin-financial-check]';
  let generation = 0,
    overviewGeneration = 0,
    organizationId = null,
    bound = false;
  const content = () => $('#admin-billing-content');
  const active = () => !content()?.closest('[hidden]');
  const dirty = () => content()?.querySelector('[data-dirty]');
  const navigation = createAdminBillingNavigation({ content, scope: () => organizationId });
  const pages = createAdminBillingPages({
    request,
    view,
    content,
    isCurrent: (serial) => serial === generation && active(),
    restorePending,
    message,
  });
  function key(form) {
    if (form.hasAttribute('data-admin-financial-action'))
      return 'finance:' + form.dataset.checkoutId;
    if (form.hasAttribute('data-admin-financial-check'))
      return 'finance-check:' + form.dataset.actionId;
    if (form.hasAttribute('data-admin-payment-review')) return 'review:' + form.dataset.checkoutId;
    if (form.hasAttribute('data-admin-package-payments')) return 'payments';
    if (form.hasAttribute('data-admin-package-trial'))
      return 'trial:' + (form.dataset.organizationId || 'all');
    return 'package:' + (form.dataset.packageId || 'new');
  }
  function result(form, text, error = false) {
    const node = form.querySelector('[data-admin-billing-message]');
    node.textContent = text;
    node.dataset.status = error ? 'error' : 'success';
  }
  function restorePending() {
    for (const form of content().querySelectorAll(forms)) {
      const operation = pending.get(key(form));
      if (!operation?.unknown) continue;
      for (const [name, value] of Object.entries({
        ...operation.body,
        ...operation.body.receiptConfig,
      })) {
        if (name === 'secretKey') continue;
        const field = form.elements.namedItem(name);
        if (!field) continue;
        if (field.type === 'checkbox') field.checked = value === true;
        else field.value = value ?? '';
      }
      form.dataset.dirty = '1';
      form.querySelector('fieldset').disabled = true;
      form.querySelector('[type="submit"]').textContent = 'Повторить прежнее действие';
      form.closest('details')?.setAttribute('open', '');
      result(form, 'Ответ не получен. Повтор сохранит прежний номер операции.', true);
    }
  }
  async function loadOverview() {
    const node = $('#admin-overview-billing'),
      serial = ++overviewGeneration;
    if (!node || node.closest('[hidden]')?.dataset.adminSection) return;
    try {
      const data = await request('/api/admin/billing/summary');
      if (serial === overviewGeneration && node.isConnected)
        node.innerHTML = view.summaryHtml(data, { compact: true });
    } catch (error) {
      if (serial === overviewGeneration && node.isConnected) node.textContent = error.message;
    }
  }
  async function load({ organizationId: target = null, discard = false } = {}) {
    const root = content();
    if (!root) return;
    if (root.querySelector('[data-busy]')) {
      message('Дождитесь результата выполняющегося действия.');
      return;
    }
    if (dirty() && !discard && !confirm('Перечитать пакеты без сохранения введённых изменений?'))
      return;
    const serial = ++generation;
    organizationId = target || null;
    for (const field of root.querySelectorAll('fieldset')) {
      if (!readLocks.has(field)) readLocks.set(field, field.disabled);
      field.disabled = true;
    }
    root.setAttribute('aria-busy', 'true');
    $('#admin-billing-summary').textContent = 'Загружаем пакеты…';
    try {
      const data = await request(
        '/api/admin/billing' +
          (organizationId ? '?organizationId=' + encodeURIComponent(organizationId) : ''),
      );
      if (serial !== generation || !root.isConnected || !active()) return;
      const item = data.organizations?.find((entry) => entry.organizationId === organizationId);
      const organization = organizationId
        ? data.organization || {
            id: organizationId,
            name: item?.organizationName || 'Выбранный кабинет',
          }
        : null;
      root.innerHTML =
        (organizationId
          ? '<button type="button" class="text-btn" data-admin-billing-back>← Все пакеты и кабинеты</button>'
          : '') +
        view.renderBillingAdminHtml(
          {
            ...data,
            subscription: data.subscription || item?.subscription,
          },
          organization,
        );
      $('#admin-billing-summary').textContent = organization
        ? 'Кабинет: ' + organization.name
        : data.paymentConfiguration?.notice ||
          (data.paymentConfiguration?.ready
            ? 'Приём оплат настроен. Клиенты покупают месячные пакеты без автоматического продления.'
            : 'Приём оплат ещё не подключён. Можно создать пакеты и предоставить пробный доступ.');
      for (const form of root.querySelectorAll('[data-admin-package-form]'))
        updatePackageFields(form);
      restorePending();
      pages.init(data, organizationId, serial);
      navigation.restore();
    } catch (error) {
      if (serial === generation && root.isConnected)
        $('#admin-billing-summary').textContent = error.message;
    } finally {
      if (serial === generation && root.isConnected) {
        root.removeAttribute('aria-busy');
        for (const [field, disabled] of readLocks) if (field.isConnected) field.disabled = disabled;
        readLocks.clear();
      }
    }
  }
  function operationFor(form) {
    const existing = pending.get(key(form));
    if (existing?.unknown) return existing;
    const values = new FormData(form),
      text = (name) => String(values.get(name) || '').trim(),
      common = { requestId: window.crypto.randomUUID(), reason: text('reason') };
    if (form.hasAttribute('data-admin-financial-check'))
      return {
        route: '/api/admin/billing/financial-action-check',
        kind: 'review',
        body: {
          id: form.dataset.actionId,
          ...(text('referenceId')
            ? { referenceId: text('referenceId'), reason: common.reason }
            : {}),
        },
      };
    if (form.hasAttribute('data-admin-financial-action')) {
      const amount = text('amountRub');
      if (text('kind') === 'refund' && !/^\d+(?:[.,]\d{1,2})?$/.test(amount))
        throw Error('Укажите сумму возврата с точностью до копеек.');
      const [whole = '0', part = ''] = amount.replace(',', '.').split('.');
      const kopecks = BigInt(whole || '0') * 100n + BigInt(part.padEnd(2, '0'));
      if (kopecks > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Сумма слишком велика.');
      return {
        route: '/api/admin/billing/financial-action',
        kind: 'review',
        body: {
          ...common,
          checkoutId: form.dataset.checkoutId,
          expectedRevision: Number(form.dataset.revision),
          kind: text('kind'),
          amountKopecks: Number(kopecks),
          receiptEmail: text('receiptEmail'),
          accessPolicy: text('accessPolicy'),
          serviceProvided: values.has('serviceProvided'),
        },
      };
    }
    if (form.hasAttribute('data-admin-payment-review')) return review.operation(form, common);
    if (form.hasAttribute('data-admin-package-trial'))
      return {
        route: '/api/admin/billing/trial',
        kind: 'trial',
        body: {
          ...common,
          organizationId: text('organizationId'),
          packageId: text('packageId'),
        },
      };
    if (form.hasAttribute('data-admin-package-payments')) {
      const secret = text('secretKey');
      if (secret && values.has('clearSecret'))
        throw Error('Введите новый ключ или выберите удаление.');
      return {
        route: '/api/admin/billing/payment-settings',
        kind: 'payments',
        body: {
          ...common,
          expectedRevision: Number(form.dataset.revision),
          configured: values.has('configured'),
          testMode: values.has('testMode'),
          shopId: text('shopId'),
          returnOrigin: text('returnOrigin'),
          ...(secret ? { secretKey: secret } : {}),
          ...(values.has('clearSecret') ? { clearSecret: true } : {}),
          receiptConfig: {
            fiscalProvider: text('fiscalProvider'),
            purchaseModel: 'package',
            paymentMode: text('paymentMode'),
            paymentSubject: text('paymentSubject'),
            vatCode: text('vatCode') === '' ? null : Number(text('vatCode')),
            taxSystemCode: text('taxSystemCode') === '' ? null : Number(text('taxSystemCode')),
            description: text('description'),
          },
        },
      };
    }
    return {
      route: '/api/admin/billing/package',
      kind: 'package',
      body: {
        ...common,
        expectedRevision: Number(form.dataset.revision),
        id: text('id') || window.crypto.randomUUID(),
        title: text('title'),
        priceRub: text('priceRub'),
        taskLimit: text('quotaUnit') === 'access' ? 1 : Number(text('taskLimit')),
        ...(values.has('serviceCode')
          ? {
              serviceCode:
                text('serviceCode') === 'new'
                  ? 'service-' + window.crypto.randomUUID()
                  : text('serviceCode'),
              serviceTitle: text('serviceTitle'),
              periodMonths: Number(text('periodMonths')),
              quotaUnit: text('quotaUnit'),
              receipt: {
                description: text('receiptDescription'),
                paymentMode: text('receiptPaymentMode'),
                paymentSubject: text('receiptPaymentSubject'),
                vatCode: text('receiptVatCode') === '' ? null : Number(text('receiptVatCode')),
              },
            }
          : {}),
        enabled: values.has('enabled'),
      },
    };
  }
  async function submit(form) {
    if (
      form.dataset.busy ||
      content()?.hasAttribute('aria-busy') ||
      form.closest('.paid-package-orders[aria-busy]')
    )
      return;
    const known = pending.get(key(form));
    if (!known?.unknown && !form.reportValidity()) return;
    let operation;
    try {
      operation = operationFor(form);
    } catch (error) {
      result(form, error.message, true);
      return;
    }
    if (
      !known?.unknown &&
      !confirm(
        operation.kind === 'review'
          ? form.hasAttribute('data-admin-financial-action')
            ? 'Подтвердить финансовую операцию? Возврат отправит указанную сумму, чек — данные в кассу. Другие услуги не изменятся.'
            : 'Выполнить выбранное действие по заказу? Заявка на проверку сама не возвращает деньги и не создаёт чек.'
          : operation.kind === 'trial'
            ? 'Предоставить этому кабинету выбранный пробный пакет без оплаты?'
            : operation.kind === 'payments'
              ? 'Сохранить настройки приёма оплат? Проверьте тестовый или рабочий режим.'
              : 'Сохранить услугу, срок, цену и лимит пакета для последующих покупок?',
      )
    )
      return;
    const capturedGeneration = generation,
      capturedOrganization = organizationId,
      button = form.querySelector('[type="submit"]'),
      fields = form.querySelector('fieldset');
    pending.set(key(form), operation);
    form.dataset.busy = '1';
    form.dataset.dirty = '1';
    fields.disabled = true;
    button.disabled = true;
    result(form, 'Сохраняем…');
    try {
      const response = await request(operation.route, {
        method: 'POST',
        body: JSON.stringify(operation.body),
      });
      const financial =
        form.hasAttribute('data-admin-financial-action') ||
        form.hasAttribute('data-admin-financial-check');
      if (
        response.operation?.status === 'pending' ||
        (financial && ['creating', 'uncertain', 'review'].includes(response.operation?.status))
      ) {
        operation.unknown = true;
        if (form.isConnected && capturedGeneration === generation)
          result(
            form,
            response.operation.notice ||
              (financial && response.operation.status === 'review'
                ? 'Нужна сверка существующего объекта в ЮKassa. Новый возврат не создавайте.'
                : '') ||
              response.notice ||
              'Действие ещё выполняется. Повтор проверьте прежним номером операции.',
            true,
          );
        return;
      }
      pending.delete(key(form));
      operation.unknown = false;
      if (!form.isConnected || capturedGeneration !== generation) return;
      delete form.dataset.dirty;
      result(
        form,
        operation.kind === 'trial' ? 'Пробный пакет подключён.' : 'Изменения сохранены.',
      );
      message(
        operation.kind === 'review'
          ? response.operation?.notice ||
              (financial
                ? {
                    succeeded: 'Финансовая операция подтверждена.',
                    canceled: 'Финансовая операция отменена провайдером.',
                    rejected: 'Провайдер отклонил финансовую операцию.',
                  }[response.operation?.status] || 'Статус финансовой операции обновлён.'
                : 'Проверка заказа завершена.')
          : operation.kind === 'trial'
            ? 'Пробный пакет подключён.'
            : 'Настройки пакетов сохранены.',
      );
      if (!dirty() && active()) {
        delete form.dataset.busy;
        await load({ organizationId: capturedOrganization, discard: true });
      }
    } catch (error) {
      operation.unknown = Boolean(error.unknown || error.outcomeUnknown);
      if (!operation.unknown) pending.delete(key(form));
      if (!form.isConnected || capturedGeneration !== generation) return;
      if (operation.unknown) form.dataset.dirty = '1';
      result(
        form,
        operation.unknown
          ? 'Ответ не получен. Повторите прежнее действие, чтобы проверить результат.'
          : error.status === 409
            ? 'Условия изменились. Перечитайте раздел перед сохранением.'
            : error.message,
        true,
      );
    } finally {
      if (form.isConnected) {
        const secret = form.querySelector('[name="secretKey"]');
        if (secret) secret.value = '';
        delete form.dataset.busy;
        fields.disabled = Boolean(operation.unknown);
        button.disabled = false;
        if (operation.unknown) button.textContent = 'Повторить прежнее действие';
      }
    }
  }
  function updatePackageFields(form) {
    const service = form.elements.namedItem('serviceCode'),
      unit = form.elements.namedItem('quotaUnit');
    if (!service || !unit) return;
    if (form.dataset.packageId)
      for (const option of service.options) option.disabled = option.value !== service.value;
    const voice = service.value === 'voice-assistant',
      period = form.elements.namedItem('periodMonths');
    if (voice) {
      unit.value = 'tasks';
      period.value = '1';
    }
    period.readOnly = voice;
    for (const option of unit.options)
      if (option.value && option.value !== 'tasks') option.disabled = voice;
    const quota = form.elements.namedItem('taskLimit'),
      label = form.elements.namedItem('serviceTitle');
    quota.closest('label').hidden = unit.value === 'access';
    quota.disabled = unit.value === 'access';
    if (label) {
      label.closest('label').hidden = service.value !== 'new';
      label.required = service.value === 'new';
    }
  }
  function bind() {
    if (bound) return;
    bound = true;
    navigation.bind();
    pages.bind();
    $('#admin-billing-refresh')?.addEventListener('click', () => {
      void load({ organizationId });
    });
    document.addEventListener('click', (event) => {
      const target = event.target.closest?.('[data-admin-billing-organization]');
      if (target) void changeView('billing', target.dataset.adminBillingOrganization);
      if (event.target.closest?.('[data-admin-billing-back]')) void changeView('billing');
    });
    for (const type of ['input', 'change'])
      document.addEventListener(type, (event) => {
        const form = event.target.closest?.(forms);
        if (form) {
          form.dataset.dirty = '1';
          if (form.hasAttribute('data-admin-package-form')) updatePackageFields(form);
        }
      });
    document.addEventListener('submit', (event) => {
      const form = event.target.closest?.(forms);
      if (!form) return;
      event.preventDefault();
      void submit(form);
    });
    window.addEventListener('beforeunload', (event) => {
      if (!dirty() && ![...pending.values()].some((operation) => operation.unknown)) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }
  return { load, loadOverview, bind };
}
