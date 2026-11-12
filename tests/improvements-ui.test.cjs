const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
function fixture(t, request, desktop = false) {
  const dom = new JSDOM('<body></body>', {
    url: 'http://127.0.0.1:4174/',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const mediaListeners = [];
  const media = {
    matches: desktop,
    addEventListener: (name, callback) => {
      if (name === 'change') mediaListeners.push(callback);
    },
  };
  dom.window.matchMedia = () => media;
  for (const source of ['src/shared/improvement-status.cjs', 'src/client/modules/improvements.js'])
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', source), 'utf8'));
  const state = {
    multiUser: true,
    account: { id: 'synthetic-author', organizationId: 'org-a' },
    currentView: 'settings',
  };
  let saved = 0;
  const storedItems = new Map();
  const scope = () => JSON.stringify([state.account.id, state.account.organizationId]);
  const actions = {
    $: (selector) => dom.window.document.querySelector(selector),
    esc: (text) =>
      String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    settingsSectionHtml: (_, id, body) =>
      `<details open><summary>Развитие</summary><div id="${id}">${body}</div></details>`,
    improvementStatusLabel: dom.window.improvementStatusLabel,
    readBackground: async () => ({
      items: structuredClone(storedItems.get(scope()) || []),
      next: null,
    }),
    request: async (...args) => {
      const before = scope();
      const result = await request(...args);
      if (result.receipt) {
        const receipt = result.receipt;
        storedItems.set(before, [
          {
            id: receipt.id,
            createdAt: receipt.createdAt,
            description: receipt.description,
            state: receipt.improvementState,
          },
          ...(storedItems.get(before) || []).filter((item) => item.id !== receipt.id),
        ]);
      }
      return result;
    },
    markSettingsSaved: () => {
      saved++;
    },
  };
  const api = dom.window.createImprovements(state, actions);
  dom.window.document.body.innerHTML = api.improvementSettingsHtml();
  api.bindImprovementEvents();
  const form = actions.$('#improvement-form'),
    textarea = actions.$('#improvement-description');
  const type = (text) => {
    textarea.value = text;
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const submit = () =>
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return {
    dom,
    state,
    actions,
    api,
    form,
    textarea,
    type,
    submit,
    saved: () => saved,
    resizeDesktop(value) {
      media.matches = value;
      for (const callback of mediaListeners) callback();
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('desktop proposal form is visible without an opener, reports success only after receipt and preserves its draft across widths', async (t) => {
  let finish;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    true,
  );
  assert.equal(f.form.hidden, false);
  assert.equal(f.actions.$('[data-improvement-new]'), null);
  assert.equal(f.actions.$('[data-improvement-cancel]'), null);
  assert.equal(f.form.querySelector('[type="submit"]').textContent, 'Предложить улучшение');
  f.type('Сделать настройки компактнее');
  f.submit();
  assert.notEqual(f.actions.$('#improvement-message').textContent, 'Отправлено');
  assert.equal(f.form.querySelector('[type="submit"]').disabled, true);
  assert.equal(f.actions.$('[data-improvement-refresh]').disabled, true);
  finish({
    receipt: {
      id: 'desktop-idea',
      createdAt: Date.now(),
      description: f.textarea.value,
      improvementState: 'received',
    },
  });
  await settle();
  assert.equal(f.form.hidden, false);
  assert.equal(f.actions.$('#improvement-message').textContent, 'Отправлено');
  assert.equal(f.actions.$('.improvement-state').textContent, 'Получено');
  f.type('Следующее предложение');
  assert.equal(f.actions.$('#improvement-message').textContent, '');
  f.resizeDesktop(false);
  assert.equal(f.form.hidden, false);
  assert.equal(f.textarea.value, 'Следующее предложение');
  f.resizeDesktop(true);
  assert.equal(f.form.hidden, false);
  assert.equal(f.textarea.value, 'Следующее предложение');
});

for (const desktop of [false, true]) {
  test(`${desktop ? 'desktop' : 'mobile'} proposal form is always visible and refresh belongs to the history heading`, (t) => {
    const f = fixture(
      t,
      async () => {
        throw Error('Unused');
      },
      desktop,
    );
    const heading = f.actions.$('.improvement-list-heading');
    const title = heading.querySelector('#improvement-list-title');
    const refresh = f.actions.$('[data-improvement-refresh]');
    assert.equal(f.form.hidden, false);
    assert.equal(f.form.querySelectorAll('button').length, 1);
    assert.equal(f.actions.$('[data-improvement-new]'), null);
    assert.equal(f.actions.$('[data-improvement-cancel]'), null);
    assert.equal(title.tagName, 'H3');
    assert.equal(title.textContent, 'Мои предложения');
    assert.equal(refresh.parentElement, heading);
    assert.equal(refresh.closest('form'), null);
    assert.equal(refresh.getAttribute('aria-controls'), 'improvement-list');
    assert.equal(
      f.actions.$('#improvement-list').getAttribute('aria-labelledby'),
      'improvement-list-title',
    );
    assert.ok(
      f.form.compareDocumentPosition(heading) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
}

test('refresh reports loading, prevents concurrent reads and restores its label for the empty list', async (t) => {
  const f = fixture(t, async () => {
    throw Error('Unused');
  });
  let finish;
  let reads = 0;
  f.actions.readBackground = () => {
    reads++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const loading = f.api.loadImprovements();
  const refresh = f.actions.$('[data-improvement-refresh]');
  const list = f.actions.$('#improvement-list');
  assert.equal(refresh.disabled, true);
  assert.equal(refresh.querySelector('span').textContent, 'Обновляем…');
  assert.equal(list.getAttribute('aria-busy'), 'true');
  assert.equal(list.textContent, 'Загружаем предложения…');
  refresh.click();
  await f.api.loadImprovements();
  assert.equal(reads, 1);
  finish({ items: [], next: null });
  await loading;
  assert.equal(refresh.disabled, false);
  assert.equal(refresh.querySelector('span').textContent, 'Обновить');
  assert.equal(list.getAttribute('aria-busy'), 'false');
  assert.equal(list.textContent, 'Пока нет предложений. Поделитесь первой идеей в форме выше.');
  assert.equal(f.form.hidden, false);
});

test('proposal UI has compact form, escaped author list and saved snapshot', async (t) => {
  const f = fixture(t, async (_, input) => ({
    receipt: {
      id: 'idea-1',
      createdAt: Date.now(),
      description: JSON.parse(input.body).description,
      improvementState: 'received',
    },
  }));
  assert.equal(f.form.hidden, false);
  f.type('<img src=x onerror=alert(1)> Сделать удобнее');
  f.submit();
  await settle();
  assert.equal(f.form.hidden, false);
  assert.equal(f.textarea.value, '');
  assert.equal(f.saved(), 1);
  assert.equal(f.actions.$('#improvement-list img'), null);
  assert.equal(f.actions.$('.improvement-state').textContent, 'Получено');
  f.actions.readBackground = async () => ({
    items: [{ id: 'idea-1', createdAt: Date.now(), description: 'Идея', state: 'done' }],
    next: null,
  });
  await f.api.loadImprovements();
  assert.equal(f.actions.$('.improvement-state').dataset.improvementState, 'done');
  assert.equal(f.actions.$('.improvement-state').textContent, 'Сделано');
});

test('unknown network result retains key and text; double submission creates no parallel request', async (t) => {
  const sent = [];
  let finish;
  const f = fixture(t, (_, input) => {
    sent.push(JSON.parse(input.body));
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  f.type('Исходная идея');
  f.submit();
  f.submit();
  assert.equal(sent.length, 1);
  assert.equal(f.textarea.readOnly, true);
  finish(Promise.reject(Object.assign(new Error('Offline'), { outcomeUnknown: true })));
  await settle();
  assert.equal(f.textarea.value, 'Исходная идея');
  assert.equal(f.textarea.readOnly, true);
  f.submit();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].requestId, sent[1].requestId);
  finish({
    receipt: {
      id: 'idea-1',
      createdAt: Date.now(),
      description: sent[1].description,
      improvementState: 'received',
    },
  });
  await settle();
  assert.equal(f.actions.$('#improvement-list').children.length, 1);
});

test('refresh and rendering keep draft; account switch clears former author data', async (t) => {
  const f = fixture(t, async () => {
    throw Error('Unused');
  });
  f.type('Не потерять черновик');
  f.actions.$('[data-improvement-refresh]').click();
  await settle();
  assert.equal(f.textarea.value, 'Не потерять черновик');
  assert.equal(f.form.hidden, false);
  assert.match(f.api.improvementSettingsHtml(), /Не потерять черновик/);
  f.state.account = { id: 'other-author', organizationId: 'org-b' };
  const html = f.api.improvementSettingsHtml();
  assert.doesNotMatch(html, /Не потерять черновик/);
});

test('late response from former organization never renders into new author screen', async (t) => {
  let finish;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.type('Первая организация');
  f.submit();
  f.state.account = { id: 'new-author', organizationId: 'org-b' };
  f.dom.window.document.body.innerHTML = f.api.improvementSettingsHtml();
  finish({
    receipt: {
      id: 'old',
      createdAt: Date.now(),
      description: 'Первая организация',
      improvementState: 'received',
    },
  });
  await settle();
  assert.doesNotMatch(f.dom.window.document.body.textContent, /Первая организация/);
});
