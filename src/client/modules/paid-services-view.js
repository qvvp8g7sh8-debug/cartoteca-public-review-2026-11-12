function createPaidServicesView(state, actions) {
  const money = (kopecks) =>
    Number.isSafeInteger(kopecks)
      ? (BigInt(kopecks) / 100n).toLocaleString('ru-RU') +
        ',' +
        (BigInt(kopecks) % 100n).toString().padStart(2, '0') +
        ' ₽'
      : '—';
  const date = (value) => {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('ru-RU') : '—';
  };
  const terminal = (payment) => ['succeeded', 'canceled', 'rejected'].includes(payment?.status);
  function paymentMessage(payment) {
    if (payment.status === 'succeeded')
      return 'Оплата подтверждена. Состояние пакета показано выше.';
    if (payment.notice) return payment.notice;
    return (
      {
        canceled: 'Оплата отменена. Пакет не подключён.',
        rejected: 'Заказ не создан. Проверьте условия и повторите оплату.',
        review: 'Заказ требует сверки администратором. Не создавайте другую оплату.',
        uncertain: 'Результат создания оплаты уточняется. Проверяйте прежний заказ.',
        creating: 'Оплата создаётся. Не создавайте другой заказ.',
        pending: 'Ожидаем подтверждения оплаты. Доступ появится после подтверждения.',
      }[payment.status] || 'Статус заказа уточняется. Обновите результат этой оплаты.'
    );
  }
  function subscriptionHtml(subscription) {
    if (!subscription?.active)
      return '<section class="paid-package-current"><h4>Активного пакета пока нет</h4><p>Выберите пакет для подключения этой услуги.</p></section>';
    return (
      '<section class="paid-package-current"><div class="paid-service-heading"><h4>' +
      actions.esc(subscription.title) +
      '</h4><span class="paid-service-status" data-enabled="true">' +
      (subscription.source === 'trial'
        ? 'Пробный пакет'
        : subscription.testMode
          ? 'Тестовая оплата'
          : 'Оплачен') +
      '</span></div><p>С ' +
      actions.esc(date(subscription.startsAt)) +
      ' до ' +
      actions.esc(date(subscription.endsAt)) +
      '</p><dl class="paid-package-quota">' +
      (subscription.quotaUnit === 'access'
        ? []
        : [
            [
              subscription.quotaUnit === 'units' ? 'Осталось единиц' : 'Осталось задач',
              subscription.remainingTasks,
            ],
            ['Использовано', subscription.usedTasks],
            ['Выполняется', subscription.reservedTasks],
          ]
      )
        .map(
          ([label, value]) =>
            '<div><dt>' + label + '</dt><dd>' + actions.esc(value) + '</dd></div>',
        )
        .join('') +
      '</dl></section>'
    );
  }
  function checkoutForm(data, packages, blocked = false, service = 'voice-assistant') {
    if (actions.accountRole() !== 'owner')
      return '<p class="form-hint">Покупкой и продлением пакета управляет владелец организации.</p>';
    if (!packages.length) return '';
    return (
      '<form class="paid-package-checkout" data-paid-checkout data-service-code="' +
      actions.esc(service) +
      '"><fieldset' +
      (!data.paymentReady || !data.available || data.subscription?.active || blocked
        ? ' disabled'
        : '') +
      '><legend>Купить пакет</legend><label class="field">Пакет<select name="packageId">' +
      packages
        .map(
          (item) =>
            '<option value="' +
            actions.esc(item.id) +
            '">' +
            actions.esc(item.title + ' · ' + money(item.priceKopecks)) +
            '</option>',
        )
        .join('') +
      '</select></label><label class="field">Почта для чека<input name="receiptEmail" ' +
      'type="email" required maxlength="254" autocomplete="email" value="' +
      actions.esc(state.account?.email || '') +
      '"></label><label class="paid-package-consent"><input type="checkbox" name="acceptTerms" ' +
      'required> Я ознакомился с условиями пакета и согласен с оплатой.</label></fieldset>' +
      '<button class="primary" type="submit"' +
      (!data.paymentReady || !data.available || data.subscription?.active || blocked
        ? ' disabled'
        : '') +
      '>' +
      (data.subscription?.active
        ? 'Пакет уже действует'
        : blocked
          ? 'Проверьте результат прежнего заказа'
          : 'Перейти к оплате') +
      '</button></form>'
    );
  }
  function paidServicesContentHtml(data, selectedPayment, pendingServices) {
    const packages = (data.packages || []).filter((item) => item.enabled);
    const services = data.services || [
      { code: 'voice-assistant', title: 'Голосовой помощник', subscription: data.subscription },
    ];
    const orders = data.orders || [];
    return (
      '<div class="paid-services">' +
      services
        .map((service) => {
          const subscription = service.subscription,
            offers = packages.filter(
              (item) => (item.serviceCode || 'voice-assistant') === service.code,
            );
          const payment =
            (selectedPayment?.package?.serviceCode || 'voice-assistant') === service.code &&
            selectedPayment
              ? selectedPayment
              : orders.find(
                  (item) =>
                    (item.package?.serviceCode || 'voice-assistant') === service.code &&
                    !terminal(item),
                );
          const operation = pendingServices.get(service.code);
          return (
            '<section class="paid-service-group" data-paid-service="' +
            actions.esc(service.code) +
            '"><h3>' +
            actions.esc(service.title) +
            '</h3>' +
            subscriptionHtml(subscription) +
            (subscription?.active
              ? '<button type="button" class="secondary" data-paid-toggle="' +
                actions.esc(service.code) +
                '" data-revision="' +
                actions.esc(subscription.connectionRevision || 0) +
                '" data-enabled="' +
                Boolean(subscription.enabled) +
                '">' +
                (subscription.enabled ? 'Приостановить услугу' : 'Возобновить услугу') +
                '</button>'
              : '') +
            '<div class="paid-package-catalog">' +
            offers
              .map(
                (item) =>
                  '<article class="paid-service"><h4>' +
                  actions.esc(item.title) +
                  '</h4><p class="paid-package-price">' +
                  actions.esc(money(item.priceKopecks)) +
                  '</p><p>' +
                  actions.esc(item.periodMonths || 1) +
                  ' мес. · ' +
                  (item.quotaUnit === 'access'
                    ? 'Доступ на срок'
                    : actions.esc(item.taskLimit) +
                      ' ' +
                      (item.quotaUnit === 'units' ? 'единиц' : 'задач')) +
                  '</p></article>',
              )
              .join('') +
            '</div>' +
            (payment && !terminal(payment)
              ? '<p>' +
                actions.esc(paymentMessage(payment)) +
                '</p><button type="button" class="secondary" data-paid-check-order="' +
                actions.esc(payment.checkoutId || payment.id) +
                '">Проверить прежний заказ</button>'
              : '') +
            checkoutForm(
              { ...data, subscription },
              offers,
              Boolean((payment && !terminal(payment)) || operation),
              service.code,
            ) +
            '</section>'
          );
        })
        .join('') +
      (!packages.length ? '<p>Пакеты пока не опубликованы.</p>' : '') +
      '<section class="paid-package-rules"><h4>Как работает оплата</h4><p>Каждая услуга имеет свой срок и лимит. Остаток не переносится. Продление — новой оплатой, без автоматического списания. Уточнения внутри одной задачи помощника бесплатны.</p></section>' +
      (!data.paymentReady
        ? '<p class="paid-package-notice">Приём оплат ещё не подключён.</p>'
        : '') +
      (data.paymentNotice
        ? '<p class="form-hint">' + actions.esc(data.paymentNotice) + '</p>'
        : '') +
      '<p class="form-hint">Данные карты вводятся только на защищённой странице ЮKassa. Картотека их не получает. Почта используется для чека.</p>' +
      (orders.length
        ? '<details><summary>История покупок</summary><ul>' +
          orders
            .map(
              (order) =>
                '<li>' +
                actions.esc(
                  date(order.createdAt) +
                    ' · ' +
                    order.package.title +
                    ' · ' +
                    money(order.package.priceKopecks),
                ) +
                '<p>' +
                actions.esc(paymentMessage(order)) +
                '</p><p>' +
                actions.esc(
                  'Чек: ' +
                    ({
                      succeeded: 'зарегистрирован',
                      pending: 'в обработке',
                      canceled: 'ошибка регистрации',
                    }[order.receiptRegistration] || 'статус уточняется'),
                ) +
                (order.refund?.knownRefundedKopecks
                  ? ' · Возвращено: ' + actions.esc(money(order.refund.knownRefundedKopecks))
                  : '') +
                '</p><button type="button" class="text-btn" data-paid-check-order="' +
                actions.esc(order.checkoutId || order.id) +
                '">Проверить оплату и чек</button></li>',
            )
            .join('') +
          '</ul></details>'
        : '') +
      '<p role="status" aria-live="polite" data-paid-message></p><button type="button" class="secondary" data-paid-refresh>Обновить пакеты и статус оплаты</button></div>'
    );
  }
  return { paidServicesContentHtml, paidPaymentMessage: paymentMessage, paidPriceText: money };
}
