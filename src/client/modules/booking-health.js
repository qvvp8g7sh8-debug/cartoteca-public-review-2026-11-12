function createBookingHealth(state, actions) {
  let key = '',
    health = null,
    attemptedAt = -Infinity,
    failures = 0,
    pending = null;
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  const allowed = () =>
    state.multiUser && Boolean(state.account?.organizationId) && actions.canManageTeam();
  function resetScope() {
    if (key === scope() && allowed()) return;
    key = scope();
    health = null;
    attemptedAt = -Infinity;
    failures = 0;
  }
  function renderBookingHealth() {
    resetScope();
    const autoDisabled = health?.disabledReason === 'no_working_days';
    const problems =
      allowed() && health?.canManage && (health.enabled || autoDisabled) ? health.issues : [];
    if (state.settingsReady !== false && allowed() && health?.publication)
      actions.syncBookingPublication(health.publication);
    document.querySelectorAll('[data-booking-health-count]').forEach((badge) => {
      badge.hidden = problems.length === 0;
      badge.textContent = problems.length ? String(problems.length) : '';
      badge.title =
        problems.map((p) => p.title).join(' · ') + (failures ? ' · данные могут устареть' : '');
      badge.classList.toggle('is-stale', failures > 0);
      const button = badge.closest('button[data-view="settings"]');
      if (button)
        button.setAttribute(
          'aria-label',
          problems.length ? `Настройки, проблем онлайн-записи: ${problems.length}` : 'Настройки',
        );
    });
    const panel = actions.$('[data-booking-health-panel]');
    if (!panel) return;
    // Do not replace a focused action or any settings form on ordinary polling.
    const contentKey = JSON.stringify([
      health?.enabled,
      health?.canManage,
      health?.available,
      health?.disabledReason,
      problems,
      failures > 0,
      allowed(),
    ]);
    if (panel.dataset.contentKey === contentKey) return;
    panel.dataset.contentKey = contentKey;
    panel.hidden =
      !allowed() || (health && (!health.canManage || (!health.enabled && !autoDisabled)));
    if (panel.hidden) return;
    panel.classList.toggle('has-problems', problems.length > 0 || failures > 0);
    panel.classList.toggle('is-loading', !health && !failures);
    const esc = actions.esc;
    const targetButton = (problem) => {
      if (['schedule', 'services'].includes(problem.target))
        return `<button type="button" class="secondary" data-management-tab="${problem.target}">${problem.target === 'schedule' ? 'Настроить рабочее время' : 'Открыть услуги'}</button>`;
      return `<button type="button" class="secondary" data-booking-health-target="${esc(problem.target)}" data-booking-health-code="${esc(problem.code)}">${problem.target === 'workspace' ? 'Настроить кабинеты' : problem.target === 'publication' ? 'Перейти к включению' : 'Настроить сотрудников и услуги'}</button>`;
    };
    panel.innerHTML = [
      problems.length
        ? `<strong>${autoDisabled ? 'Онлайн-запись выключена автоматически' : 'Онлайн-запись включена, но записаться пока нельзя'}</strong>` +
          problems
            .map(
              (p) =>
                `<div class="booking-health-issue"><div><strong>${esc(p.title)}</strong><p>${esc(p.message)}</p></div>${targetButton(p)}</div>`,
            )
            .join('')
        : health?.available
          ? '<span class="booking-health-ready">Есть свободное время для онлайн-записи</span>'
          : `<span>${failures ? 'Доступность пока неизвестна.' : 'Определяем доступность онлайн-записи…'}</span>`,
      failures
        ? '<p class="booking-health-sync" role="status">Не удалось обновить доступность. Повторим автоматически; последнее состояние может устареть.</p>'
        : '',
    ].join('');
  }
  function bookingHealthInterval() {
    return key === scope() ? Math.min(120000, 30000 * 2 ** Math.min(failures, 2)) : 30000;
  }
  function bookingHealthDeadline() {
    return key === scope() ? attemptedAt + bookingHealthInterval() : -Infinity;
  }
  function refreshBookingHealth({ force = false } = {}) {
    renderBookingHealth();
    if (!allowed() || document.hidden) return Promise.resolve();
    const current = key;
    if (pending?.key === current) {
      if (force) pending.refreshAgain = true;
      return pending.task;
    }
    if (!force && Date.now() < bookingHealthDeadline()) return Promise.resolve();
    attemptedAt = Date.now();
    const task = Promise.resolve().then(async () => {
      try {
        const result = await actions.readBackground('/api/online-booking/health');
        if (current !== scope()) return;
        health = result;
        failures = 0;
      } catch {
        if (current === scope()) failures++;
      } finally {
        const refreshAgain = pending?.task === task && pending.refreshAgain;
        if (pending?.task === task) pending = null;
        if (current === scope()) {
          renderBookingHealth();
          if (refreshAgain) void refreshBookingHealth({ force: true });
        }
      }
    });
    pending = { key: current, task, refreshAgain: false };
    return task;
  }
  function bindBookingHealthEvents() {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-booking-health-target]');
      if (!button || !allowed() || state.busy) return;
      const workspace = button.dataset.bookingHealthTarget === 'workspace';
      const publication = button.dataset.bookingHealthTarget === 'publication';
      const root = actions.$(
        workspace
          ? '#workspace-settings'
          : publication
            ? '#booking-publication'
            : '#online-booking-settings',
      );
      const accordion = root?.closest('details');
      if (!accordion) return;
      accordion.open = true;
      const detail =
        workspace || publication
          ? null
          : actions.$(
              button.dataset.bookingHealthCode === 'no_staff'
                ? '.online-booking-members'
                : '#booking-service-assignments',
            );
      const inner = detail?.closest('details');
      if (inner) inner.open = true;
      const focus =
        (detail || root).querySelector('input,select,button') || accordion.querySelector('summary');
      focus?.focus({ preventScroll: true });
      (detail || accordion).scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    });
  }
  return {
    renderBookingHealth,
    bookingHealthInterval,
    bookingHealthDeadline,
    refreshBookingHealth,
    bindBookingHealthEvents,
  };
}
