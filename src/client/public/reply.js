function createBookingReplyPage(root, request) {
  // Fragment is not sent as a URL to the server or referrer. Only POST bodies carry it.
  const secret = new URLSearchParams(location.hash.slice(1)).get('reply');
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  let busy = false,
    pending = null;
  const call = (name, payload) =>
    request('/api/public-booking/' + name, { method: 'POST', body: JSON.stringify(payload) });
  function render(info) {
    const messages = {
      waiting:
        'Время не резервируется. После вашего согласия организация завершит оформление записи.',
      agreed: 'Вы согласились на это время. Организация завершит оформление записи.',
      accepted: 'Запись принята организацией.',
      rejected: 'Предложение отклонено.',
    };
    root.innerHTML = [
      '<section class="booking-section"><h1>Согласование записи</h1>',
      `<h2>${esc(info.organization.name)}</h2>`,
      info.staff
        ? `<p>${esc(info.staff.name)}${info.staff.specialty ? ' · ' + esc(info.staff.specialty) : ''}</p>`
        : '',
      `<p><strong>${esc(info.date.split('-').reverse().join('.'))} · ${esc(info.time)}</strong> · ${esc(info.duration)} мин.</p>`,
      `<p>${esc(info.services.map((s) => s.name).join(', '))}</p>`,
      `<p>${esc(messages[info.state] || 'Предложение уже обработано.')}</p>`,
      info.state === 'waiting'
        ? '<div class="booking-times"><button type="button" class="primary" data-reply="agree">Подтвердить время</button><button type="button" data-reply="decline">Отказаться</button></div>'
        : '',
      '<p data-reply-status role="status" aria-live="polite"></p></section>',
    ].join('');
  }
  async function initialize() {
    root.innerHTML = '<p role="status">Загрузка предложения…</p>';
    try {
      render(await call('proposal', { secret }));
    } catch (error) {
      root.innerHTML = `<p role="status">${esc(error.message)}</p>`;
    }
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-reply]');
      if (!button || busy) return;
      const decision = button.dataset.reply;
      if (pending && pending !== decision) return;
      busy = true;
      pending = decision;
      root.querySelectorAll('[data-reply]').forEach((b) => {
        b.disabled = true;
      });
      try {
        render(await call('proposal-response', { secret, decision }));
        pending = null;
      } catch (error) {
        root.querySelector('[data-reply-status]').textContent =
          error.message +
          (error.status >= 400 && error.status < 500
            ? ''
            : ' Повторите тот же ответ: дубль не создаётся.');
        if (error.status >= 400 && error.status < 500) pending = null;
        root.querySelectorAll('[data-reply]').forEach((b) => {
          b.disabled = Boolean(pending && b.dataset.reply !== pending);
        });
      } finally {
        busy = false;
      }
    });
  }
  return { initialize };
}
