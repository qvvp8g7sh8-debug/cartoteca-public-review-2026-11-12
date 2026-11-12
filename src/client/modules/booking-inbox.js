function createBookingInbox(state, actions) {
  let key = '',
    count = null,
    checkedAt = 0,
    attemptedAt = -Infinity,
    failures = 0,
    pending = null;
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const allowed = () => state.multiUser && Boolean(state.account?.organizationId);

  function renderBookingInbox() {
    if (key !== scope() || !allowed()) {
      key = scope();
      count = null;
      checkedAt = 0;
      attemptedAt = -Infinity;
      failures = 0;
    }
    const last = checkedAt
      ? new Date(checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : '';
    document.querySelectorAll('[data-booking-request-count]').forEach((badge) => {
      badge.hidden = count === null || count === 0;
      badge.textContent = count > 99 ? '99+' : String(count ?? '');
      badge.classList.toggle('is-stale', failures > 0);
      badge.title =
        count === null
          ? ''
          : `Требуют обработки: ${count}${failures ? ' · данные могут устареть' : ''}`;
      const button = badge.closest('button');
      if (button) {
        const label = button.dataset.view === 'services' ? 'Управление' : 'Заявки';
        button.setAttribute('aria-label', count ? `${label}, требуют обработки: ${count}` : label);
      }
    });
    const status = actions.$('[data-booking-request-sync]');
    if (status) {
      status.classList.toggle('is-stale', failures > 0);
      status.textContent = failures
        ? `Не удалось обновить. Повторим автоматически.${last ? ' Последнее обновление: ' + last + '.' : ''}`
        : last
          ? 'Автообновление · проверено в ' + last
          : 'Автообновление включено';
    }
  }
  function bookingInboxInterval() {
    const interval = actions.bookingRequestsVisible() ? 15000 : 30000;
    return key === scope() && failures
      ? Math.min(120000, interval * 2 ** Math.min(failures, 3))
      : interval;
  }
  function bookingInboxDeadline() {
    return key === scope() ? attemptedAt + bookingInboxInterval() : -Infinity;
  }
  function refreshBookingInbox({ force = false } = {}) {
    renderBookingInbox();
    if (!allowed() || document.hidden) return Promise.resolve();
    const current = key;
    if (pending?.key === current) return pending.task;
    if (!force && Date.now() - attemptedAt < bookingInboxInterval()) return Promise.resolve();
    attemptedAt = Date.now();
    const task = Promise.resolve().then(async () => {
      try {
        const summary = await actions.readBackground('/api/online-booking/requests/summary');
        if (current !== scope()) return;
        count = summary.count;
        // List loading is owned by its controller. Open editors do not block summary reads.
        await actions.refreshBookingRequests(summary);
        if (current !== scope()) return;
        checkedAt = summary.checkedAt;
        failures = 0;
      } catch {
        if (current !== scope()) return;
        failures++;
      } finally {
        if (pending?.task === task) pending = null;
        if (current === scope()) renderBookingInbox();
      }
    });
    pending = { key: current, task };
    return task;
  }
  return { renderBookingInbox, bookingInboxInterval, bookingInboxDeadline, refreshBookingInbox };
}
