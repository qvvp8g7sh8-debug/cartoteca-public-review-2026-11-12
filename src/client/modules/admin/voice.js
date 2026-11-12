function createAdminVoice({ $, request, records, message }) {
  const view = createAdminVoiceView({ records }),
    pending = new WeakMap();
  const root = $('#admin-voice-assistant');
  let snapshot = null,
    member = null,
    identity = null,
    generation = 0,
    memberGeneration = 0;
  const result = (form, text, error = false) => {
    const node = form.querySelector('[data-voice-result]');
    node.textContent = text;
    node.dataset.status = error ? 'error' : 'success';
  };
  const dirty = (form) => Boolean(form?.dataset.dirty);
  const currentForm = (kind) => root.querySelector('[data-admin-voice-form="' + kind + '"]');
  const picker = createAdminVoiceMembers({
    $,
    request,
    records,
    canLeave: discardMember,
    onSelect: () => loadMember(),
  });
  const selected = () => picker.target();
  const behavior = createAdminVoiceBehavior({
    root: $('#admin-voice-behavior'),
    request,
    records,
    requestId: id,
    onCommitted: () => refreshAfterSave('behavior'),
  });
  function id() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const value = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    return [
      value.slice(0, 8),
      value.slice(8, 12),
      value.slice(12, 16),
      value.slice(16, 20),
      value.slice(20),
    ].join('-');
  }
  function applySnapshot(data, replaceSettings = true) {
    snapshot = data;
    if (replaceSettings) $('#admin-voice-settings').innerHTML = view.settings(data);
    if (!dirty(currentForm('restore')))
      $('#admin-voice-history').innerHTML = view.history(data.history || [], data.revision);
    picker.seed(data.memberships, data.membershipsTruncated);
    if (!$('#admin-voice-account').value) {
      memberGeneration++;
      member = null;
      identity = null;
      $('#admin-voice-member').textContent = 'Выберите организацию и пользователя.';
    }
  }
  async function loadAudit() {
    const serial = generation;
    try {
      const data = await request('/api/admin/voice-assistant/audit');
      if (serial === generation) $('#admin-voice-audit').innerHTML = view.audit(data.items || []);
    } catch (error) {
      if (serial === generation) $('#admin-voice-audit').textContent = error.message;
    }
  }
  async function load({ discard = false } = {}) {
    if (
      !discard &&
      root.querySelector('[data-admin-voice-draft][data-dirty]') &&
      !confirm('Перечитать настройки без сохранения введённых изменений?')
    )
      return;
    const serial = ++generation;
    $('#admin-voice-loading').textContent = 'Загружаем настройки помощника…';
    root.setAttribute('aria-busy', 'true');
    try {
      const data = await request('/api/admin/voice-assistant');
      if (serial !== generation) return;
      view.providers.reset();
      applySnapshot(data);
      $('#admin-voice-loading').textContent = '';
      void behavior.load({ discard: true });
      const target = selected();
      if (target.organizationId) await picker.refresh();
      void loadAudit();
    } catch (error) {
      if (serial === generation) $('#admin-voice-loading').textContent = error.message;
    } finally {
      if (serial === generation) root.removeAttribute('aria-busy');
    }
  }
  async function loadMember() {
    const serial = ++memberGeneration,
      target = selected();
    member = null;
    identity = picker.identity();
    const area = $('#admin-voice-member');
    area.textContent = identity
      ? 'Загружаем персональный доступ…'
      : 'Выберите организацию и пользователя.';
    if (!identity) return;
    const expectedIdentity = identity;
    try {
      const data = await request(
        '/api/admin/voice-assistant/member?' + new URLSearchParams(target),
      );
      if (serial !== memberGeneration || identity !== expectedIdentity) return;
      member = data;
      area.innerHTML = view.membership(data, identity);
    } catch (error) {
      if (serial === memberGeneration) area.textContent = error.message;
    }
  }
  function settingsPayload(form) {
    const values = new FormData(form),
      policy = {
        mode: values.get('mode'),
        commands: {},
        limits: {},
      };
    for (const key of Object.keys(view.commands))
      policy.commands[key] = values.has('command.' + key);
    for (const key of Object.keys(view.limits))
      policy.limits[key] = Number(values.get('limit.' + key));
    const providers = {};
    for (const stage of ['stt', 'llm', 'tts']) {
      providers[stage] = {
        provider: values.get('provider.' + stage),
        model: values
          .get(
            stage === 'llm' && values.get('provider.llm') === 'codex'
              ? 'model.codex'
              : 'model.' + stage,
          )
          .trim(),
      };
      if (stage === 'tts') providers[stage].voice = values.get('voice.tts').trim();
    }
    const rates = Object.fromEntries(
      Object.keys(view.rates).map((key) => [key, Number(values.get('rate.' + key))]),
    );
    const body = { policy, providers, rates },
      key = values.get('timewebApiKey').trim();
    if (key && values.has('removeTimewebKey'))
      throw Error('Введите новый ключ или выберите удаление ключа.');
    if (key) body.timewebApiKey = key;
    else if (values.has('removeTimewebKey')) body.timewebApiKey = null;
    return body;
  }
  function memberPayload(values) {
    const limits = {};
    for (const key of Object.keys(view.limits)) {
      if (key === 'monthlyBudgetRub') continue;
      const value = values.get('memberLimit.' + key);
      if (value !== null && value.trim() !== '') limits[key] = Number(value);
    }
    return {
      ...selected(),
      enabled: values.has('enabled'),
      limits: Object.keys(limits).length ? limits : null,
    };
  }
  async function refreshAfterSave(kind, form) {
    const serial = ++generation;
    try {
      const data = await request('/api/admin/voice-assistant');
      if (serial !== generation) return;
      applySnapshot(
        data,
        kind === 'settings' || kind === 'restore' || !dirty(currentForm('settings')),
      );
      if (!dirty(currentForm('member'))) await loadMember();
      void loadAudit();
      if (kind !== 'behavior') await behavior.refresh();
    } catch {
      if (form)
        result(
          form,
          'Изменения сохранены. Перечитайте настройки, чтобы увидеть актуальное состояние.',
        );
    }
  }
  async function submit(form) {
    if (form.dataset.busy) return;
    const kind = form.dataset.adminVoiceForm;
    let operation = pending.get(form);
    if (!operation && !form.reportValidity()) return;
    try {
      if (!operation) {
        const values = new FormData(form);
        const body =
          kind === 'settings'
            ? settingsPayload(form)
            : kind === 'restore'
              ? { revision: Number(values.get('revision')) }
              : memberPayload(values);
        if (
          kind === 'restore' &&
          !confirm(
            'Восстановить выбранные настройки? Несохранённые общие настройки будут заменены. Правила поведения, ключ и персональные разрешения сохранятся.',
          )
        )
          return;
        Object.assign(body, {
          expectedRevision: Number(form.dataset.revision),
          requestId: id(),
          reason: values.get('reason').trim(),
        });
        if (body.reason.length < 3 || body.reason.length > 300)
          throw Error('Укажите причину длиной от 3 до 300 символов.');
        operation = {
          body,
          route:
            '/api/admin/voice-assistant/' +
            (kind === 'settings' ? 'settings' : kind === 'restore' ? 'restore' : 'member'),
        };
      }
    } catch (error) {
      result(form, error.message, true);
      return;
    }
    pending.set(form, operation);
    form.dataset.busy = '1';
    form.dataset.dirty = '1';
    const fieldset = form.querySelector('[data-voice-fields]'),
      button = form.querySelector('[type="submit"]');
    fieldset.disabled = true;
    button.disabled = true;
    form.querySelector('[data-voice-reload]')?.setAttribute('disabled', '');
    result(form, 'Сохраняем…');
    try {
      const saved = await request(operation.route, {
        method: 'POST',
        body: JSON.stringify(operation.body),
      });
      operation.unknown = false;
      pending.delete(form);
      delete form.dataset.dirty;
      if (kind === 'restore' && currentForm('settings'))
        delete currentForm('settings').dataset.dirty;
      if (saved.revision !== undefined) form.dataset.revision = saved.revision;
      result(form, 'Изменения сохранены.');
      message('Настройки помощника сохранены.');
      await refreshAfterSave(kind, form);
    } catch (error) {
      operation.unknown = Boolean(error.unknown);
      if (!operation.unknown) pending.delete(form);
      result(
        form,
        operation.unknown
          ? 'Ответ не получен. Повторите сохранение: будет отправлена та же команда.'
          : error.status === 409
            ? 'Настройки уже изменились. Перечитайте их перед сохранением.'
            : error.message,
        true,
      );
    } finally {
      const key = form.querySelector('[name="timewebApiKey"]');
      if (key) key.value = '';
      delete form.dataset.busy;
      fieldset.disabled = Boolean(operation.unknown);
      button.disabled = false;
      if (operation.unknown) button.textContent = 'Повторить сохранение';
      else form.querySelector('[data-voice-reload]')?.removeAttribute('disabled');
    }
  }
  function discardMember() {
    const form = currentForm('member');
    return (
      !dirty(form) ||
      confirm('Перейти к другому пользователю без сохранения персонального доступа?')
    );
  }
  function bind() {
    view.providers.bind(root);
    picker.bind();
    behavior.bind();
    root.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-admin-voice-form]');
      if (!form) return;
      event.preventDefault();
      void submit(form);
    });
    root.addEventListener('input', (event) => {
      const form = event.target.closest('[data-admin-voice-draft]');
      if (form) form.dataset.dirty = '1';
    });
    root.addEventListener('change', (event) => {
      const form = event.target.closest('[data-admin-voice-draft]');
      if (form) form.dataset.dirty = '1';
    });
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-voice-reload]')) {
        if (
          !root.querySelector('[data-admin-voice-draft][data-dirty]') ||
          confirm('Перечитать настройки без сохранения введённых изменений?')
        )
          void load({ discard: true });
      }
      if (event.target.closest('[data-voice-member-reload]') && discardMember())
        void picker.refresh();
      if (event.target.closest('[data-voice-audit-reload]')) void loadAudit();
    });
    window.addEventListener('beforeunload', (event) => {
      if (!root.querySelector('[data-admin-voice-draft][data-dirty]')) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }
  return { load, bind };
}
