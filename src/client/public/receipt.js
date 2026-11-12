function createPublicBookingReceipt(root, { $, esc, price, dateLabel, status }) {
  function success(info, result, selection) {
    const states = {
      booked: [
        'Запись успешно создана',
        'Подтверждена организацией',
        'Выбранное время закреплено за вами. Ожидать принятия заявки сотрудником не нужно.',
      ],
      pending: [
        'Заявка успешно отправлена',
        'Ожидает подтверждения',
        'Организация получила вашу заявку. Дождитесь связи по указанному телефону: запись ещё не подтверждена.',
      ],
      requested: [
        'Запрос времени отправлен',
        'Нужно согласовать время',
        'Время не резервируется. Организация свяжется с вами по указанному телефону, чтобы согласовать запись.',
      ],
      accepted: [
        'Запись принята',
        'Принята организацией',
        'Организация приняла вашу заявку на это время.',
      ],
      expired: [
        'Заявка сохранена',
        selection.kind === 'other-time' ? 'Срок ожидания истёк' : 'Резерв истёк',
        selection.kind === 'other-time'
          ? 'Срок ожидания решения уже истёк. Можно отправить новую заявку или связаться с организацией.'
          : 'Резерв времени уже истёк. Свяжитесь с организацией, чтобы уточнить доступность и подтвердить запись.',
      ],
      rejected: [
        'Заявка отклонена',
        'Не подтверждена',
        'Свяжитесь с организацией, чтобы подобрать другое время.',
      ],
      cancelled: [
        'Заявка отменена',
        'Не подтверждена',
        'Свяжитесь с организацией, чтобы подобрать другое время.',
      ],
    };
    const [title, state, message] = states[result.status] || [
      'Заявка сохранена',
      'Проверяется организацией',
      'Свяжитесь с организацией для уточнения результата.',
    ];
    const member = info.members.find((m) => m.id === selection.staffId);
    const services = info.services.filter((s) => selection.serviceIds.includes(s.id));
    const date = result.date || selection.date,
      time = result.time || selection.time;
    $('#booking-flow').hidden = true;
    root.classList.add('booking-completed');
    const element = $('#booking-result');
    const negative = ['rejected', 'cancelled'].includes(result.status);
    element.dataset.state = result.status;
    element.innerHTML = [
      '<button type="button" class="booking-result-close" data-booking-result-close aria-label="Закрыть результат отправки" title="Закрыть"><span aria-hidden="true">×</span></button>',
      `<span class="booking-result-icon" aria-hidden="true">${negative ? '×' : '✓'}</span>`,
      `<h2>${esc(title)}</h2>`,
      `<p class="booking-result-state">${esc(state)}</p><p>${esc(message)}</p>`,
      `<div class="booking-receipt"><strong>${esc(dateLabel(date))} · ${esc(time)}</strong>`,
      `<p>${esc(info.organization.name)}${member ? ' · ' + esc(member.name) : ''}</p>`,
      `<p>${esc(services.map((s) => s.name).join(', '))}</p>`,
      `<p>${result.duration || services.reduce((n, s) => n + s.duration, 0)} мин`,
      info.showPrices !== false && services.every((s) => s.price != null)
        ? ' · ' + esc(price(services.reduce((n, s) => n + s.price, 0)))
        : '',
      `</p><small>Время организации · ${esc(info.organization.timeZone)}</small></div>`,
      result.status === 'pending'
        ? `<p class="booking-result-note">${result.expiresAt ? 'Резерв действует до ' + new Intl.DateTimeFormat('ru-RU', { timeZone: info.organization.timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(result.expiresAt)) + ' по времени организации.' : 'Время временно зарезервировано.'} Это не окончательное подтверждение записи.</p>`
        : '',
      result.status === 'requested'
        ? '<p class="booking-result-note">Запрос ожидает решения до 24 часов с момента отправки. После истечения срока можно отправить новую заявку. Время не резервируется.</p>'
        : '',
      result.status === 'booked'
        ? '<p class="booking-result-note">Сохраните дату и время. Отдельное письмо или сообщение после этой формы не отправляется. Для отмены или переноса свяжитесь с организацией.</p>'
        : '<p class="booking-result-note">Письмо или сообщение в мессенджер автоматически после отправки этой формы не отправляется. Уточнения поступят от организации по вашему контакту.</p>',
    ].join('');
    element.hidden = false;
    status(title + '. ' + message);
    $('#booking-page-status').classList.add('sr-only');
    if (!root.classList.contains('booking-exited')) {
      element.focus();
      element.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }
  }
  function dismissResult() {
    $('#booking-result').hidden = true;
    const element = $('#booking-page-status');
    element.classList.remove('sr-only');
    element.classList.add('booking-dismissed');
    // Keep the actual server result; closing the receipt is not cancellation.
    element.textContent += ' Экран результата закрыт. Эту вкладку можно закрыть.';
    element.tabIndex = -1;
    element.focus();
    element.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }
  return { success, dismissResult };
}
