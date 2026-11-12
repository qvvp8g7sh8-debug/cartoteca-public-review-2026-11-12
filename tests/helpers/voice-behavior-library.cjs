const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const sourceRoot = path.resolve(__dirname, '../..');
const route = '/api/admin/voice-assistant/behavior';
const clone = (value) => JSON.parse(JSON.stringify(value));
async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function scenario(id, status = 'supported', category = 'clients-search') {
  return {
    id,
    title: 'Synthetic scenario ' + id,
    category,
    text: 'Найди вымышленного клиента ' + id,
    referenceDate: '2026-10-15',
    referenceTime: '10:30',
    timeZone: 'Europe/Moscow',
    current: {
      intent: { intent: 'clients', query: id },
      status,
      outcome: 'Открыть список клиентов с заданным поиском.',
      limitations: ['Карточка автоматически не открывается.'],
    },
    tags: ['synthetic'],
    preconditions: ['Синтетическая организация.'],
  };
}
function example(id = randomUUID()) {
  return {
    id,
    text: 'Найди вымышленного ' + id,
    referenceDate: '2026-10-15',
    referenceTime: '10:30',
    enabled: true,
    expected: { intent: 'clients', query: id },
  };
}
function boot(t, handler = async () => undefined) {
  const dom = new JSDOM(
    '<div id="admin-identity">Synthetic administrator</div><section id="admin-voice-behavior"></section>',
    { url: 'http://127.0.0.1:4174/admin.html', runScripts: 'outside-only' },
  );
  t.after(() => dom.window.close());
  const { window } = dom,
    $ = (selector) => window.document.querySelector(selector);
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
    window.eval(fs.readFileSync(path.join(sourceRoot, file), 'utf8'));
  const data = {
    revision: 3,
    version: 1,
    rules: { instructions: 'Initial instructions', dictionary: 'Initial dictionary', examples: [] },
    versions: [
      { version: 1, time: 1000, actorId: 'synthetic', reason: 'Synthetic revision', current: true },
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
  const catalog = Array.from({ length: 25 }, (_, index) =>
    scenario('person-' + String(index).padStart(2, '0')),
  );
  catalog.push(scenario('manual-case', 'manual', 'cards-reading'));
  catalog.push(scenario('unsupported-case', 'unsupported', 'cards-reading'));
  catalog.push(scenario('clarification-case', 'needs_clarification', 'cards-reading'));
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    const custom = await handler(url, options, data, catalog);
    if (custom !== undefined) return custom;
    if (url === route) return clone(data);
    if (url === route + '/preview') {
      const body = JSON.parse(options.body);
      return {
        revision: data.revision,
        version: data.version,
        sourceVersion: null,
        rules: clone(body.rules),
        reviewHash: 'a'.repeat(64),
        changes: {
          instructions: {
            changed: data.rules.instructions !== body.rules.instructions,
            before: data.rules.instructions,
            after: body.rules.instructions,
          },
          dictionary: {
            changed: data.rules.dictionary !== body.rules.dictionary,
            before: data.rules.dictionary,
            after: body.rules.dictionary,
          },
          examples: { added: body.rules.examples, removed: [], changed: [], orderChanged: false },
        },
      };
    }
    if (url.startsWith(route + '/library?')) {
      const query = new URL(url, window.location.href).searchParams;
      let cases = query.has('pack') ? catalog.slice(0, 2) : catalog;
      for (const key of ['category', 'status', 'q']) {
        const value = query.get(key);
        if (value)
          cases = cases.filter((item) =>
            key === 'q'
              ? item.text.includes(value)
              : key === 'status'
                ? item.current.status === value
                : item.category === value,
          );
      }
      const offset = Number(query.get('offset') || 0),
        limit = Number(query.get('limit') || 20);
      return clone({
        schemaVersion: 1,
        context: { referenceDate: '2026-10-15', referenceTime: '10:30', timeZone: 'Europe/Moscow' },
        total: cases.length,
        offset,
        limit,
        categories: [
          { id: 'clients-search', title: 'Клиенты', count: 25 },
          { id: 'cards-reading', title: 'Карточки', count: 3 },
        ],
        statuses: ['supported', 'manual', 'unsupported', 'needs_clarification'].map((id) => ({
          id,
          count: catalog.filter((item) => item.current.status === id).length,
        })),
        packs: [
          {
            id: 'starter',
            title: 'Начальный набор',
            description: 'Два синтетических примера.',
            count: 2,
          },
        ],
        cases: cases.slice(offset, offset + limit),
      });
    }
    throw Error('Unexpected synthetic request: ' + url);
  };
  const api = window.createAdminVoiceBehavior({
    root: $('#admin-voice-behavior'),
    request,
    records: window.createAdminRecords(),
    requestId: randomUUID,
  });
  api.bind();
  function fill(selector, value) {
    const input = $(selector);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  function submit(selector) {
    $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  }
  async function open() {
    const panel = $('[data-library-panel]');
    panel.open = true;
    panel.dispatchEvent(new window.Event('toggle'));
    await flush();
  }
  async function draft() {
    submit('[data-behavior-rules]');
    await flush();
    return JSON.parse(calls.filter((call) => call.url === route + '/preview').at(-1).options.body)
      .rules;
  }
  return { window, $, api, data, catalog, calls, fill, submit, open, draft };
}
module.exports = { boot, clone, flush, deferred, scenario, example, route };
