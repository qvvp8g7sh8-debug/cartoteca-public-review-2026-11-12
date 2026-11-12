function createSupportRequests(state, actions) {
  let scope = '',
    accountContext = null,
    contextChanged = false,
    pendingKey = '',
    pendingSignature = '',
    pendingDiagnostics = null,
    receipt = null,
    receiptRead = null,
    timer = null;
  const contextError = () =>
    Object.assign(Error('Учётная запись изменилась. Откройте кабинет заново.'), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      outcomeUnknown: false,
    });
  const currentContext = (context = accountContext) =>
    context === accountContext &&
    !contextChanged &&
    context?.accountId === (state.account?.id || '') &&
    context?.organizationId === (state.account?.organizationId || '');
  async function request(route, options = {}) {
    const context = accountContext;
    if (!currentContext(context) || (state.multiUser && !context.accountId)) throw contextError();
    const response = await fetch(route, {
      ...options,
      headers: {
        ...options.headers,
        'X-Cartoteca-Account-Id': context.accountId,
        'X-Cartoteca-Organization-Id': context.organizationId,
      },
    });
    if (!currentContext(context)) throw contextError();
    if (response.status === 428) {
      contextChanged = true;
      clearSupportReceipt();
      pendingKey = pendingSignature = '';
      pendingDiagnostics = null;
      location.replace('/');
      throw contextError();
    }
    return response;
  }
  function supportRequestFormHtml(draft, serverForm) {
    return (
      [
        '<form id="support-form" novalidate>',
        '<div class="settings-label-row"><label class="field" ',
        'for="support-description">Что случилось или какой у вас вопрос?</label>',
        actions.settingsHelpHtml(
          'Как описать проблему',
          'Напишите, что делали и что произошло. Например: «В календаре не сохраняется запись. После нажатия “Сохранить” появляется ошибка».',
        ),
        '</div>',
      ].join('') +
      [
        '<textarea id="support-description" ',
        'name="description" ',
        'rows="4" ',
        'maxlength="1500" required aria-describedby="support-privacy support-message">',
      ].join('') +
      actions.esc(draft) +
      '</textarea>' +
      [
        '<div class="settings-label-row"><p id="support-privacy" ',
        'class="form-hint">Не указывайте пароли и данные клиентов.</p>',
        '<span id="support-privacy-help">',
        actions.settingsHelpHtml(
          'Отправка и конфиденциальность',
          'Не указывайте пароли, токены и данные клиентов. Технические сведения прикладываются автоматически. Ответим на почту вашего аккаунта.',
        ),
        '</span>',
        '</div>',
      ].join('') +
      '<div class="support-actions"><button type="submit" class="primary" id="support-open-telegram" disabled>' +
      (serverForm ? 'Отправить' : 'Продолжить в Telegram') +
      '</button></div>' +
      [
        '<div id="support-contact">',
        '<p class="form-hint">Проверяем связь с поддержкой…</p>',
        '</div>',
        '<p id="support-message" ',
        'role="status" ',
        'aria-live="polite" ',
        'aria-atomic="true">',
        '</p>',
      ].join('') +
      '<a id="support-chat-fallback" class="support-chat-fallback" target="_blank" rel="noopener noreferrer" hidden>Открыть подготовленное сообщение</a>' +
      '</form>' +
      '<section id="support-thread" class="support-thread" hidden><h3>Ответы по обращению</h3><div id="support-thread-messages"></div>' +
      '<form id="support-reply-form"><label class="field">Уточнение для поддержки<textarea name="text" rows="3" required maxlength="1500"></textarea></label>' +
      '<button class="secondary" type="submit">Ответить</button><p id="support-reply-status" role="status" aria-live="polite"></p></form></section>'
    );
  }
  function setSupportMessage(text, status = '') {
    const message = actions.$('#support-message');
    if (!message) return;
    message.textContent = text;
    message.dataset.status = status;
  }
  function clearSupportReceipt() {
    receipt = null;
    receiptRead = null;
    window.clearTimeout(timer);
    setSupportMessage('');
  }
  function resetSupportRequestScope(value) {
    const context = {
      accountId: state.account?.id || '',
      organizationId: state.account?.organizationId || '',
    };
    if (
      context.accountId !== accountContext?.accountId ||
      context.organizationId !== accountContext?.organizationId
    )
      contextChanged = false;
    accountContext = context;
    scope = value;
    pendingKey = '';
    pendingSignature = '';
    pendingDiagnostics = null;
    clearSupportReceipt();
  }
  function renderSupportReceipt() {
    const message = actions.$('#support-message');
    if (!message || !receipt) return;
    const statuses = Object.values(receipt.deliveries),
      sent = statuses.includes('sent');
    const pending = statuses.some((status) => ['pending', 'sending', 'waiting'].includes(status));
    const heading = sent
      ? '✓ Сообщение успешно отправлено.'
      : pending
        ? 'Сообщение принято. Передаём в техподдержку…'
        : 'Не удалось доставить сообщение в техподдержку.';
    let details =
      'Обращение № ' +
      receipt.id.slice(0, 8) +
      (sent ? ' передано поддержке.' : ' сохранено в картотеке.') +
      ' Ответим на ' +
      receipt.replyEmail +
      '.';
    if (receipt.deliveries.email === 'failed')
      details += ' Почтовая копия не доставлена; Telegram обрабатывается отдельно.';
    setSupportMessage(heading + '\n' + details, sent ? 'success' : pending ? 'pending' : 'error');
    renderThread();
  }
  function renderThread() {
    const container = actions.$('#support-thread');
    if (!container || !receipt) return;
    const replies = receipt.messages || [];
    container.hidden = replies.length === 0 && receipt.state !== 'waiting';
    actions.$('#support-thread-messages').innerHTML = replies
      .map(
        (item) =>
          '<article class="support-thread-message"><small>' +
          (item.kind === 'reply' ? 'Поддержка' : 'Вы') +
          ' · ' +
          actions.esc(new Date(item.createdAt).toLocaleString('ru-RU')) +
          '</small><p>' +
          actions.esc(item.text) +
          '</p></article>',
      )
      .join('');
    const form = actions.$('#support-reply-form');
    if (form.dataset.bound) return;
    form.dataset.bound = '1';
    let pendingReply = null;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const before = scope,
        caseId = receipt?.id,
        text = new FormData(form).get('text').trim();
      const button = form.querySelector('button'),
        status = actions.$('#support-reply-status');
      if (!text || text.length > 1500 || button.disabled) return;
      if (pendingReply && (pendingReply.scope !== before || pendingReply.caseId !== caseId))
        pendingReply = null;
      if (pendingReply && pendingReply.text !== text) {
        status.textContent = 'Сначала повторите прежний ответ: результат его отправки неизвестен.';
        return;
      }
      if (!pendingReply) {
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        const hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
        pendingReply = {
          scope: before,
          caseId,
          text,
          requestId: [
            hex.slice(0, 8),
            hex.slice(8, 12),
            hex.slice(12, 16),
            hex.slice(16, 20),
            hex.slice(20),
          ].join('-'),
        };
      }
      button.disabled = true;
      try {
        const response = await request('/api/support/reply', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
          body: JSON.stringify({ caseId, text, requestId: pendingReply.requestId }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await response.json();
        if (!response.ok) {
          pendingReply = null;
          throw Error(data.error || 'Не удалось сохранить ответ.');
        }
        if (before !== scope || !currentContext() || receipt?.id !== caseId) return;
        pendingReply = null;
        form.reset();
        status.textContent = 'Ответ сохранён. Обращение снова ожидает обработки.';
        await refreshSupportReceipt();
      } catch (error) {
        if (error.code === 'AUTH_CONTEXT_CHANGED') pendingReply = null;
        if (before === scope)
          status.textContent = pendingReply
            ? 'Ответ сервера не получен. Повторите отправку с прежним текстом — дубликат не создастся.'
            : error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
  function schedule() {
    window.clearTimeout(timer);
    if (
      receipt &&
      (receipt.state !== 'resolved' ||
        Object.values(receipt.deliveries).some((status) =>
          ['pending', 'sending', 'waiting'].includes(status),
        )) &&
      document.visibilityState !== 'hidden' &&
      actions.$('#support-settings')
    )
      timer = window.setTimeout(
        () => {
          void refreshSupportReceipt();
        },
        Object.values(receipt.deliveries).some((status) =>
          ['pending', 'sending', 'waiting'].includes(status),
        )
          ? 5000
          : 30000,
      );
  }
  async function refreshSupportReceipt() {
    if (!receipt || document.visibilityState === 'hidden' || !actions.$('#support-settings'))
      return;
    if (
      receiptRead?.scope === scope &&
      receiptRead.id === receipt.id &&
      receiptRead.receipt === receipt
    )
      return receiptRead.promise;
    const read = { scope, id: receipt.id, receipt, promise: null };
    receiptRead = read;
    read.promise = (async () => {
      try {
        const response = await request('/api/support/requests?id=' + encodeURIComponent(read.id), {
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
          const data = await response.json();
          if (
            currentContext() &&
            receiptRead === read &&
            read.scope === scope &&
            read.receipt === receipt
          ) {
            receipt = data.receipt;
            read.receipt = receipt;
          }
        }
      } catch {
        /* Keep the saved receipt; connection loss does not mean request loss. */
      }
      if (receiptRead !== read) return;
      receiptRead = null;
      if (!currentContext() || read.scope !== scope || read.receipt !== receipt) return;
      renderSupportReceipt();
      schedule();
    })();
    return read.promise;
  }
  async function sendSupportRequest(body) {
    const signature = JSON.stringify([body.description, Boolean(body.diagnostics)]),
      before = scope;
    if (!pendingKey || signature !== pendingSignature) {
      // getRandomValues also works on HTTP Wi-Fi, unlike crypto.randomUUID.
      const bytes = window.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
      pendingKey = [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
      ].join('-');
      pendingSignature = signature;
      pendingDiagnostics = body.diagnostics;
    }
    const payload = {
      description: body.description,
      diagnostics: pendingDiagnostics,
      requestId: pendingKey,
    };
    const response = await request('/api/support/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
      cache: 'no-store',
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Не удалось отправить обращение.');
    if (before !== scope || !currentContext()) return null;
    receipt = data.receipt;
    pendingKey = '';
    pendingSignature = '';
    pendingDiagnostics = null;
    renderSupportReceipt();
    schedule();
    return receipt;
  }
  return {
    supportRequestFormHtml,
    setSupportMessage,
    resetSupportRequestScope,
    clearSupportReceipt,
    renderSupportReceipt,
    refreshSupportReceipt,
    sendSupportRequest,
  };
}
