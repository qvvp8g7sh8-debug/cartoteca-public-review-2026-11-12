function createAdminBillingPagesView({ records, subscriptionHtml }) {
  const { esc, date } = records,
    review = createAdminPaymentReviewView({ records });
  const money = createAdminBillingMoney();
  function organizationRowsHtml(items) {
    return items
      .map(
        (item) =>
          '<article class="admin-billing-organization" data-billing-organization-id="' +
          esc(item.organizationId) +
          '"><h4>' +
          esc(item.organizationName) +
          '</h4>' +
          subscriptionHtml(item) +
          '<p>Подтверждённые оплаты: ' +
          esc(money.format(item.paidKopecks, 100n, item.paidRub)) +
          ' · Расчётные расходы: ' +
          esc(money.format(item.costMicrorub, 1000000n, item.costRub)) +
          '</p><button type="button" class="text-btn" data-admin-billing-organization="' +
          esc(item.organizationId) +
          '">Открыть услуги кабинета</button></article>',
      )
      .join('');
  }
  function organizations(data) {
    const items = data.organizations || [];
    return (
      '<section class="admin-billing-directory"><h4>Кабинеты</h4><p class="form-hint" data-billing-organization-count>Показано ' +
      items.length +
      (Number.isSafeInteger(data.organizationTotal) ? ' из ' + data.organizationTotal : '') +
      '</p><div class="admin-billing-organizations" data-billing-organization-list>' +
      (organizationRowsHtml(items) || '<p>Кабинеты пока не созданы.</p>') +
      '</div>' +
      '<p role="status" data-billing-organization-message></p><button type="button" class="secondary" data-billing-organization-more' +
      (data.nextOffset == null ? ' hidden' : '') +
      '>Показать ещё 20 кабинетов</button></section>'
    );
  }
  function orderRowsHtml(items) {
    return items
      .map(
        (item) =>
          '<li data-admin-order-id="' +
          esc(item.checkoutId || item.id) +
          '"><div><strong>' +
          esc(item.title || item.package?.title || 'Пакет') +
          '</strong><small>' +
          esc(item.package?.serviceTitle || '') +
          '</small><small>' +
          esc(date(item.time || item.createdAt)) +
          ' · ' +
          esc(
            {
              succeeded: item.testMode ? 'Тестовая оплата' : 'Оплачено',
              pending: 'Ожидаем оплату',
              creating: 'Создаётся',
              uncertain: 'Результат уточняется',
              review: 'Требует сверки',
              rejected: 'Не создано',
              canceled: 'Отменено',
              trial: 'Пробный доступ',
            }[item.status] ||
              item.status ||
              '',
          ) +
          '</small><small>Заказ: ' +
          esc(item.checkoutId || item.id) +
          '</small></div><span>' +
          esc(
            money.format(
              Number.isSafeInteger(item.priceKopecks ?? item.package?.priceKopecks)
                ? String(item.priceKopecks ?? item.package?.priceKopecks)
                : null,
              100n,
            ),
          ) +
          '</span>' +
          review.render(item) +
          '</li>',
      )
      .join('');
  }
  function orders(data) {
    const items = data.orders || [];
    return (
      '<section class="paid-package-orders"><h4>Заказы и оплаты</h4>' +
      '<form class="admin-billing-history-filter" data-billing-orders-filter><label class="field">Состояние<select name="status">' +
      [
        ['all', 'Все заказы'],
        ['attention', 'Требуют сверки'],
        ['pending', 'Ожидают результата'],
        ['paid', 'Оплата подтверждена'],
        ['canceled', 'Отменённые'],
        ['rejected', 'Не созданные'],
      ]
        .map(([value, label]) => '<option value="' + value + '">' + label + '</option>')
        .join('') +
      '</select></label>' +
      (data.services?.length > 1
        ? '<label class="field">Услуга<select name="serviceCode"><option value="">Все услуги</option>' +
          data.services
            .map(
              (service) =>
                '<option value="' + esc(service.code) + '">' + esc(service.title) + '</option>',
            )
            .join('') +
          '</select></label>'
        : '') +
      '<label class="field">ID заказа или оплаты<input name="q" type="search" maxlength="36" autocomplete="off" placeholder="Полный UUID" ' +
      'pattern="[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}" title="Введите полный идентификатор заказа или оплаты"></label>' +
      '<button type="submit" class="secondary">Найти</button><button type="button" class="text-btn" data-billing-orders-reset>Сбросить фильтры</button></form>' +
      '<p class="form-hint" data-billing-orders-count>Показано заказов: ' +
      items.length +
      '</p>' +
      '<p role="status" data-billing-orders-message></p><ol data-billing-orders-list>' +
      orderRowsHtml(items) +
      '</ol>' +
      '<p class="form-hint" data-billing-orders-empty' +
      (items.length ? ' hidden' : '') +
      '>По этим условиям заказов нет.</p>' +
      '<button type="button" class="secondary" data-billing-orders-more' +
      (data.ordersNextCursor ? '' : ' hidden') +
      '>Показать ещё 50 заказов</button></section>'
    );
  }
  return { organizationRowsHtml, organizations, orderRowsHtml, orders };
}
