const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { reviewHash } = require('../src/server/modules/assistant/behavior/behavior-review.cjs');
const { createExampleSelector } = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const api = (f) => f.store.assistant.admin.behavior;
const actor = (f) => f.admin.accountId;
const file = (f) => path.join(f.platformDirectory, 'assistant-state.enc');
const read = (f) => f.database.open(fs.readFileSync(file(f)));
const rules = (exampleSelection = 'manual', examples = []) => ({
  instructions: '',
  dictionary: '',
  exampleSelection,
  examples,
});
const example = (expected, enabled = true) => ({
  id: randomUUID(),
  text: 'Синтетический контроль без публикации',
  referenceDate: '2026-10-16',
  referenceTime: '10:00',
  enabled,
  expected,
});
const good = () => ({
  ...example({ intent: 'calendar', date: '2026-10-17' }),
  text: 'Синтетический корректный календарь',
});
const bad = (enabled = true) =>
  example({ intent: 'calendar', query: 'ИмяНеДляОшибки', date: '2026-10-17' }, enabled);
const command = (revision, values) => ({
  expectedRevision: revision,
  requestId: randomUUID(),
  reason: 'Synthetic executable examples',
  ...values,
});
function preview(f, next) {
  return api(f).preview(actor(f), {
    expectedRevision: api(f).view(actor(f)).revision,
    rules: next,
  });
}
function approve(f, next) {
  const reviewed = preview(f, next);
  return api(f).approve(
    actor(f),
    command(reviewed.revision, {
      rules: reviewed.rules,
      reviewHash: reviewed.reviewHash,
      confirmed: true,
    }),
  );
}
function invalidNumber(error) {
  assert.equal(error.status, 400);
  assert.match(error.message, /пример(?:а)?\s*(?:№\s*)?2/iu);
  assert.doesNotMatch(
    error.message,
    /ИмяНеДляОшибки|Синтетический контроль|[a-f0-9]{8}-[a-f0-9]{4}/iu,
  );
  return true;
}
for (const mode of ['manual', 'automatic'])
  test(
    mode +
      ' new enabled examples reject unsupported conditions in preview and direct approval without writing state',
    async (t) => {
      const f = await adminFixture(t);
      fs.writeFileSync(file(f), f.database.seal(initialState()));
      const before = fs.readFileSync(file(f));
      for (const expected of [
        { intent: 'calendar', query: 'ИмяНеДляОшибки' },
        { intent: 'clients', date: '2026-10-17' },
        { intent: 'clientCard', time: '14:00' },
        { intent: 'help', duration: 30 },
        { intent: 'availability', query: 'ИмяНеДляОшибки' },
      ]) {
        const next = rules(mode, [good(), example(expected)]),
          revision = api(f).view(actor(f)).revision;
        assert.throws(() => preview(f, next), invalidNumber);
        assert.throws(
          () =>
            api(f).approve(
              actor(f),
              command(revision, {
                rules: next,
                reviewHash: reviewHash(actor(f), revision, next),
                confirmed: true,
              }),
            ),
          invalidNumber,
        );
        assert.deepEqual(fs.readFileSync(file(f)), before);
      }
    },
  );
test('disabled incompatible examples remain reviewable drafts and cannot enter runtime selection or be enabled', async (t) => {
  const f = await adminFixture(t);
  for (const mode of ['manual', 'automatic']) {
    const row = bad(false),
      next = rules(mode, [good(), row]);
    const approved = approve(f, next);
    assert.equal(approved.rules.examples[1].enabled, false);
    const select = createExampleSelector({ loadCatalog: () => ({ cases: [] }) });
    const result = select(row.text, { ...approved.rules, commands: { calendar: true } });
    assert.equal(result.examples.length, 1);
    assert.equal(result.examples[0].expected.intent, 'calendar');
    assert.equal(result.examples[0].expected.date, '2026-10-17');
    assert.equal(Object.hasOwn(result.examples[0].expected, 'query'), true);
    assert.equal(result.examples[0].expected.query, null);
    assert.ok(result.metadata.selected.every((entry) => entry.id !== row.id));
    assert.throws(
      () =>
        preview(f, {
          ...approved.rules,
          examples: [approved.rules.examples[0], { ...row, enabled: true }],
        }),
      invalidNumber,
    );
  }
});
test('legacy enabled incompatible examples can still be read, compared and restored while runtime skips them', async (t) => {
  const f = await adminFixture(t),
    legacy = initialState();
  legacy.policy.examples = [bad()];
  fs.writeFileSync(file(f), f.database.seal(legacy));
  const bytes = fs.readFileSync(file(f)),
    original = api(f).view(actor(f));
  assert.deepEqual(original.rules.examples[0].expected, legacy.policy.examples[0].expected);
  assert.deepEqual(fs.readFileSync(file(f)), bytes);
  const changed = approve(f, rules());
  assert.equal(
    api(f).compare(actor(f), original.version, changed.version).before.examples.length,
    1,
  );
  const restoreReview = api(f).preview(actor(f), {
    expectedRevision: changed.revision,
    sourceVersion: original.version,
  });
  const restored = api(f).restore(
    actor(f),
    command(restoreReview.revision, {
      sourceVersion: original.version,
      reviewHash: restoreReview.reviewHash,
      confirmed: true,
    }),
  );
  assert.deepEqual(restored.rules, original.rules);
  const selected = createExampleSelector({ loadCatalog: () => ({ cases: [] }) })(
    'Покажи календарь',
    { ...restored.rules, commands: { calendar: true } },
  );
  assert.deepEqual(selected.examples, []);
});
test('an exact historical approval receipt replays before new draft validation without another revision or behavior change', async (t) => {
  const f = await adminFixture(t),
    legacy = initialState(),
    next = rules('manual', [bad()]);
  const body = command(0, {
    rules: next,
    reviewHash: reviewHash(actor(f), 0, next),
    confirmed: true,
  });
  Object.assign(legacy.policy, next);
  legacy.revision = 1;
  legacy.behavior = {
    version: 1,
    current: { time: 1, actorId: actor(f), reason: body.reason },
    history: [
      { version: 0, time: null, actorId: null, reason: 'Начальные правила', rules: rules() },
    ],
  };
  legacy.operations = [
    {
      actorId: actor(f),
      requestId: body.requestId,
      fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      kind: 'assistant_behavior_approved',
      revision: 1,
    },
  ];
  fs.writeFileSync(file(f), f.database.seal(legacy));
  const before = read(f),
    result = api(f).approve(actor(f), structuredClone(body));
  assert.equal(result.revision, 1);
  assert.deepEqual(result.rules, next);
  assert.deepEqual(read(f), before);
  assert.throws(() => api(f).approve(actor(f), { ...body, reason: body.reason + ' changed' }), {
    status: 409,
  });
});
test('revision, reviewed content and global administration checks keep their existing rejection boundaries', async (t) => {
  const f = await adminFixture(t),
    reviewed = preview(f, rules());
  approve(f, rules('automatic'));
  const current = api(f).view(actor(f)),
    before = read(f);
  assert.throws(
    () =>
      api(f).preview(actor(f), {
        expectedRevision: reviewed.revision,
        rules: rules('manual', [bad()]),
      }),
    { status: 409 },
  );
  assert.throws(
    () =>
      api(f).approve(
        actor(f),
        command(reviewed.revision, {
          rules: rules('manual', [bad()]),
          reviewHash: reviewed.reviewHash,
          confirmed: true,
        }),
      ),
    { status: 409 },
  );
  const fresh = preview(f, rules('automatic'));
  assert.throws(
    () =>
      api(f).approve(
        actor(f),
        command(current.revision, {
          rules: { ...fresh.rules, dictionary: 'Unreviewed change' },
          reviewHash: fresh.reviewHash,
          confirmed: true,
        }),
      ),
    { status: 409 },
  );
  assert.throws(
    () =>
      api(f).preview(f.owner.accountId, {
        expectedRevision: current.revision,
        rules: rules('manual', [bad()]),
      }),
    { status: 403 },
  );
  assert.throws(
    () =>
      api(f).approve(
        f.owner.accountId,
        command(current.revision, {
          rules: rules('manual', [bad()]),
          reviewHash: fresh.reviewHash,
          confirmed: true,
        }),
      ),
    { status: 403 },
  );
  assert.deepEqual(read(f), before);
});
