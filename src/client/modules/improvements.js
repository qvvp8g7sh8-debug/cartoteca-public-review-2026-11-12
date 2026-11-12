function createImprovements(state, actions) {
  let scope = '',
    draft = '',
    items = [],
    next = null,
    loaded = false,
    expanded = false,
    loading = false,
    sending = false,
    pending = null,
    notice = '',
    sequence = 0;
  const currentScope = () => JSON.stringify([state.account?.id, state.account?.organizationId]);
  function resetScope() {
    if (scope === currentScope()) return;
    scope = currentScope();
    sequence++;
    draft = '';
    items = [];
    next = null;
    loaded = false;
    expanded = false;
    loading = false;
    sending = false;
    pending = null;
    notice = '';
  }
  function improvementSettingsHtml() {
    resetScope();
    if (!state.multiUser || !state.account?.organizationId) return '';
    return actions.settingsSectionHtml(
      'Развитие Картотеки',
      'improvement-settings',
      '<form id="improvement-form">' +
        '<label class="field" for="improvement-description">Что хотелось бы улучшить?</label>' +
        `<textarea id="improvement-description" name="description" rows="4" maxlength="1500" required aria-describedby="improvement-privacy improvement-message" placeholder="Опишите задачу и ожидаемый результат"${pending ? ' readonly' : ''}>${actions.esc(draft)}</textarea>` +
        '<p class="form-hint" id="improvement-privacy">Не указывайте пароли и данные клиентов.</p>' +
        '<div class="improvement-form-actions"><button class="primary" type="submit">Предложить улучшение</button></div>' +
        `<p id="improvement-message" role="status" aria-live="polite" aria-atomic="true" data-status="${notice === 'Отправлено' ? 'sent' : ''}">${actions.esc(notice)}</p></form>` +
        '<section class="improvement-history" aria-labelledby="improvement-list-title">' +
        '<div class="improvement-list-heading"><h3 id="improvement-list-title">Мои предложения</h3>' +
        '<button class="text-btn improvement-refresh" type="button" data-improvement-refresh aria-label="Обновить мои предложения" aria-controls="improvement-list">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 7v5h-5M4 17v-5h5M6.1 6.3A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.7"/></svg>' +
        '<span>Обновить</span></button></div>' +
        '<p class="form-hint improvement-history-hint">Здесь видны только ваши предложения и их статус.</p>' +
        '<div id="improvement-list" aria-labelledby="improvement-list-title"></div>' +
        '<button class="text-btn" type="button" data-improvement-more hidden>Показать ещё</button></section>',
    );
  }
  function improvementsVisible() {
    return (
      state.currentView === 'settings' &&
      Boolean(actions.$('#improvement-settings')?.closest('details')?.open)
    );
  }
  function renderImprovements() {
    const root = actions.$('#improvement-settings');
    if (!root || scope !== currentScope()) return;
    const form = root.querySelector('#improvement-form');
    form.querySelector('textarea').readOnly = sending || Boolean(pending);
    form.querySelector('button[type="submit"]').disabled = sending;
    form.querySelector('button[type="submit"]').textContent = sending
      ? 'Отправляем…'
      : pending
        ? 'Повторить отправку'
        : 'Предложить улучшение';
    const refresh = root.querySelector('[data-improvement-refresh]');
    refresh.disabled = loading || sending;
    refresh.querySelector('span').textContent = loading ? 'Обновляем…' : 'Обновить';
    const message = root.querySelector('#improvement-message');
    message.textContent = notice;
    message.dataset.status = notice === 'Отправлено' ? 'sent' : '';
    const list = root.querySelector('#improvement-list');
    list.setAttribute('aria-busy', String(loading));
    list.innerHTML = items.length
      ? items
          .map(
            (item) =>
              `<article class="improvement-item"><div class="improvement-item-heading"><small>${actions.esc(new Date(item.createdAt).toLocaleDateString('ru-RU'))}</small>` +
              `<span class="improvement-state" data-improvement-state="${actions.esc(item.state)}">${actions.esc(actions.improvementStatusLabel(item.state))}</span></div>` +
              `<p>${actions.esc(item.description)}</p></article>`,
          )
          .join('')
      : loading
        ? '<p class="form-hint improvement-empty">Загружаем предложения…</p>'
        : loaded
          ? '<p class="form-hint improvement-empty">Пока нет предложений. Поделитесь первой идеей в форме выше.</p>'
          : '<p class="form-hint improvement-empty">Нажмите «Обновить», чтобы посмотреть предложения.</p>';
    const more = root.querySelector('[data-improvement-more]');
    more.hidden = !next;
    more.disabled = loading;
  }
  async function loadImprovements({ more = false, quiet = false } = {}) {
    resetScope();
    if (!improvementsVisible() || loading || sending || !state.account?.organizationId) return;
    const before = scope,
      serial = ++sequence,
      cursor = more ? next : null;
    loading = true;
    renderImprovements();
    try {
      const query = cursor ? '?' + new URLSearchParams(cursor).toString() : '';
      const result = await actions.readBackground('/api/support/improvements' + query);
      if (before !== currentScope() || serial !== sequence) return;
      if (more) {
        items = [
          ...items,
          ...result.items.filter((item) => !items.some((old) => old.id === item.id)),
        ];
        expanded = true;
        next = result.next;
      } else if (quiet && expanded) {
        items = [
          ...result.items,
          ...items.filter((item) => !result.items.some((fresh) => fresh.id === item.id)),
        ];
      } else {
        items = result.items;
        expanded = false;
        next = result.next;
      }
      loaded = true;
    } catch (error) {
      if (before === currentScope() && serial === sequence && !quiet) notice = error.message;
    } finally {
      if (before === currentScope() && serial === sequence) {
        loading = false;
        renderImprovements();
      }
    }
  }
  async function submitImprovement(form) {
    resetScope();
    if (sending) return;
    const text = form.querySelector('textarea').value.trim();
    if (!text || text.length > 1500) return;
    if (pending && pending.description !== text) {
      notice = 'Повторите прежнее предложение: результат отправки пока неизвестен.';
      renderImprovements();
      return;
    }
    if (!pending) {
      const bytes = window.crypto.getRandomValues(new Uint8Array(16));
      const hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
      pending = {
        description: text,
        requestId: [
          hex.slice(0, 8),
          hex.slice(8, 12),
          hex.slice(12, 16),
          hex.slice(16, 20),
          hex.slice(20),
        ].join('-'),
      };
    }
    const before = scope;
    sequence++;
    loading = false;
    draft = text;
    sending = true;
    notice = 'Сохраняем предложение…';
    renderImprovements();
    try {
      const result = await actions.request('/api/support/improvements', {
        method: 'POST',
        body: JSON.stringify(pending),
      });
      if (before !== currentScope()) return;
      const receipt = result.receipt;
      items = [
        {
          id: receipt.id,
          createdAt: receipt.createdAt,
          description: receipt.description,
          state: receipt.improvementState,
        },
        ...items.filter((item) => item.id !== receipt.id),
      ];
      draft = '';
      pending = null;
      loaded = true;
      form.querySelector('textarea').value = '';
      actions.markSettingsSaved(form);
      notice = 'Отправлено';
    } catch (error) {
      if (before === currentScope()) {
        if (!error.outcomeUnknown) pending = null;
        notice = error.outcomeUnknown
          ? 'Нет ответа сервера. Текст сохранён; повторите отправку — дубликат не создастся.'
          : error.message;
      }
    } finally {
      if (before === currentScope()) {
        sending = false;
        renderImprovements();
      }
    }
  }
  function bindImprovementEvents() {
    document.addEventListener('input', (event) => {
      if (event.target.id !== 'improvement-description') return;
      draft = event.target.value;
      if (notice === 'Отправлено') {
        notice = '';
        const message = actions.$('#improvement-message');
        if (message) {
          message.textContent = '';
          message.dataset.status = '';
        }
      }
    });
    document.addEventListener('submit', (event) => {
      if (event.target.id !== 'improvement-form') return;
      event.preventDefault();
      void submitImprovement(event.target);
    });
    document.addEventListener('click', (event) => {
      const root = event.target.closest('#improvement-settings');
      if (!root) return;
      if (event.target.closest('[data-improvement-refresh]')) {
        void loadImprovements();
      } else if (event.target.closest('[data-improvement-more]')) {
        void loadImprovements({ more: true });
      }
    });
    document.addEventListener(
      'toggle',
      (event) => {
        if (event.target.open && event.target.querySelector?.('#improvement-settings')) {
          renderImprovements();
          void loadImprovements();
        }
      },
      true,
    );
  }
  return { improvementSettingsHtml, improvementsVisible, loadImprovements, bindImprovementEvents };
}
