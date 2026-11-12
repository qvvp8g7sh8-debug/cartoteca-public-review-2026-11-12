function createAdminPaymentReviewView({ records }) {
  const { esc, date } = records;
  const money = createAdminBillingMoney();
  const statuses = {
    pending: 'Ожидается результат',
    blocked: 'Нужна настройка или ручная проверка',
    manual_review: 'Нужна ручная проверка',
    requested: 'Заявка на проверку',
    succeeded: 'Подтверждено',
    done: 'Проверено',
    canceled: 'Отменено',
    unknown: 'Результат уточняется',
    required: 'Нужна сверка',
    not_required: 'Сверка не требуется',
    checked: 'Проверено',
    review_required: 'Заявка на проверку',
    observed_succeeded: 'Подтверждён существующий возврат',
    not_requested: 'Заявок нет',
    not_checked: 'Не проверялся',
  };
  const actions = {
    reconcile: 'Сверить оплату с ЮKassa',
    retry_create: 'Повторить создание прежнего заказа',
    request_refund_review: 'Заявка на проверку возврата',
    request_receipt_review: 'Заявка на проверку закрывающего чека',
    check_refund: 'Проверить существующий возврат',
    check_receipt: 'Проверить существующий чек',
  };
  function state(label, value) {
    if (!value) return '';
    return (
      '<p><strong>' +
      label +
      ':</strong> ' +
      esc(statuses[value.status] || value.status || 'Нет сведений') +
      (value.checkedAt ? ' · ' + esc(date(value.checkedAt)) : '') +
      '</p>'
    );
  }
  function financialForm(item) {
    const rows = (item.financialActions || [])
      .map(
        (action) =>
          '<article><p>' +
          esc(action.kind === 'refund' ? 'Возврат' : 'Чек зачёта') +
          ' · ' +
          esc(statuses[action.status] || action.status) +
          ' · ' +
          esc(money.format(String(action.amountKopecks), 100n)) +
          '</p>' +
          (item.canManageFinance && !['succeeded', 'canceled', 'rejected'].includes(action.status)
            ? '<form class="admin-billing-form" data-admin-financial-check data-action-id="' +
              esc(action.id) +
              '"><fieldset><label class="field">ID существующего объекта, если результат неизвестен<input name="referenceId" maxlength="100"></label><label class="field">Причина привязки<input name="reason" minlength="3" maxlength="300"></label></fieldset><button type="submit" class="secondary">Проверить прежнюю операцию</button><p role="status" data-admin-billing-message></p></form>'
            : '') +
          '</article>',
      )
      .join('');
    if (!item.canManageFinance || item.status !== 'succeeded') return rows;
    return (
      rows +
      '<details><summary>Создать возврат или закрывающий чек</summary><form class="admin-billing-form" data-admin-financial-action data-checkout-id="' +
      esc(item.checkoutId || item.id) +
      '" data-revision="' +
      esc(item.revision) +
      '"><fieldset><label class="field">Операция<select name="kind"><option value="refund">Возврат оплаты</option><option value="receipt">Чек зачёта предоплаты</option></select></label>' +
      '<label class="field">Сумма возврата, ₽<input name="amountRub" type="number" min="0.01" step="0.01"></label>' +
      '<label class="field">При частичном возврате<select name="accessPolicy"><option value="keep">Сохранить доступ к этой услуге</option><option value="revoke">Прекратить доступ к этой услуге</option></select></label>' +
      '<p class="form-hint">При полном возврате доступ по этому заказу прекращается. Другие услуги сохраняются.</p><label class="field">Почта для чека<input name="receiptEmail" type="email" required maxlength="254"></label>' +
      '<label class="admin-check"><input type="checkbox" name="serviceProvided">Для чека зачёта подтверждаю оказание услуги по условиям договора</label>' +
      '<label class="field">Основание операции<input name="reason" required minlength="3" maxlength="300"></label>' +
      '</fieldset><button type="submit" class="secondary">Подтвердить операцию</button><p role="status" data-admin-billing-message></p></form></details>'
    );
  }
  function render(item) {
    const id = item.checkoutId || item.id;
    if (!id || !Number.isSafeInteger(item.revision)) return '';
    const choices = Object.entries(actions).filter(
      ([action]) => action !== 'retry_create' || item.canRetryCreate === true,
    );
    return (
      '<details class="admin-payment-review"><summary>Сверка, возврат и чек</summary>' +
      '<div class="admin-payment-review-state">' +
      '<p><strong>Чек оплаты:</strong> ' +
      esc(statuses[item.receiptRegistration] || 'Нет сведений') +
      '</p>' +
      state('Сверка оплаты', item.reconciliation) +
      state('Возврат', item.refund) +
      state('Закрывающий чек', item.closingReceipt) +
      (item.refund?.knownRefundedKopecks > 0
        ? '<p>Подтверждённые возвраты: ' +
          esc(money.format(String(item.refund.knownRefundedKopecks), 100n)) +
          '</p>'
        : '') +
      '<p class="form-hint">Заявки сохраняются для проверки администратором. Они не возвращают деньги и не создают чек.</p>' +
      (item.notice ? '<p class="form-hint">' + esc(item.notice) + '</p>' : '') +
      '</div>' +
      '<form class="admin-billing-form" data-admin-payment-review data-checkout-id="' +
      esc(id) +
      '" data-revision="' +
      esc(item.revision) +
      '"><fieldset><legend>Действие по заказу</legend>' +
      '<label class="field">Действие<select name="action">' +
      choices
        .map(([value, label]) => '<option value="' + value + '">' + label + '</option>')
        .join('') +
      '</select></label>' +
      '<label class="field">ID оплаты в ЮKassa, если он ещё не связан с заказом' +
      '<input name="paymentId" maxlength="100" autocomplete="off"></label>' +
      '<label class="field">ID существующего возврата или чека для проверки' +
      '<input name="referenceId" maxlength="100" autocomplete="off"></label>' +
      '<label class="field">Причина действия<input name="reason" required minlength="3" maxlength="300"></label>' +
      '</fieldset><button type="submit" class="secondary">Выполнить действие</button>' +
      '<p role="status" aria-live="polite" data-admin-billing-message></p></form>' +
      financialForm(item) +
      '</details>'
    );
  }
  function operation(form, common) {
    const values = new FormData(form),
      text = (name) => String(values.get(name) || '').trim(),
      action = text('action');
    if (!actions[action]) throw Error('Выберите действие по заказу.');
    if (['check_refund', 'check_receipt'].includes(action) && !text('referenceId'))
      throw Error('Укажите ID существующего возврата или чека.');
    return {
      route: '/api/admin/billing/payment-review',
      kind: 'review',
      body: {
        ...common,
        checkoutId: form.dataset.checkoutId,
        expectedRevision: Number(form.dataset.revision),
        action,
        ...(action === 'reconcile' && text('paymentId') ? { paymentId: text('paymentId') } : {}),
        ...(['check_refund', 'check_receipt'].includes(action)
          ? { referenceId: text('referenceId') }
          : {}),
      },
    };
  }
  return { render, operation };
}
