function createAdminVoiceBehavior({ root, request, records, requestId, onCommitted }) {
  if (!root) return { load: async () => {}, refresh: async () => {}, bind() {} };
  root.innerHTML =
    '<p data-behavior-status role="status" aria-live="polite"></p><div data-behavior-body></div><div data-behavior-library></div>';
  const body = root.querySelector('[data-behavior-body]');
  const view = createAdminVoiceBehaviorView({ records });
  const diff = createAdminVoiceBehaviorDiff({ records });
  const route = '/api/admin/voice-assistant/behavior';
  const identity = () => document.querySelector('#admin-identity')?.textContent || '';
  let snapshot = null,
    reviewed = null,
    pending = null,
    busy = false,
    bound = false,
    revoked = false;
  let generation = 0,
    previewGeneration = 0,
    compareGeneration = 0,
    editGeneration = 0;
  let knownIdentity = identity();
  const disabled = new Map();
  const node = (selector) => root.querySelector(selector);
  function status(text, error = false) {
    const area = node('[data-behavior-status]');
    area.textContent = text;
    area.dataset.status = error ? 'error' : 'success';
  }
  const hasDraft = () => Boolean(root.querySelector('[data-admin-voice-draft][data-dirty]'));
  function lock(value) {
    if (value)
      root.querySelectorAll('button,input,select,textarea').forEach((item) => {
        if (!disabled.has(item)) disabled.set(item, item.disabled);
        item.disabled = true;
      });
    else {
      for (const [item, previous] of disabled) if (item.isConnected) item.disabled = previous;
      disabled.clear();
    }
  }
  function invalidateReview() {
    editGeneration++;
    previewGeneration++;
    reviewed = null;
    const area = node('[data-behavior-review]');
    if (area)
      area.textContent = 'Черновик изменён. Повторите предварительный просмотр перед утверждением.';
  }
  const editor = createAdminVoiceBehaviorEditor({
    root: body,
    view,
    requestId,
    onChange: invalidateReview,
    status,
  });
  const library = createAdminVoiceBehaviorLibrary({
    root: node('[data-behavior-library]'),
    request,
    records,
    behaviorView: view,
    addCases: editor.importCases,
    canEdit: () => Boolean(snapshot) && !busy && !pending && !revoked,
    onDenied: denied,
  });
  function revoke() {
    generation++;
    previewGeneration++;
    compareGeneration++;
    snapshot = reviewed = pending = null;
    busy = false;
    revoked = true;
    disabled.clear();
    body.textContent = '';
    library.clear();
    status('Доступ или сессия изменились. Откройте раздел заново после входа.', true);
  }
  function active(serial, key) {
    if (identity() !== key) {
      revoke();
      return false;
    }
    return serial === generation && !revoked;
  }
  function denied(error) {
    if ([401, 403].includes(error.status)) {
      revoke();
      return true;
    }
    return false;
  }
  function apply(data, preserveDraft = false) {
    snapshot = data;
    library.available();
    reviewed = null;
    previewGeneration++;
    if (!preserveDraft || !node('[data-behavior-rules]')) editor.render(data);
    else {
      node('[data-behavior-provider]').textContent = view.provider(data);
      node('[data-behavior-review]').textContent =
        'Текущая версия перечитана. Черновик сохранён; повторите просмотр изменений.';
    }
    node('[data-behavior-versions]').innerHTML = view.versions(data);
  }
  async function load({ preserveDraft = false, discard = false } = {}) {
    if (busy || pending) return;
    if (
      hasDraft() &&
      !preserveDraft &&
      !discard &&
      !confirm('Заменить несохранённый черновик поведения текущей версией сервера?')
    )
      return;
    const serial = ++generation,
      key = identity(),
      edits = editGeneration;
    knownIdentity = key;
    revoked = false;
    busy = true;
    status('Загружаем правила поведения…');
    lock(true);
    try {
      const data = await request(route);
      if (!active(serial, key)) return;
      apply(data, preserveDraft || edits !== editGeneration);
      status(
        'Текущая версия поведения: ' +
          data.version +
          '. Изменения в редакторе сохраняются только после утверждения.',
      );
    } catch (error) {
      if (active(serial, key) && !denied(error)) status(error.message, true);
    } finally {
      if (serial === generation) {
        busy = false;
        lock(false);
      }
    }
  }
  async function refresh() {
    await load({ preserveDraft: hasDraft() || Boolean(node('[data-behavior-example]')) });
  }
  async function preview(sourceVersion = null) {
    if (busy || pending || !snapshot) return;
    let payload;
    try {
      payload = {
        expectedRevision: snapshot.revision,
        ...(sourceVersion === null ? { rules: editor.rules() } : { sourceVersion }),
      };
    } catch (error) {
      status(error.message, true);
      return;
    }
    const serial = generation,
      previewSerial = ++previewGeneration,
      key = identity();
    reviewed = null;
    busy = true;
    lock(true);
    node('[data-behavior-review]').textContent = '';
    status('Проверяем черновик и готовим сравнение…');
    try {
      const data = await request(route + '/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!active(serial, key) || previewSerial !== previewGeneration) return;
      reviewed = data;
      node('[data-behavior-review]').innerHTML = diff.review(data);
      status('Просмотрите изменения, укажите причину и подтвердите применение.');
    } catch (error) {
      if (active(serial, key) && !denied(error))
        status(
          error.status === 409
            ? 'Версия уже изменилась. Черновик сохранён: перечитайте версии, затем повторите просмотр.'
            : error.message,
          true,
        );
    } finally {
      if (serial === generation) {
        busy = false;
        lock(false);
      }
    }
  }
  async function approve(form) {
    if (busy || (!pending && !reviewed)) return;
    if (!pending && !form.reportValidity()) return;
    let operation = pending;
    if (!operation) {
      const values = new FormData(form),
        reason = String(values.get('reason') || '').trim();
      if (reason.length < 3 || reason.length > 300 || !values.has('confirmed')) {
        status(
          'Просмотрите изменения, подтвердите их и укажите причину от 3 до 300 символов.',
          true,
        );
        return;
      }
      const restore = reviewed.sourceVersion !== null;
      const payload = {
        expectedRevision: reviewed.revision,
        requestId: requestId(),
        reason,
        ...(restore ? { sourceVersion: reviewed.sourceVersion } : { rules: reviewed.rules }),
        reviewHash: reviewed.reviewHash,
        confirmed: true,
      };
      operation = {
        route: route + (restore ? '/restore' : '/approve'),
        body: JSON.stringify(payload),
      };
    }
    const serial = generation,
      key = identity(),
      button = form.querySelector('[type="submit"]');
    pending = operation;
    busy = true;
    lock(true);
    status('Утверждаем изменения…');
    try {
      const data = await request(operation.route, { method: 'POST', body: operation.body });
      if (!active(serial, key)) return;
      pending = null;
      apply(data);
      status(
        'Версия ' +
          data.version +
          ' утверждена. Правила применяются к следующим запросам реальной модели.',
      );
      await onCommitted?.();
    } catch (error) {
      if (!active(serial, key) || denied(error)) return;
      if (error.unknown || error.outcomeUnknown) {
        status(
          'Ответ не получен. Повторите утверждение: будет отправлена та же команда с тем же идентификатором.',
          true,
        );
        button.textContent = 'Повторить утверждение';
      } else {
        pending = null;
        if (error.status === 409) {
          reviewed = null;
          node('[data-behavior-review]').textContent =
            'Версия изменилась. Черновик сохранён. Перечитайте версии и снова просмотрите изменения.';
        }
        status(error.message, true);
      }
    } finally {
      if (serial === generation) {
        busy = false;
        if (pending) button.disabled = false;
        else lock(false);
      }
    }
  }
  async function compare(form) {
    if (busy || pending || !snapshot) return;
    const values = new FormData(form),
      serial = generation,
      key = identity();
    const compareSerial = ++compareGeneration;
    const query = new URLSearchParams({
      fromVersion: values.get('fromVersion'),
      toVersion: values.get('toVersion'),
    });
    const area = node('[data-behavior-comparison]');
    area.textContent = 'Загружаем сравнение…';
    try {
      const data = await request(route + '/compare?' + query);
      if (!active(serial, key) || compareSerial !== compareGeneration) return;
      area.innerHTML =
        '<h4>Сравнение версий ' +
        records.esc(data.fromVersion) +
        ' → ' +
        records.esc(data.toVersion) +
        '</h4>' +
        diff.render(data.changes);
    } catch (error) {
      if (active(serial, key) && compareSerial === compareGeneration && !denied(error))
        area.textContent = error.message;
    }
  }
  function bind() {
    if (bound) return;
    bound = true;
    editor.bind();
    root.addEventListener('submit', (event) => {
      const form = event.target.closest('form');
      if (!form || !root.contains(form)) return;
      if (form.hasAttribute('data-behavior-rules')) {
        event.preventDefault();
        void preview();
      }
      if (form.hasAttribute('data-behavior-approve')) {
        event.preventDefault();
        void approve(form);
      }
      if (form.hasAttribute('data-behavior-compare')) {
        event.preventDefault();
        void compare(form);
      }
      if (form.hasAttribute('data-behavior-restore')) {
        event.preventDefault();
        if (form.reportValidity()) void preview(Number(new FormData(form).get('sourceVersion')));
      }
    });
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-behavior-reload]')) void load();
      if (event.target.closest('[data-behavior-rebase]')) void load({ preserveDraft: true });
    });
    for (const type of ['input', 'change'])
      root.addEventListener(type, (event) => {
        const form = event.target.closest('[data-admin-voice-draft]');
        if (form) form.dataset.dirty = '1';
        if (type === 'change' && event.target.closest('[data-behavior-restore]'))
          invalidateReview();
      });
    window.addEventListener('beforeunload', (event) => {
      if (!hasDraft()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    const identityNode = document.querySelector('#admin-identity');
    if (identityNode)
      new window.MutationObserver(() => {
        if (knownIdentity !== identity()) {
          knownIdentity = identity();
          revoke();
        }
      }).observe(identityNode, { childList: true, subtree: true, characterData: true });
  }
  return { load, refresh, bind };
}
