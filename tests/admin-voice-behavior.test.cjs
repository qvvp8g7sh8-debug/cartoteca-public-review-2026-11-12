const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const route = '/api/admin/voice-assistant/behavior';
const clone = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function snapshot() {
  return {
    revision: 3,
    version: 2,
    rules: { instructions: 'Initial instructions', dictionary: 'Initial dictionary', examples: [] },
    versions: [
      {
        version: 2,
        time: 1000,
        actorId: 'synthetic-admin',
        reason: 'Current version',
        current: true,
      },
      {
        version: 1,
        time: 900,
        actorId: 'synthetic-admin',
        reason: 'Previous version',
        current: false,
      },
    ],
    limits: {
      maxExamples: 50,
      maxEnabledExamples: 12,
      maxExampleTextChars: 500,
      maxEnabledExamplesBytes: 4096,
      maxInstructionsChars: 4000,
      maxDictionaryChars: 4000,
      maxRulesBytes: 65536,
      maxCodexInputBytes: 32768,
    },
    llmProvider: { provider: 'demo', model: 'synthetic-model' },
  };
}
function changes(before, after) {
  const field = (key) => ({
    changed: before[key] !== after[key],
    before: before[key],
    after: after[key],
  });
  return {
    exampleSelection: {
      changed: (before.exampleSelection || 'manual') !== (after.exampleSelection || 'manual'),
      before: before.exampleSelection || 'manual',
      after: after.exampleSelection || 'manual',
    },
    instructions: field('instructions'),
    dictionary: field('dictionary'),
    examples: { added: after.examples, removed: [], changed: [], orderChanged: false },
  };
}
function boot(t, handler = async () => undefined) {
  const dom = new JSDOM(
    '<div id="admin-identity">Synthetic operator</div><section id="admin-voice-behavior"></section>',
    {
      url: 'http://127.0.0.1:4174/admin.html',
      runScripts: 'outside-only',
    },
  );
  t.after(() => dom.window.close());
  const { window } = dom,
    $ = (selector) => window.document.querySelector(selector);
  const calls = [],
    data = snapshot(),
    commits = [];
  window.confirm = () => true;
  for (const file of [
    'src/shared/improvement-status.cjs',
    'src/client/modules/admin/records.js',
    'src/client/modules/admin/voice-behavior-view.js',
    'src/client/modules/admin/voice-behavior-diff.js',
    'src/client/modules/admin/voice-behavior-editor.js',
    'src/client/modules/admin/voice-behavior-library-view.js',
    'src/client/modules/admin/voice-behavior-library.js',
    'src/client/modules/admin/voice-behavior.js',
  ])
    window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    const custom = await handler(url, options, data);
    if (custom !== undefined) return custom;
    if (url === route && !options.method) return clone(data);
    if (url === route + '/preview') {
      const body = JSON.parse(options.body);
      const rules = body.rules || {
        instructions: 'Restored instructions',
        dictionary: '',
        examples: [],
      };
      return {
        revision: data.revision,
        version: data.version,
        sourceVersion: body.sourceVersion ?? null,
        rules: clone(rules),
        changes: changes(data.rules, rules),
        reviewHash: 'a'.repeat(64),
      };
    }
    throw Error('Unexpected synthetic request: ' + url);
  };
  const api = window.createAdminVoiceBehavior({
    root: $('#admin-voice-behavior'),
    request,
    records: window.createAdminRecords(),
    requestId: randomUUID,
    onCommitted: async () => commits.push(true),
  });
  api.bind();
  const fill = (selector, value) => {
    const input = $(selector);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const submit = (selector) =>
    $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const bodies = (suffix) =>
    calls
      .filter((item) => item.url === route + suffix && item.options.body)
      .map((item) => JSON.parse(item.options.body));
  return { window, $, api, calls, data, commits, fill, submit, bodies };
}
async function reviewed(f) {
  f.submit('[data-behavior-rules]');
  await flush();
}
function confirmReview(f) {
  f.fill('[data-behavior-approve] [name="reason"]', 'Synthetic approval reason');
  f.fill('[data-behavior-approve] [name="confirmed"]', true);
}

test('behavior loads only when opened, describes demo honestly and never asks for provider credentials', async (t) => {
  const f = boot(t);
  assert.equal(f.calls.length, 0);
  await f.api.load();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, route);
  assert.match(f.$('[data-behavior-provider]').textContent, /не использует примеры/);
  assert.equal(f.$('[name="instructions"]').value, f.data.rules.instructions);
  assert.equal(f.$('[type="password"]'), null);
  assert.equal(f.$('[data-behavior-approve]'), null);
  assert.equal(f.$('[name="exampleSelection"]').value, 'manual');
});

test('automatic selection is an explicit reviewed rule and does not import a catalog or invoke a model on selection', async (t) => {
  const f = boot(t);
  await f.api.load();
  f.fill('[name="exampleSelection"]', 'automatic');
  assert.equal(f.calls.length, 1);
  assert.equal(f.$('[data-behavior-rules]').dataset.dirty, '1');
  assert.match(
    f.$('[data-behavior-rules]').textContent,
    /встроенный каталог и одобренные пользовательские примеры/,
  );
  assert.match(f.$('[data-behavior-rules]').textContent, /не обучение/);
  assert.match(f.$('[data-behavior-count]').textContent, /0 доступных пользовательских кандидатов/);
  assert.doesNotMatch(f.$('[data-behavior-count]').textContent, /из 12/);
  assert.equal(f.$('[data-behavior-examples]').querySelectorAll('article').length, 0);
  await reviewed(f);
  const body = f.bodies('/preview')[0];
  assert.equal(body.rules.exampleSelection, 'automatic');
  assert.deepEqual(body.rules.examples, []);
  assert.match(f.$('[data-behavior-review]').textContent, /Фиксированный набор/);
  assert.match(f.$('[data-behavior-review]').textContent, /Автоматически по запросу/);
  assert.equal(f.bodies('/approve').length, 0);
  assert.ok(
    f.calls.every(
      (call) => !call.url.includes('/library') && !call.url.startsWith('/api/assistant'),
    ),
  );
  f.fill('[name="exampleSelection"]', 'manual');
  assert.equal(f.$('[data-behavior-approve]'), null);
  assert.match(f.$('[data-behavior-review]').textContent, /Черновик изменён/);
});

test('automatic candidate pool accepts50 enabled custom examples and returning to manual never silently disables them', async (t) => {
  const f = boot(t);
  f.data.rules.exampleSelection = 'automatic';
  f.data.limits.maxCandidateExamples = 50;
  f.data.rules.examples = Array.from({ length: 50 }, (_, index) => ({
    id: randomUUID(),
    text: 'Синтетический пример ' + index,
    referenceDate: '2026-10-16',
    referenceTime: '10:00',
    enabled: false,
    expected: { intent: 'help' },
  }));
  await f.api.load();
  for (const item of f.data.rules.examples)
    f.fill('[data-behavior-enabled="' + item.id + '"]', true);
  assert.match(
    f.$('[data-behavior-count]').textContent,
    /50 доступных пользовательских кандидатов из 50/,
  );
  assert.match(f.$('[data-behavior-count]').textContent, /до 12 примеров на один запрос/);
  assert.match(f.$('[data-behavior-examples]').textContent, /Допускать к автоматическому отбору/);
  assert.equal(f.$('[data-behavior-add]').disabled, true);
  await reviewed(f);
  assert.equal(f.bodies('/preview')[0].rules.examples.filter((item) => item.enabled).length, 50);
  f.fill('[name="exampleSelection"]', 'manual');
  const before = f.bodies('/preview').length;
  await reviewed(f);
  assert.equal(f.bodies('/preview').length, before);
  assert.match(
    f.$('[data-behavior-status]').textContent,
    /Для фиксированного набора оставьте не более 12/,
  );
  assert.equal(f.$('[data-behavior-examples]').querySelectorAll('input:checked').length, 50);
  for (const item of f.data.rules.examples.slice(12))
    f.fill('[data-behavior-enabled="' + item.id + '"]', false);
  await reviewed(f);
  const rules = f.bodies('/preview').at(-1).rules;
  assert.equal(rules.exampleSelection, 'manual');
  assert.equal(rules.examples.length, 50);
  assert.equal(rules.examples.filter((item) => item.enabled).length, 12);
  f.fill('[data-behavior-enabled="' + f.data.rules.examples[12].id + '"]', true);
  assert.equal(
    f.$('[data-behavior-enabled="' + f.data.rules.examples[12].id + '"]').checked,
    false,
  );
});

test('changing selection while a custom example is open preserves its unsaved text and changes candidate labeling', async (t) => {
  const f = boot(t);
  await f.api.load();
  f.$('[data-behavior-add]').click();
  f.fill('[data-behavior-example] [name="text"]', 'Несохранённый синтетический пример');
  f.fill('[name="exampleSelection"]', 'automatic');
  assert.equal(
    f.$('[data-behavior-example] [name="text"]').value,
    'Несохранённый синтетический пример',
  );
  assert.equal(
    f.$('[data-behavior-enabled-label]').textContent,
    'Допускать к автоматическому отбору',
  );
  f.submit('[data-behavior-rules]');
  await flush();
  assert.equal(f.bodies('/preview').length, 0);
  assert.match(f.$('[data-behavior-status]').textContent, /Примените к черновику или отмените/);
});

test('stored text, examples, version metadata and preview differences render as text, not HTML', async (t) => {
  const f = boot(t),
    unsafe = '</textarea><img id="synthetic-injection" src=x onerror="alert(1)">';
  f.data.rules.instructions = unsafe;
  f.data.rules.examples = [
    {
      id: randomUUID(),
      text: unsafe,
      referenceDate: '2026-10-15',
      referenceTime: '10:00',
      enabled: true,
      expected: { intent: 'clients', query: unsafe },
    },
  ];
  f.data.versions[0].reason = unsafe;
  await f.api.load();
  assert.equal(f.$('#synthetic-injection'), null);
  assert.equal(f.$('[name="instructions"]').value, unsafe);
  f.fill('[name="dictionary"]', unsafe);
  await reviewed(f);
  assert.equal(f.$('#synthetic-injection'), null);
  assert.ok(f.$('[data-behavior-review]').textContent.includes(unsafe));
  assert.equal(f.bodies('/preview')[0].rules.dictionary, unsafe);
});

test('typed example editor serializes numeric duration and removes fields irrelevant to a changed intent', async (t) => {
  const f = boot(t);
  await f.api.load();
  f.$('[data-behavior-add]').click();
  const editor = '[data-behavior-example] ';
  f.fill(editor + '[name="text"]', 'Запиши Тестового завтра');
  f.fill(editor + '[name="referenceDate"]', '2026-10-15');
  f.fill(editor + '[name="referenceTime"]', '10:00');
  f.fill(editor + '[name="intent"]', 'prepareAppointment');
  f.fill(editor + '[name="query"]', 'Тестовый');
  f.fill(editor + '[name="date"]', '2026-10-16');
  f.fill(editor + '[name="duration"]', '45');
  f.fill(editor + '[name="enabled"]', true);
  f.submit('[data-behavior-example]');
  assert.equal(f.calls.length, 1);
  await reviewed(f);
  const added = f.bodies('/preview')[0].rules.examples[0];
  assert.equal(added.expected.duration, 45);
  assert.equal(added.expected.intent, 'prepareAppointment');
  assert.match(added.id, /^[a-f0-9-]{36}$/);
  f.$('[data-behavior-edit]').click();
  f.fill(editor + '[name="intent"]', 'help');
  assert.equal(f.$(editor + '[name="duration"]').disabled, true);
  f.submit('[data-behavior-example]');
  await reviewed(f);
  assert.deepEqual(f.bodies('/preview')[1].rules.examples[0].expected, { intent: 'help' });
});

test('changing draft invalidates reviewed confirmation and rebasing keeps edits against the fresh revision', async (t) => {
  const f = boot(t);
  await f.api.load();
  f.fill('[name="instructions"]', 'Reviewed draft');
  f.fill('[name="exampleSelection"]', 'automatic');
  await reviewed(f);
  confirmReview(f);
  assert.ok(f.$('[data-behavior-approve]'));
  f.fill('[name="instructions"]', 'Edited after review');
  assert.equal(f.$('[data-behavior-approve]'), null);
  assert.equal(f.bodies('/approve').length, 0);
  f.data.revision = 4;
  f.data.rules.instructions = 'Another administrator changed this';
  await f.api.refresh();
  assert.equal(f.$('[name="instructions"]').value, 'Edited after review');
  assert.equal(f.$('[name="exampleSelection"]').value, 'automatic');
  await reviewed(f);
  assert.equal(f.bodies('/preview').at(-1).expectedRevision, 4);
  assert.equal(f.bodies('/preview').at(-1).rules.instructions, 'Edited after review');
  assert.equal(f.bodies('/preview').at(-1).rules.exampleSelection, 'automatic');
  assert.equal(f.$('[data-behavior-approve] [name="confirmed"]').checked, false);
});

test('unknown approval freezes editing and retries the exact serialized command and request identifier', async (t) => {
  const sent = [];
  const f = boot(t, async (url, options, data) => {
    if (url !== route + '/approve') return undefined;
    sent.push(options.body);
    if (sent.length === 1)
      throw Object.assign(Error('Synthetic unknown result'), { outcomeUnknown: true });
    const body = JSON.parse(options.body);
    return { ...clone(data), revision: 4, version: 3, rules: body.rules };
  });
  await f.api.load();
  f.fill('[name="instructions"]', 'Reviewed change');
  f.fill('[name="exampleSelection"]', 'automatic');
  await reviewed(f);
  confirmReview(f);
  f.submit('[data-behavior-approve]');
  await flush();
  assert.equal(f.$('[name="instructions"]').disabled, true);
  assert.equal(f.$('[name="exampleSelection"]').disabled, true);
  assert.equal(f.$('[data-behavior-add]').disabled, true);
  assert.equal(f.$('[data-behavior-approve] [type="submit"]').disabled, false);
  await f.api.refresh();
  f.submit('[data-behavior-approve]');
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(JSON.parse(sent[1]).rules.exampleSelection, 'automatic');
  assert.deepEqual(Object.keys(JSON.parse(sent[1])).sort(), [
    'confirmed',
    'expectedRevision',
    'reason',
    'requestId',
    'reviewHash',
    'rules',
  ]);
  assert.equal(f.commits.length, 1);
  assert.equal(f.$('[name="instructions"]').value, 'Reviewed change');
  assert.equal(f.$('[name="exampleSelection"]').value, 'automatic');
  assert.equal(f.$('[data-behavior-approve]'), null);
});

test('stale approval preserves the local draft but requires a fresh preview and confirmation', async (t) => {
  const f = boot(t, async (url) => {
    if (url === route + '/approve')
      throw Object.assign(Error('Synthetic revision conflict'), { status: 409 });
  });
  await f.api.load();
  f.fill('[name="instructions"]', 'Uncommitted local work');
  await reviewed(f);
  confirmReview(f);
  f.submit('[data-behavior-approve]');
  await flush();
  assert.equal(f.$('[name="instructions"]').value, 'Uncommitted local work');
  assert.equal(f.$('[name="instructions"]').disabled, false);
  assert.equal(f.$('[data-behavior-approve]'), null);
  assert.equal(f.commits.length, 0);
  f.data.revision = 5;
  await f.api.refresh();
  await reviewed(f);
  assert.equal(f.bodies('/preview').at(-1).expectedRevision, 5);
  assert.equal(f.$('[name="confirmed"]').checked, false);
});

test('late preview is discarded after identity changes and denied reads erase the visible editor', async (t) => {
  const pending = deferred();
  let deny = false;
  const f = boot(t, async (url) => {
    if (url === route + '/preview') return pending.promise;
    if (deny && url === route)
      throw Object.assign(Error('Synthetic access revoked'), { status: 403 });
  });
  await f.api.load();
  f.submit('[data-behavior-rules]');
  await flush();
  f.$('#admin-identity').textContent = 'Another synthetic operator';
  await flush();
  pending.resolve({
    revision: 3,
    version: 2,
    sourceVersion: null,
    rules: f.data.rules,
    changes: changes(f.data.rules, f.data.rules),
    reviewHash: 'b'.repeat(64),
  });
  await flush();
  assert.equal(f.$('[data-behavior-rules]'), null);
  assert.equal(f.$('[data-behavior-approve]'), null);
  deny = true;
  await f.api.load();
  assert.equal(f.$('[data-behavior-rules]'), null);
  assert.match(f.$('[data-behavior-status]').textContent, /Доступ или сессия изменились/);
});

test('version comparison is read-only and restoring requires preview then one scoped explicit approval', async (t) => {
  const f = boot(t, async (url, options, data) => {
    if (url.startsWith(route + '/compare?'))
      return {
        revision: 3,
        fromVersion: 1,
        toVersion: 2,
        changes: changes({ ...data.rules, instructions: 'Before' }, data.rules),
      };
    if (url === route + '/restore')
      return {
        ...clone(data),
        revision: 4,
        version: 3,
        rules: { instructions: 'Restored instructions', dictionary: '', examples: [] },
      };
  });
  await f.api.load();
  f.submit('[data-behavior-compare]');
  await flush();
  assert.match(f.$('[data-behavior-comparison]').textContent, /Before/);
  assert.equal(f.calls.filter((item) => item.options.method).length, 0);
  f.fill('[name="sourceVersion"]', '1');
  f.submit('[data-behavior-restore]');
  await flush();
  assert.deepEqual(f.bodies('/preview')[0], { expectedRevision: 3, sourceVersion: 1 });
  assert.equal(f.bodies('/restore').length, 0);
  assert.match(
    f.$('[data-behavior-review]').textContent,
    /Провайдеры, ключи и персональный доступ сохранятся/,
  );
  confirmReview(f);
  f.submit('[data-behavior-approve]');
  await flush();
  const body = f.bodies('/restore')[0];
  assert.equal(body.sourceVersion, 1);
  assert.equal(body.confirmed, true);
  assert.equal(body.reviewHash, 'a'.repeat(64));
  assert.equal(Object.hasOwn(body, 'rules'), false);
  assert.equal(f.$('[name="instructions"]').value, 'Restored instructions');
});

test('automatic selection participates in version comparison and restore only through source-version review', async (t) => {
  const f = boot(t, async (url, options, data) => {
    const restored = { ...clone(data.rules), exampleSelection: 'automatic' };
    if (url.startsWith(route + '/compare?'))
      return { revision: 3, fromVersion: 2, toVersion: 1, changes: changes(data.rules, restored) };
    if (url === route + '/preview' && JSON.parse(options.body).sourceVersion === 1)
      return {
        revision: 3,
        version: 2,
        sourceVersion: 1,
        rules: restored,
        changes: changes(data.rules, restored),
        reviewHash: 'c'.repeat(64),
      };
    if (url === route + '/restore')
      return { ...clone(data), revision: 4, version: 3, rules: restored };
  });
  await f.api.load();
  f.submit('[data-behavior-compare]');
  await flush();
  assert.match(f.$('[data-behavior-comparison]').textContent, /Отбор примеров/);
  assert.match(f.$('[data-behavior-comparison]').textContent, /Фиксированный набор/);
  assert.match(f.$('[data-behavior-comparison]').textContent, /Автоматически по запросу/);
  assert.equal(f.calls.filter((item) => item.options.method).length, 0);
  f.fill('[name="sourceVersion"]', '1');
  f.submit('[data-behavior-restore]');
  await flush();
  assert.deepEqual(f.bodies('/preview')[0], { expectedRevision: 3, sourceVersion: 1 });
  assert.equal(f.bodies('/restore').length, 0);
  confirmReview(f);
  f.submit('[data-behavior-approve]');
  await flush();
  assert.equal(f.bodies('/approve').length, 0);
  const command = f.bodies('/restore')[0];
  assert.equal(command.sourceVersion, 1);
  assert.equal(command.reviewHash, 'c'.repeat(64));
  assert.equal(command.confirmed, true);
  assert.equal(Object.hasOwn(command, 'rules'), false);
  assert.equal(f.$('[name="exampleSelection"]').value, 'automatic');
});
