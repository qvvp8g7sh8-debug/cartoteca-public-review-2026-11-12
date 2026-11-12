function createEarlyAccess(state, actions) {
  let sequence = 0;
  function earlyAccessVisible() {
    const root = actions.$('#early-access-days');
    return (
      state.multiUser &&
      Boolean(state.account?.organizationId) &&
      state.currentView === 'settings' &&
      Boolean(root?.isConnected) &&
      !root.parentElement.closest('[hidden]') &&
      window.getComputedStyle(root.parentElement).display !== 'none'
    );
  }
  async function loadEarlyAccess({ quiet = false } = {}) {
    const root = actions.$('#early-access-days');
    if (!root || !state.multiUser || !state.account?.organizationId) return;
    const account = state.account,
      organizationId = account.organizationId,
      serial = ++sequence;
    const current = () =>
      root.isConnected &&
      state.account === account &&
      state.account?.organizationId === organizationId &&
      serial === sequence;
    try {
      const result = await actions.readBackground('/api/account/profile');
      if (!current()) return;
      if (result.freeAccess === null) {
        root.hidden = true;
        root.dataset.loaded = 'true';
        return;
      }
      const period = result.freeAccess;
      if (
        !period ||
        !Number.isInteger(period.remainingDays) ||
        period.remainingDays < 0 ||
        period.remainingDays > 366 ||
        !['active', 'ended'].includes(period.status) ||
        (period.status === 'active') !== period.remainingDays > 0
      ) {
        root.hidden = false;
        root.textContent = 'Не удалось загрузить срок бесплатного доступа';
        delete root.dataset.loaded;
        return;
      }
      root.hidden = false;
      const verb =
        period.remainingDays % 10 === 1 && period.remainingDays % 100 !== 11
          ? 'остался'
          : 'осталось';
      root.textContent =
        period.status === 'active'
          ? `Бесплатный доступ: ${verb} ${period.remainingDays} ${actions.plural(period.remainingDays, 'день', 'дня', 'дней')}`
          : 'Бесплатный период завершён';
      root.dataset.loaded = 'true';
    } catch {
      if (current() && (!quiet || root.dataset.loaded !== 'true')) {
        root.hidden = false;
        root.textContent = 'Не удалось загрузить срок бесплатного доступа';
      }
    }
  }
  return { earlyAccessVisible, loadEarlyAccess };
}
