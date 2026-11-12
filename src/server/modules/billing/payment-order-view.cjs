function paymentOrderRevision(data) {
  return Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : 0;
}
function paymentOrderView(row, data) {
  const order = data.order;
  const needsReview =
    data.restoredReview ||
    data.reconciliationRequired ||
    ['review', 'uncertain'].includes(row.state);
  const notices = {
    creating: 'Создаём оплату. Не создавайте другой заказ.',
    pending: 'Ожидается оплата на защищённой странице ЮKassa.',
    uncertain: 'Результат создания оплаты уточняется. Повторяйте только этот заказ.',
    review: 'Оплата требует сверки администратором. Новый заказ пока не создавайте.',
    paid: row.test_mode
      ? 'Тестовая оплата подтверждена. Пакет подключён.'
      : 'Оплата подтверждена. Пакет подключён.',
    canceled: 'Платёж отменён. Пакет не подключён.',
    rejected: 'Платёж не создан. Проверьте условия оплаты.',
  };
  const refunds = (data.refunds || []).map((item) => ({
    id: item.id,
    status: item.status,
    amountKopecks: item.amountKopecks,
    receiptRegistration: item.receiptRegistration,
    checkedAt: item.checkedAt,
  }));
  const receipts = (data.receipts || []).map((item) => ({
    id: item.id,
    status: item.status,
    checkedAt: item.checkedAt,
    classification: item.classification,
  }));
  return {
    id: row.id,
    checkoutId: row.id,
    state: row.state,
    status:
      data.restoredReview && !row.fulfilled_at
        ? 'review'
        : row.state === 'paid'
          ? row.fulfilled_at
            ? 'succeeded'
            : 'review'
          : row.state,
    revision: paymentOrderRevision(data),
    confirmationUrl: data.restoredReview ? null : data.confirmationUrl || null,
    package: {
      id: order.packageId,
      version: order.packageVersion,
      title: order.title,
      priceKopecks: order.priceKopecks,
      taskLimit: order.taskLimit,
      serviceCode: order.serviceCode || 'voice-assistant',
      serviceTitle: order.serviceTitle || 'Голосовой помощник',
      periodMonths: order.periodMonths || 1,
      quotaUnit: order.quotaUnit || 'tasks',
    },
    createdAt: row.created_at,
    paidAt: row.paid_confirmed_at,
    fulfilledAt: row.fulfilled_at,
    receiptRegistration: row.receipt_status,
    testMode: Boolean(row.test_mode),
    reconciliation: data.reconciliation
      ? {
          status: data.reconciliation.status,
          code: data.reconciliation.code,
          checkedAt: data.reconciliation.checkedAt,
        }
      : {
          status: needsReview ? 'required' : 'not_required',
          code: data.restoredReview
            ? 'restored'
            : row.state === 'uncertain'
              ? 'unknown_create'
              : needsReview
                ? 'manual_review'
                : null,
          checkedAt: null,
        },
    refund: {
      status: data.refundReview
        ? 'review_required'
        : refunds.some((item) => item.status === 'pending')
          ? 'pending'
          : refunds.some((item) => item.status === 'succeeded')
            ? 'observed_succeeded'
            : 'not_requested',
      automatic: false,
      knownRefundedKopecks: refunds
        .filter((item) => item.status === 'succeeded')
        .reduce((sum, item) => sum + item.amountKopecks, 0),
      records: refunds,
      notice:
        'Возврат отправляется отдельным подтверждённым действием администратора. Доступ после частичного возврата определяется при его создании.',
    },
    closingReceipt: {
      status: receipts.length
        ? receipts[receipts.length - 1].status
        : data.receiptReview
          ? 'review_required'
          : 'not_checked',
      automatic: false,
      policyReady: false,
      records: receipts,
      notice:
        'Чек зачёта создаётся отдельно после подтверждения оказания услуги. Статус провайдера не подтверждает правильность выбранного налогового сценария.',
    },
    notice: data.restoredReview
      ? row.fulfilled_at
        ? 'Восстановлена история выполненной оплаты. Повторная выдача пакета отключена.'
        : 'Заказ восстановлен. До сверки администратором доступ автоматически не выдаётся.'
      : data.reconciliationRequired
        ? 'Нужна сверка результата платежа. Подключённый пакет автоматически не отзывается.'
        : notices[row.state],
  };
}
module.exports = { paymentOrderRevision, paymentOrderView };
