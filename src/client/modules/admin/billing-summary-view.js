function createAdminBillingSummaryView({ records }) {
  const { esc } = records;
  const money = createAdminBillingMoney();
  function uncertaintyHtml(summary = {}) {
    const items = [
      ['Неуточнённых обращений', summary.uncertainCalls],
      ['Незакрытых резервов', summary.pendingReservations],
    ].filter(([, count]) => Number.isSafeInteger(count) && count > 0);
    return items.length
      ? '<p class="admin-billing-uncertainty" role="status">Расходы ещё уточняются. ' +
          items.map(([label, count]) => label + ': ' + count).join('. ') +
          '.</p>'
      : '';
  }
  function render(data, { compact = false, organization = null } = {}) {
    if (!data?.available) return '<p>Пакеты пока недоступны.</p>';
    if (
      organization &&
      (data.scope?.type !== 'organization' || data.scope.organizationId !== organization.id)
    )
      return '<p role="status">Финансовые данные этого кабинета пока не загружены.</p>';
    const summary = data.summary || {},
      scope = data.scope?.type === 'organization' ? 'Кабинет: ' + data.scope.name : 'Вся платформа';
    return (
      '<p class="admin-billing-scope"><strong>' +
      esc(scope) +
      '</strong> · ' +
      esc(data.periodLabel || 'С начала учёта пакетов') +
      '</p><dl class="admin-billing-totals">' +
      [
        [
          'Подтверждённые оплаты пакетов',
          money.format(summary.paidRevenueKopecks, 100n, summary.paidRevenueRub),
        ],
        ...(summary.refundedKopecks !== undefined
          ? [
              ['Возвращено', money.format(summary.refundedKopecks, 100n)],
              ['После возвратов', money.format(summary.netPaidKopecks, 100n)],
            ]
          : []),
        [
          'Расчётные расходы',
          money.format(summary.providerCostMicrorub, 1000000n, summary.providerCostRub),
        ],
        ['После возвратов и расчётных расходов', money.difference(summary)],
        ['Действующих пакетов', summary.activePackages ?? '—'],
        ['Пробных выдач за период учёта', summary.trialGrants ?? '—'],
      ]
        .map(
          ([label, value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>',
        )
        .join('') +
      '</dl>' +
      uncertaintyHtml(summary) +
      (!compact && data.serviceTotals?.length
        ? '<div class="admin-table-scroll"><table><caption>Оплата по услугам</caption><thead><tr><th>Услуга</th><th>Подтверждено</th><th>Возвращено</th><th>После возвратов</th><th>Расходы</th></tr></thead><tbody>' +
          data.serviceTotals
            .map(
              (item) =>
                '<tr><th scope="row">' +
                esc(item.title) +
                '</th><td>' +
                esc(money.format(item.paidRevenueKopecks, 100n)) +
                '</td><td>' +
                esc(money.format(item.refundedKopecks, 100n)) +
                '</td><td>' +
                esc(money.format(item.netPaidKopecks, 100n)) +
                '</td><td>' +
                esc(
                  item.providerCostMicrorub === null
                    ? 'Нет учёта расходов'
                    : money.format(item.providerCostMicrorub, 1000000n),
                ) +
                '</td></tr>',
            )
            .join('') +
          '</tbody></table></div>'
        : '') +
      (compact
        ? ''
        : '<p class="form-hint">Показаны подтверждённые оплаты и учтённые возвраты. Расходы по платным и пробным пакетам с начала их учёта рассчитаны по использованию и ставкам. Разница не учитывает налоги и комиссии.</p>')
    );
  }
  return { render, uncertaintyHtml };
}
