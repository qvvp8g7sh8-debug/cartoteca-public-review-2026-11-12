const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const {
  loadCatalog,
  libraryView,
} = require('../src/server/modules/assistant/behavior/behavior-library.cjs');
const {
  normalizeExamples,
  compiledExamples,
} = require('../src/server/modules/assistant/behavior/behavior-schema.cjs');
const { normalizeIntent } = require('../src/server/modules/assistant/interpretation/intent-schema.cjs');
const params = (value = '') => new URLSearchParams(value);

test('domain catalog separates parse from workflow and contains the requested scenario breadth', () => {
  const catalog = loadCatalog();
  assert.ok(catalog.cases.length >= 200);
  assert.equal(new Set(catalog.cases.map((item) => item.id)).size, catalog.cases.length);
  const seen = new Set();
  for (const item of catalog.cases) {
    assert.deepEqual(normalizeIntent(item.current.intent), item.current.intent);
    assert.equal(typeof item.current.outcome, 'string');
    assert.ok(item.current.outcome.length > 0);
    assert.ok(Array.isArray(item.current.limitations));
    seen.add(item.current.status);
  }
  assert.deepEqual([...seen].sort(), ['manual', 'needs_clarification', 'supported', 'unsupported']);
});

test('library filters and paginates synthetic scenarios without disclosing other data', () => {
  const catalog = loadCatalog();
  const first = libraryView(catalog, params());
  assert.equal(first.cases.length, 20);
  assert.equal(first.total, catalog.cases.length);
  const second = libraryView(catalog, params('offset=20&limit=7'));
  assert.equal(second.cases.length, 7);
  assert.equal(second.cases[0].id, catalog.cases[20].id);
  const category = catalog.categories[0].id;
  const filtered = libraryView(
    catalog,
    params('category=' + encodeURIComponent(category) + '&limit=40'),
  );
  assert.ok(filtered.cases.every((item) => item.category === category));
  const unsupported = libraryView(catalog, params('status=unsupported&limit=40'));
  assert.ok(unsupported.cases.length);
  assert.ok(unsupported.cases.every((item) => item.current.status === 'unsupported'));
  const searched = libraryView(catalog, params('q=' + encodeURIComponent(catalog.cases[0].text)));
  assert.ok(searched.cases.some((item) => item.id === catalog.cases[0].id));
  first.cases[0].text = 'MUTATED';
  assert.notEqual(libraryView(catalog, params()).cases[0].text, 'MUTATED');
  assert.equal(first.credentials, undefined);
  assert.equal(first.memberships, undefined);
});

test('library rejects malformed filters, duplicate parameters and unknown packs', () => {
  const catalog = loadCatalog();
  for (const value of [
    'limit=0',
    'limit=41',
    'offset=-1',
    'offset=1.5',
    'q=a&q=b',
    'status=anything',
    'category=missing',
    'unknown=true',
  ])
    assert.throws(() => libraryView(catalog, params(value)), { status: 400 });
  assert.throws(() => libraryView(catalog, params('pack=missing')), { status: 404 });
});

for (const pack of ['starter', 'expanded']) test(pack + ' pack fits disabled draft schema and the bounded enabled prompt', () => {
  const page = libraryView(loadCatalog(), params('pack=' + pack + '&limit=40'));
  assert.ok(page.total > 0 && page.total <= 12);
  const examples = page.cases.map((item) => ({
    id: randomUUID(),
    text: item.text,
    referenceDate: item.referenceDate,
    referenceTime: item.referenceTime,
    enabled: true,
    expected: item.current.intent,
  }));
  assert.ok(page.cases.every((item) => ['supported', 'manual'].includes(item.current.status) ||
    (item.current.status === 'needs_clarification' && item.current.intent.intent === 'prepareAppointment')));
  normalizeExamples(examples);
  assert.ok(Buffer.byteLength(compiledExamples(examples), 'utf8') <= 4096);
});

test('library global ACL is checked without writing assistant state or calling a provider', async (t) => {
  const f = await adminFixture(t);
  const behavior = f.store.assistant.admin.behavior;
  assert.throws(() => behavior.library(f.owner.accountId, params()), { status: 403 });
  const before = behavior.view(f.admin.accountId);
  const result = behavior.library(f.admin.accountId, params());
  assert.ok(result.total >= 200);
  assert.deepEqual(behavior.view(f.admin.accountId), before);
});
