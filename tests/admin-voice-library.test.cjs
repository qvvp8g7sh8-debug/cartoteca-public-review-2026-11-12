const test = require('node:test');
const assert = require('node:assert/strict');
const {
  boot,
  clone,
  flush,
  deferred,
  scenario,
  example,
  route,
} = require('./helpers/voice-behavior-library.cjs');

test('scenario library is fetched only when its own panel is expanded and sends no writes or model requests', async (t) => {
  const f = boot(t);
  assert.equal(f.calls.length, 0);
  await f.api.load();
  assert.equal(f.calls.length, 1);
  await f.open();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].url.startsWith(route + '/library?'));
  assert.equal(f.$('[data-library-cases]').querySelectorAll('article').length, 20);
  f.$('[data-library-panel]').open = false;
  await f.open();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((item) => !item.options.method));
});

test('filters and paging retain the selected search scope without loading the whole corpus into the editor', async (t) => {
  const f = boot(t);
  await f.api.load();
  await f.open();
  f.$('[data-library-next]').click();
  await flush();
  let query = new URL(f.calls.at(-1).url, 'http://synthetic.invalid').searchParams;
  assert.equal(query.get('offset'), '20');
  assert.equal(f.$('[data-library-next]').disabled, true);
  f.$('[data-library-previous]').click();
  await flush();
  f.fill('[data-library-filter] [name="q"]', 'manual-case');
  f.fill('[data-library-filter] [name="category"]', 'cards-reading');
  f.fill('[data-library-filter] [name="status"]', 'manual');
  f.submit('[data-library-filter]');
  await flush();
  query = new URL(f.calls.at(-1).url, 'http://synthetic.invalid').searchParams;
  assert.deepEqual(
    [...query.entries()],
    [
      ['offset', '0'],
      ['limit', '20'],
      ['q', 'manual-case'],
      ['category', 'cards-reading'],
      ['status', 'manual'],
    ],
  );
  assert.match(f.$('[data-library-page]').textContent, /1–1 из 1/);
  assert.equal((await f.draft()).examples.length, 0);
});

test('manual, unsupported and clarification scenarios describe the actual outcome and expose import only for supported parsing', async (t) => {
  const f = boot(t);
  await f.api.load();
  await f.open();
  f.fill('[data-library-filter] [name="category"]', 'cards-reading');
  f.submit('[data-library-filter]');
  await flush();
  assert.match(f.$('[data-library-cases]').textContent, /Нужен ручной шаг/);
  assert.match(f.$('[data-library-cases]').textContent, /Пока не поддерживается/);
  assert.match(f.$('[data-library-cases]').textContent, /Нужно уточнение/);
  assert.match(f.$('[data-library-cases]').textContent, /Карточка автоматически не открывается/);
  assert.ok(f.$('[data-library-import="manual-case"]'));
  assert.equal(f.$('[data-library-import="unsupported-case"]'), null);
  assert.equal(f.$('[data-library-import="clarification-case"]'), null);
});

test('adding a case or starter pack preserves unrelated local work and imports disabled examples without auto-approval', async (t) => {
  const f = boot(t),
    prior = example();
  f.data.rules.examples = [prior];
  await f.api.load();
  await f.open();
  f.fill('[data-behavior-rules] [name="instructions"]', 'Unpublished local instructions');
  f.$('[data-library-import="person-00"]').click();
  f.$('[data-library-pack="starter"]').click();
  await flush();
  const rules = await f.draft();
  assert.equal(rules.instructions, 'Unpublished local instructions');
  assert.equal(rules.dictionary, 'Initial dictionary');
  assert.deepEqual(rules.examples[0], prior);
  assert.equal(rules.examples.length, 3);
  assert.ok(rules.examples.slice(1).every((item) => item.enabled === false));
  assert.equal(rules.examples[1].expected.query, 'person-00');
  assert.equal(rules.examples[1].referenceDate, '2026-10-15');
  assert.ok(f.calls.every((item) => !item.url.endsWith('/approve')));
  assert.ok(f.calls.every((item) => !item.url.startsWith('/api/assistant')));
});

test('adding a library case invalidates a previously reviewed draft and requires another explicit preview', async (t) => {
  const f = boot(t);
  await f.api.load();
  await f.open();
  await f.draft();
  assert.ok(f.$('[data-behavior-approve]'));
  f.$('[data-library-import="person-00"]').click();
  assert.equal(f.$('[data-behavior-approve]'), null);
  assert.match(f.$('[data-behavior-review]').textContent, /Черновик изменён/);
  assert.equal((await f.draft()).examples.length, 1);
  assert.equal(f.$('[data-behavior-approve] [name="confirmed"]').checked, false);
});

test('a pack that cannot fit the 50-example limit is rejected atomically and preserves all existing rows', async (t) => {
  const f = boot(t);
  f.data.rules.examples = Array.from({ length: 49 }, () => ({ ...example(), enabled: false }));
  const original = clone(f.data.rules.examples);
  await f.api.load();
  await f.open();
  f.$('[data-library-pack="starter"]').click();
  await flush();
  assert.match(f.$('[data-library-status]').textContent, /пакет не добавлен/);
  assert.deepEqual((await f.draft()).examples, original);
});

test('automatic selection uses the shipped catalog without importing it and keeps the50-custom import cap', async (t) => {
  const f = boot(t);
  f.data.rules.exampleSelection = 'automatic';
  f.data.rules.examples = Array.from({ length: 49 }, () => ({ ...example(), enabled: false }));
  const original = clone(f.data.rules.examples);
  await f.api.load();
  assert.equal(f.calls.length, 1);
  assert.equal(f.$('[data-behavior-examples]').querySelectorAll('article').length, 49);
  await f.open();
  f.$('[data-library-pack="starter"]').click();
  await flush();
  assert.match(f.$('[data-library-status]').textContent, /пакет не добавлен/);
  const rules = await f.draft();
  assert.equal(rules.exampleSelection, 'automatic');
  assert.deepEqual(rules.examples, original);
  assert.match(
    f.$('[data-behavior-count]').textContent,
    /0 доступных пользовательских кандидатов из 49/,
  );
  assert.ok(
    f.calls.every(
      (call) => !call.url.endsWith('/approve') && !call.url.startsWith('/api/assistant'),
    ),
  );
});

test('case identity and content prevent duplicate imports while removing a draft row permits adding it again', async (t) => {
  const f = boot(t);
  await f.api.load();
  await f.open();
  f.$('[data-library-import="person-00"]').click();
  f.$('[data-library-import="person-00"]').click();
  f.$('[data-library-pack="starter"]').click();
  await flush();
  let rules = await f.draft();
  assert.equal(rules.examples.length, 2);
  const first = rules.examples.find((item) => item.expected.query === 'person-00');
  f.$('[data-behavior-remove="' + first.id + '"]').click();
  f.$('[data-library-import="person-00"]').click();
  rules = await f.draft();
  assert.equal(rules.examples.length, 2);
  assert.notEqual(rules.examples.find((item) => item.expected.query === 'person-00').id, first.id);
});

test('an unfinished typed example is preserved and blocks library import until the user applies or cancels it', async (t) => {
  const f = boot(t);
  await f.api.load();
  await f.open();
  f.$('[data-behavior-add]').click();
  f.fill('[data-behavior-example] [name="text"]', 'Unfinished synthetic example');
  f.$('[data-library-import="person-00"]').click();
  assert.equal(f.$('[data-behavior-example] [name="text"]').value, 'Unfinished synthetic example');
  assert.match(f.$('[data-library-status]').textContent, /отмените редактируемый пример/);
  f.$('[data-behavior-cancel-example]').click();
  assert.equal((await f.draft()).examples.length, 0);
});

test('unknown approval keeps library mutation locked and retries with the same frozen command', async (t) => {
  const sent = [];
  const f = boot(t, async (url, options, data) => {
    if (url !== route + '/approve') return undefined;
    sent.push(options.body);
    if (sent.length === 1)
      throw Object.assign(Error('Unknown synthetic outcome'), { outcomeUnknown: true });
    return { ...clone(data), revision: 4, version: 2, rules: JSON.parse(options.body).rules };
  });
  await f.api.load();
  await f.open();
  f.$('[data-library-import="person-00"]').click();
  await f.draft();
  f.fill('[data-behavior-approve] [name="reason"]', 'Synthetic approval');
  f.fill('[data-behavior-approve] [name="confirmed"]', true);
  f.submit('[data-behavior-approve]');
  await flush();
  const blocked = f.$('[data-library-import="person-01"]');
  assert.equal(blocked.disabled, true);
  blocked.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true }));
  assert.match(f.$('[data-library-status]').textContent, /Дождитесь завершения/);
  f.submit('[data-behavior-approve]');
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(JSON.parse(sent[1]).rules.examples.length, 1);
});

test('a denied library read or changed administrator erases the library and ignores a late response', async (t) => {
  const pending = deferred();
  const f = boot(t, async (url) =>
    url.startsWith(route + '/library?') ? pending.promise : undefined,
  );
  await f.api.load();
  f.$('[data-library-panel]').open = true;
  f.$('[data-library-panel]').dispatchEvent(new f.window.Event('toggle'));
  await flush();
  f.$('#admin-identity').textContent = 'Different synthetic administrator';
  await flush();
  pending.resolve({
    total: 1,
    offset: 0,
    limit: 20,
    categories: [],
    statuses: [],
    packs: [],
    cases: [scenario('late')],
  });
  await flush();
  assert.equal(f.$('[data-library-panel]'), null);
  assert.equal(f.$('[data-library-import]'), null);
  const denied = boot(t, async (url) => {
    if (url.startsWith(route + '/library?'))
      throw Object.assign(Error('Revoked synthetic access'), { status: 403 });
  });
  await denied.api.load();
  await denied.open();
  assert.equal(denied.$('[data-library-panel]'), null);
  assert.equal(denied.$('[data-behavior-rules]'), null);
});

test('library titles, phrases, expected fields, outcomes and restrictions render untrusted text without creating HTML', async (t) => {
  const unsafe = '<img id="injected-scenario" src=x onerror="alert(1)">';
  const f = boot(t);
  const value = f.catalog[0];
  for (const key of ['title', 'text']) value[key] = unsafe;
  value.current.intent.query = unsafe;
  value.current.outcome = unsafe;
  value.current.limitations = [unsafe];
  value.preconditions = [unsafe];
  value.tags = [unsafe];
  await f.api.load();
  await f.open();
  assert.equal(f.$('#injected-scenario'), null);
  assert.ok(f.$('[data-library-cases]').textContent.includes(unsafe));
  f.$('[data-library-import="person-00"]').click();
  assert.equal((await f.draft()).examples[0].text, unsafe);
  assert.equal(f.$('#injected-scenario'), null);
});

test('appointment scenarios needing clarification import disabled as the start of a controlled dialogue', async (t) => {
  const f = boot(t, async (_url, _options, _data, catalog) => {
    const item = catalog.find((item) => item.id === 'clarification-case');
    item.current.intent = { intent: 'prepareAppointment', query: 'Вымышленный клиент' };
    item.current.outcome = 'Уточнить недостающие поля и затем подготовить обычную форму.';
    return undefined;
  });
  await f.api.load();
  await f.open();
  f.fill('[data-library-filter] [name="category"]', 'cards-reading');
  f.submit('[data-library-filter]');
  await flush();
  assert.ok(f.$('[data-library-import="clarification-case"]'));
  f.$('[data-library-import="clarification-case"]').click();
  const draft = await f.draft();
  assert.equal(draft.examples.length, 1);
  assert.equal(draft.examples[0].enabled, false);
  assert.equal(draft.examples[0].expected.intent, 'prepareAppointment');
  assert.ok(f.calls.every((item) => !item.url.endsWith('/approve')));
});
