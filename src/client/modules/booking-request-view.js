function createBookingRequestView(state, actions) {
  function bookingRequestsPanelHtml() {
    return [
      '<section id="booking-requests-panel" class="booking-requests-panel" aria-label="Входящие заявки">',
      '<header class="booking-requests-heading"><div><h3>Входящие заявки</h3>',
      '<p>Примите заявку или согласуйте другое время с клиентом.</p></div>',
      '<div class="booking-requests-tools">',
      '<button type="button" class="text-btn" data-open-booking-settings>Настройки записи</button></div></header>',
      '<p class="booking-request-sync" data-booking-request-sync>Автообновление включено</p>',
      '<div data-booking-request-content></div><p role="status" aria-live="polite" data-booking-request-message></p></section>',
    ].join('');
  }
  const labels = {
    pending: 'Ожидает решения · время зарезервировано',
    requested: 'Запрос другого времени · без резерва',
    expired: 'Резерв истёк · время нужно проверить',
    accepted: 'Принята в календарь',
    rejected: 'Отклонена',
    cancelled: 'Отменена',
  };
  function requestLabel(record) {
    if (record.status === 'expired' && record.kind === 'other-time')
      return 'Срок ожидания истёк · запрос больше не блокирует новую заявку';
    if (['pending', 'requested'].includes(record.status)) {
      if (record.proposal?.state === 'waiting')
        return 'Предложено время · ожидает ответа клиента · без резерва';
      if (record.proposal?.state === 'agreed')
        return 'Клиент согласовал время · можно принять в календарь';
    }
    return labels[record.status] || record.status;
  }
  // Rendering has no requests or writes; the controller owns command lifecycles.
  function bookingRequestsHtml(items, settings, candidates, proposalLinks, cursor) {
    const esc = actions.esc;
    const html = items.length
      ? items
          .map((r) => {
            const canManage = settings.canManage || settings.canManageOwnRequests;
            const open = ['pending', 'requested', 'expired'].includes(r.status);
            const staff = settings.members.find((m) => m.accountId === r.staffId);
            const version = JSON.stringify([r.revision, r.date, r.time, canManage]);
            return [
              `<article class="booking-request" data-request-state="${esc(['pending', 'requested'].includes(r.status) && r.proposal?.state === 'agreed' ? 'agreed' : r.status)}" data-booking-request-row="${esc(r.id)}" data-booking-request-version="${esc(version)}"><div class="booking-request-summary">`,
              `<div class="booking-request-contact"><strong>${esc([r.firstName, r.middleName, r.lastName].filter(Boolean).join(' '))}</strong>`,
              `<a href="tel:${esc(r.phone.replace(/[^+\d]/g, ''))}">${esc(r.phone)}</a></div>`,
              `<p class="booking-request-schedule"><span>${esc(actions.formatDate(r.date))}</span><strong>${esc(r.time)}</strong><span>${esc(actions.formatMinutes(r.duration))}</span></p>`,
              `<p>${esc(r.services.map((s) => s.name).join(', '))}</p>`,
              staff ? `<p class="muted">${esc(staff.displayName)}</p>` : '',
              r.comment ? `<p class="booking-request-comment">${esc(r.comment)}</p>` : '',
              r.originalWish
                ? `<p class="muted">Изначально запрошено: ${esc(actions.formatDate(r.originalWish.date))} · ${esc(r.originalWish.time)}</p>`
                : '',
              `<small class="booking-request-status">${esc(requestLabel(r))}</small></div>`,
              canManage && open
                ? [
                    '<div class="booking-request-decision">',
                    candidates.has(r.id)
                      ? `<label class="field">Выберите карточку клиента<select data-booking-contact="${esc(r.id)}"><option value="">Не выбрана</option>${candidates
                          .get(r.id)
                          .map(
                            (p) =>
                              `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.phone)}</option>`,
                          )
                          .join('')}</select></label>`
                      : '',
                    '<div class="booking-request-actions">',
                    `<button type="button" class="primary" data-booking-request-action="accept" data-request-id="${esc(r.id)}">Принять</button>`,
                    `<button type="button" class="secondary" data-booking-request-action="choose" data-request-id="${esc(r.id)}">Выбрать время</button>`,
                    `<button type="button" class="secondary booking-danger" data-booking-request-action="reject" data-request-id="${esc(r.id)}">Отклонить</button></div></div>`,
                  ].join('')
                : '',
              '</article>',
            ].join('');
          })
          .join('')
      : '<div class="booking-requests-empty"><strong>Новых заявок пока нет</strong><p>Здесь появятся обращения из формы онлайн-записи.</p></div>';
    return (
      html +
      (cursor
        ? '<button type="button" class="secondary" data-booking-request-more>Показать ещё</button>'
        : '')
    );
  }
  return { bookingRequestsPanelHtml, bookingRequestsHtml };
}
