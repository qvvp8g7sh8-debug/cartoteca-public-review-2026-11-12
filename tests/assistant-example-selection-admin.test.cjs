const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const api = (f) => f.store.assistant.admin.behavior;
const actor = (f) => f.admin.accountId;
const file = (f) => path.join(f.platformDirectory, 'assistant-state.enc');
const state = (f) => f.database.open(fs.readFileSync(file(f)));
const rules = (values = {}) => ({
  instructions: '',
  dictionary: '',
  exampleSelection: 'manual',
  examples: [],
  ...values,
});
const examples = () =>
  Array.from({ length: 50 }, () => ({
    id: randomUUID(),
    text: 'Покажи календарь завтра',
    referenceDate: '2026-10-15',
    referenceTime: '10:00',
    enabled: true,
    expected: { intent: 'calendar', date: '2026-10-16' },
  }));
const command = (revision, values = {}) => ({
  expectedRevision: revision,
  requestId: randomUUID(),
  reason: 'Synthetic selection change',
  ...values,
});
function preview(f, value) {
  return api(f).preview(actor(f), {
    expectedRevision: api(f).view(actor(f)).revision,
    rules: value,
  });
}
function approve(f, value) {
  const review = preview(f, value);
  return api(f).approve(
    actor(f),
    command(review.revision, {
      rules: review.rules,
      reviewHash: review.reviewHash,
      confirmed: true,
    }),
  );
}

test('legacy encrypted reads default to manual without rewriting bytes and preview cannot activate automatic selection', async (t) => {
  const f = await adminFixture(t),
    legacy = initialState();
  delete legacy.policy.exampleSelection;
  fs.writeFileSync(file(f), f.database.seal(legacy));
  const bytes = fs.readFileSync(file(f));
  assert.equal(api(f).view(actor(f)).rules.exampleSelection, 'manual');
  const review = preview(f, rules({ exampleSelection: 'automatic', examples: examples() }));
  assert.equal(review.rules.examples.length, 50);
  assert.deepEqual(review.changes.exampleSelection, {
    changed: true,
    before: 'manual',
    after: 'automatic',
  });
  assert.equal(api(f).view(actor(f)).rules.exampleSelection, 'manual');
  assert.deepEqual(fs.readFileSync(file(f)), bytes);
});

test('automatic preview rejects contradictory canonical phrases while equal, disabled and distinct-context candidates remain valid', async (t) => {
  const f = await adminFixture(t);
  fs.writeFileSync(file(f), f.database.seal(initialState()));
  const before = fs.readFileSync(file(f));
  const first = { ...examples()[0], text: '  ЁЛКА   завтра  ' },
    second = {
      ...examples()[0],
      text: 'елка завтра',
      expected: { intent: 'calendar', date: '2026-10-17' },
    };
  const automatic = (values) => rules({ exampleSelection: 'automatic', examples: values });
  assert.throws(() => preview(f, automatic([first, second])), {
    status: 400,
    message: 'Для одинаковой фразы в одном контексте оставьте один ожидаемый результат.',
  });
  const equal = { ...second, expected: { date: '2026-10-16', intent: 'calendar' } };
  assert.equal(preview(f, automatic([first, equal])).rules.examples.length, 2);
  assert.equal(
    preview(f, automatic([first, { ...second, enabled: false }])).rules.examples.length,
    2,
  );
  for (const context of [{ referenceDate: '2026-10-16' }, { referenceTime: '11:00' }])
    assert.equal(
      preview(f, automatic([first, { ...second, ...context }])).rules.examples.length,
      2,
    );
  assert.equal(preview(f, rules({ examples: [first, second] })).rules.examples.length, 2);
  assert.deepEqual(fs.readFileSync(file(f)), before);
});

test('approval binds mode in preview hash and exact replay retains one behavior change without activating pilot grants', async (t) => {
  const f = await adminFixture(t);
  const manual = preview(f, rules()),
    automatic = preview(f, rules({ exampleSelection: 'automatic' }));
  assert.notEqual(manual.reviewHash, automatic.reviewHash);
  const body = command(automatic.revision, {
    rules: automatic.rules,
    reviewHash: manual.reviewHash,
    confirmed: true,
  });
  assert.throws(() => api(f).approve(actor(f), body), { status: 409 });
  body.reviewHash = automatic.reviewHash;
  const saved = api(f).approve(actor(f), body),
    before = state(f);
  assert.deepEqual(api(f).approve(actor(f), structuredClone(body)), saved);
  assert.throws(() => api(f).approve(actor(f), { ...body, rules: rules() }), { status: 409 });
  assert.equal(state(f).operations.length, before.operations.length);
  assert.equal(state(f).behavior.history.length, before.behavior.history.length);
  assert.equal(state(f).policy.mode, 'off');
  assert.deepEqual(state(f).grants, []);
  f.reopen();
  assert.equal(api(f).view(actor(f)).rules.exampleSelection, 'automatic');
});

test('generic settings cannot change selection or candidate pool, and generic restore preserves approved automatic rules', async (t) => {
  const f = await adminFixture(t),
    admin = f.store.assistant.admin;
  assert.throws(
    () => admin.settings(actor(f), command(0, { policy: { exampleSelection: 'automatic' } })),
    { status: 400 },
  );
  const approved = approve(f, rules({ exampleSelection: 'automatic', examples: examples() }));
  const bytes = fs.readFileSync(file(f));
  for (const policy of [{ exampleSelection: 'manual', examples: [] }, { examples: [] }])
    assert.throws(() => admin.settings(actor(f), command(approved.revision, { policy })), {
      status: 400,
    });
  assert.deepEqual(fs.readFileSync(file(f)), bytes);
  admin.restore(actor(f), command(approved.revision, { revision: 0 }));
  assert.deepEqual(api(f).view(actor(f)).rules, approved.rules);
  assert.equal(api(f).view(actor(f)).version, approved.version);
});

test('behavior restore reinstates automatic mode and fifty candidates while retaining current provider and access settings', async (t) => {
  const f = await adminFixture(t),
    admin = f.store.assistant.admin;
  const first = approve(f, rules({ exampleSelection: 'automatic', examples: examples() }));
  const second = approve(f, rules({ dictionary: 'Current manual dictionary' }));
  assert.deepEqual(
    api(f).compare(actor(f), first.version, second.version).changes.exampleSelection,
    { changed: true, before: 'automatic', after: 'manual' },
  );
  admin.settings(
    actor(f),
    command(second.revision, {
      policy: { limits: { dailyRequests: 71 } },
      providers: { llm: { provider: 'codex' } },
      timewebApiKey: 'synthetic-retained-selection-key',
    }),
  );
  const before = state(f),
    review = api(f).preview(actor(f), {
      expectedRevision: before.revision,
      sourceVersion: first.version,
    });
  const restored = api(f).restore(
    actor(f),
    command(review.revision, {
      sourceVersion: first.version,
      reviewHash: review.reviewHash,
      confirmed: true,
    }),
  );
  assert.deepEqual(restored.rules, first.rules);
  const after = state(f);
  for (const key of ['providers', 'credentials', 'grants', 'rates'])
    assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.policy.limits, before.policy.limits);
});

test('automatic approval obeys global ACL and a busy state lock cannot partially activate the reviewed mode', async (t) => {
  const f = await adminFixture(t);
  const initial = approve(f, rules()),
    review = preview(f, rules({ exampleSelection: 'automatic', examples: examples() }));
  const body = command(review.revision, {
    rules: review.rules,
    reviewHash: review.reviewHash,
    confirmed: true,
  });
  assert.throws(
    () =>
      api(f).preview(f.owner.accountId, { expectedRevision: review.revision, rules: review.rules }),
    { status: 403 },
  );
  assert.throws(() => api(f).approve(f.owner.accountId, body), { status: 403 });
  assert.throws(
    () =>
      api(f).restore(
        f.owner.accountId,
        command(review.revision, {
          sourceVersion: 0,
          confirmed: true,
          reviewHash: review.reviewHash,
        }),
      ),
    { status: 403 },
  );
  const before = fs.readFileSync(file(f)),
    lock = path.join(f.platformDirectory, 'assistant-state.lock');
  fs.writeFileSync(lock, 'Synthetic lock');
  try {
    assert.throws(() => api(f).approve(actor(f), body), { status: 503 });
  } finally {
    fs.unlinkSync(lock);
  }
  assert.deepEqual(fs.readFileSync(file(f)), before);
  assert.deepEqual(api(f).view(actor(f)), initial);
  f.database.db.prepare('UPDATE accounts SET global_admin=0 WHERE id=?').run(actor(f));
  assert.throws(() => api(f).approve(actor(f), body), { status: 403 });
});
