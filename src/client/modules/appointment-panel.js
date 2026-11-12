function createAppointmentPanel(state, actions) {
  function appointmentPanelHtml(appointments, patientId, result = null, tools = '') {
    const panel = (content) =>
      '<div class="patient-appointments-heading"><strong role="heading" aria-level="3">Записи <span class="patient-appointments-count">' +
      appointments.length +
      '</span></strong><span>Предстоящие и неоформленные</span></div>' +
      '<div class="patient-appointments-list" tabindex="0" role="region" aria-label="Записи клиента: прокручиваемый список">' +
      content +
      '</div>';
    if (!appointments.length)
      return panel(
        [
          '<div class="telegram-compact-strip">',
          '<div class="telegram-strip-content">',
          '<span class="telegram-empty-appointment">Создайте запись</span>',
          '</div>',
          '<div class="telegram-strip-tools">',
        ].join('') +
          tools +
          '</div></div>',
      );
    return panel(
      appointments
        .map((a, index) => {
          const id = a.appointmentId || a.id,
            confirmed =
              a.confirmedAt ||
              a.telegramConfirmedAt ||
              a.notificationConfirmedAt ||
              a.manualConfirmedAt;
          const past =
            typeof a.upcoming === 'boolean'
              ? !a.upcoming
              : Number.isFinite(a.startsAt)
                ? a.startsAt <= Date.now()
                : a.date < actions.cabinetToday();
          const status =
            actions.appointmentConfirmationStatus(a) ||
            (past ? 'Прошедшая запись — посещение не оформлено' : 'Ждём подтверждения клиента');
          const deliveryNote =
            !past && !confirmed
              ? {
                  pending: 'Напоминание в очереди',
                  sending: 'Отправляем напоминание…',
                  sent: 'Напоминание отправлено',
                  failed: 'Не удалось доставить напоминание',
                  reserved: 'Напоминание в очереди',
                  uncertain: 'Доставка требует уточнения — повтор остановлен',
                  blocked: 'Нет доступных подключённых каналов',
                  disabled: 'Напоминания выключены в настройках',
                }[a.deliveryStatus] || ''
              : '';
          const canEdit =
            actions.canEditRecord(a) && (!result || a.canRemind || actions.isClosedAppointment(a));
          const remind =
            actions.isActiveAppointment(a) &&
            (a.deliveryReady
              ? Boolean(a.deliveryChannel)
              : result?.linked && result.bot?.connected) &&
            result?.notificationsEnabled &&
            canEdit &&
            !past &&
            !confirmed &&
            !a.deliveryStatus
              ? '<button class="primary" type="button" data-telegram-remind="' +
                actions.esc(id) +
                '" data-telegram-patient="' +
                actions.esc(patientId) +
                '">Отправить сейчас</button>'
              : '';
          const edit = canEdit
            ? '<button class="secondary telegram-edit-appointment" type="button" data-telegram-edit="' +
              actions.esc(id) +
              '" data-telegram-patient="' +
              actions.esc(patientId) +
              '">' +
              (actions.isClosedAppointment(a)
                ? 'Открыть запись'
                : '<svg class="appointment-action-pencil" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 15 10-10 4 4L9 19l-5 1Z" fill="#daa658"/><path d="m15 5 2-2a1.5 1.5 0 0 1 2 0l2 2a1.5 1.5 0 0 1 0 2l-2 2Z" fill="#8199a8"/><path d="m5 15 4 4-5 1Z" fill="#536b7a"/><path d="m7 15 9-9" stroke="#fff" stroke-opacity=".65" stroke-linecap="round"/></svg><span>Изменить запись</span>') +
              '</button>'
            : '';
          const complete =
            canEdit && actions.isActiveAppointment(a)
              ? '<button class="secondary" type="button" data-complete-appointment="' +
                actions.esc(id) +
                '" data-telegram-patient="' +
                actions.esc(patientId) +
                '">Оформить посещение</button>'
              : '';
          const manual =
            canEdit && actions.isActiveAppointment(a) && !past
              ? actions.appointmentConfirmationControls(a, patientId)
              : '';
          return (
            '<div class="telegram-compact-strip unified-appointment-row" data-appointment-row="' +
            actions.esc(id) +
            '"><div class="telegram-strip-content"><div class="appointment-info-heading">' +
            (canEdit
              ? '<button type="button" class="text-btn appointment-record-open" data-card-appointment="' +
                actions.esc(id) +
                '">'
              : '') +
            '<strong>' +
            actions.esc(actions.formatDate(a.date) + ' · ' + a.time) +
            '</strong>' +
            (canEdit ? '</button>' : '') +
            '<span class="appointment-status ' +
            (confirmed && actions.isActiveAppointment(a) ? 'is-confirmed' : '') +
            '" role="status">' +
            actions.esc(status) +
            '</span></div>' +
            (deliveryNote
              ? '<p class="appointment-delivery-note">' + actions.esc(deliveryNote) + '</p>'
              : '') +
            '<div class="appointment-service-line">' +
            actions.esc(a.service || 'Услуга не указана') +
            ' · ' +
            actions.formatMinutes(a.duration || 60) +
            '</div></div>' +
            '<div class="telegram-strip-tools">' +
            remind +
            manual +
            complete +
            (canEdit ? actions.appointmentOutcomeControls({ ...a, id }, patientId) : '') +
            edit +
            (index === 0 ? tools : '') +
            '</div>' +
            '</div>'
          );
        })
        .join(''),
    );
  }
  return { appointmentPanelHtml };
}
