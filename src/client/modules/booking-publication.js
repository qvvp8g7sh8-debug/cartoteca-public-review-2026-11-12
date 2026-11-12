function createBookingPublication(state, actions) {
  let synchronize = () => {};
  function syncBookingPublication(value) {
    synchronize(value);
  }
  const scope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  function mountBookingPublication(snapshot) {
    const root = actions.$('#booking-publication');
    if (!root || !snapshot.publication?.canManage) return;
    const key = scope();
    let publication = snapshot.publication,
      pending = false;
    const live = () => root.isConnected && key === scope() && state.currentView === 'settings';
    function path() {
      const staff = root.querySelector('[data-booking-link-staff]')?.value;
      const staffPath = staff && publication.staffPaths?.[staff];
      const url = new URL(staffPath || publication.path, location.origin);
      if (staff && !staffPath) url.searchParams.set('staff', staff);
      return url.href;
    }
    function render() {
      const settings = root.parentElement?.querySelector('#online-booking-settings-form');
      if (settings) settings.hidden = !publication.enabled;
      const esc = actions.esc;
      const members = snapshot.members.filter(
        (m) =>
          (snapshot.staff[m.accountId]?.enabled ?? m.role !== 'salon_admin') &&
          (publication.staffPaths == null || Object.hasOwn(publication.staffPaths, m.accountId)),
      );
      root.innerHTML = [
        '<form id="booking-publication-form" class="booking-publication">',
        '<div class="settings-label-row"><label class="checkbox-hit-area"><input type="checkbox" name="enabled" aria-labelledby="booking-publication-label" ',
        publication.enabled ? 'checked' : '',
        '></label><span id="booking-publication-label">Включить публичную онлайн-запись</span>',
        actions.settingsHelpHtml(
          'Публичная онлайн-запись',
          'Клиенты увидят услуги, специалистов и доступное время. Чужие записи и данные клиентов не показываются. Публичную ссылку можно отправить клиентам или разместить в профиле организации; QR-код ведёт на ту же страницу.',
        ),
        '</div>',
        publication.enabled
          ? [
              members.length > 1
                ? '<label class="field">Ссылка для<select data-booking-link-staff><option value="">Всей организации</option>' +
                  members
                    .map(
                      (m) => `<option value="${esc(m.accountId)}">${esc(m.displayName)}</option>`,
                    )
                    .join('') +
                  '</select></label>'
                : '',
              '<label class="field">Публичная ссылка<input data-booking-public-link readonly></label>',
              '<div class="booking-link-actions"><button type="button" class="secondary" data-booking-link-action="open">Открыть страницу</button><button type="button" class="secondary" data-booking-link-action="share">Отправить ссылку</button>',
              '<button type="button" class="secondary" data-booking-link-action="copy">Копировать</button><button type="button" class="secondary" data-booking-link-action="qr">QR-код</button></div>',
              '<img data-booking-public-qr width="220" height="220" alt="QR-код онлайн-записи" hidden>',
            ].join('')
          : '',
        publication.disabledReason === 'no_working_days'
          ? `<p>${
              publication.hasWorkingDays
                ? 'График настроен. Включите онлайн-запись вручную.'
                : 'Онлайн-запись выключена: нет открытых рабочих дней. Настройте рабочее время.'
            }</p>`
          : '',
        '<p data-booking-publication-result role="status"></p></form>',
      ].join('');
      const field = root.querySelector('[data-booking-public-link]');
      if (field) field.value = path();
    }
    root.addEventListener('change', async (event) => {
      if (event.target.matches('input[name="enabled"]')) {
        const checkbox = event.target,
          enabled = checkbox.checked;
        checkbox.checked = publication.enabled;
        if (!live() || state.busy || pending || enabled === publication.enabled) return;
        pending = true;
        try {
          const accepted = await actions.confirmAction(
            enabled ? 'Включить онлайн-запись?' : 'Выключить онлайн-запись?',
            enabled
              ? 'Клиенты смогут записываться по публичной ссылке. Будет действовать сохранённый вид онлайн-записи.'
              : 'Новые записи по публичной ссылке будут недоступны. Существующие записи и заявки сохранятся.',
            enabled ? 'Включить запись' : 'Выключить запись',
          );
          if (accepted && live() && !state.busy) await savePublication(enabled);
        } finally {
          pending = false;
        }
      }
      if (event.target.matches('[data-booking-link-staff]') && live()) {
        root.querySelector('[data-booking-public-link]').value = path();
        const image = root.querySelector('[data-booking-public-qr]');
        image.hidden = true;
        image.removeAttribute('src');
      }
    });
    root.addEventListener('submit', (event) => event.preventDefault());
    async function savePublication(enabled) {
      state.busy = true;
      root.querySelector('input[name="enabled"]').disabled = true;
      try {
        const result = await actions.request('/api/online-booking/publication', {
          method: 'POST',
          body: JSON.stringify({
            enabled,
            revision: publication.revision,
          }),
        });
        if (!live()) return;
        publication = result;
        render();
        void actions.refreshBookingHealth({ force: true });
        root.querySelector('[data-booking-publication-result]').textContent = result.enabled
          ? 'Публичная запись включена.'
          : result.disabledReason === 'no_working_days'
            ? 'Нет открытых рабочих дней. Настройте график и включите запись вручную.'
            : 'Публичная запись выключена.';
      } catch (error) {
        if (live())
          root.querySelector('[data-booking-publication-result]').textContent = error.message;
      } finally {
        state.busy = false;
        if (live()) root.querySelector('input[name="enabled"]').disabled = false;
      }
    }
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-booking-link-action]');
      if (!button || !live() || state.busy || !publication.enabled) return;
      const value = path(),
        message = root.querySelector('[data-booking-publication-result]');
      try {
        if (button.dataset.bookingLinkAction === 'open') {
          window.open(value, '_blank', 'noopener,noreferrer');
          return;
        }
        if (button.dataset.bookingLinkAction === 'qr') {
          const staff = root.querySelector('[data-booking-link-staff]')?.value || '';
          const result = await actions.request(
            '/api/online-booking/qr?staff=' + encodeURIComponent(staff),
          );
          if (!live() || value !== path()) return;
          const image = root.querySelector('[data-booking-public-qr]');
          image.src = result.dataUrl;
          image.hidden = false;
          return;
        }
        if (button.dataset.bookingLinkAction === 'share' && typeof navigator.share === 'function') {
          await navigator.share({
            title: 'Онлайн-запись',
            text: 'Выберите услуги и удобное время для записи.',
            url: value,
          });
          return;
        }
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          if (live()) message.textContent = 'Ссылка скопирована.';
        } else {
          const field = root.querySelector('[data-booking-public-link]');
          field.focus();
          field.select();
          message.textContent = 'Ссылка выделена — скопируйте её.';
        }
      } catch (error) {
        if (live() && error.name !== 'AbortError')
          message.textContent = 'Не удалось отправить автоматически. Скопируйте ссылку из поля.';
      }
    });
    synchronize = (next) => {
      if (
        !live() ||
        !next?.canManage ||
        state.busy ||
        pending ||
        next.revision < publication.revision
      )
        return;
      if (
        ['enabled', 'revision', 'disabledReason', 'hasWorkingDays', 'path'].every(
          (name) => next[name] === publication[name],
        ) &&
        JSON.stringify(next.staffPaths || {}) === JSON.stringify(publication.staffPaths || {})
      )
        return;
      const checkbox = root.querySelector('input[name="enabled"]');
      const dirty = checkbox?.form.dataset.publicationDirty === 'true';
      const draft = checkbox?.checked;
      const focused = document.activeElement === checkbox;
      const staff = root.querySelector('[data-booking-link-staff]')?.value;
      publication = next;
      render();
      const updated = root.querySelector('input[name="enabled"]');
      if (dirty) {
        updated.checked = draft;
        updated.form.dataset.publicationDirty = 'true';
      }
      const select = root.querySelector('[data-booking-link-staff]');
      if (select && [...select.options].some((option) => option.value === staff)) {
        select.value = staff;
        root.querySelector('[data-booking-public-link]').value = path();
      }
      if (focused) updated.focus({ preventScroll: true });
    };
    render();
  }
  return { mountBookingPublication, syncBookingPublication };
}
