const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { resetRestoredAssistant } = require('../src/server/modules/assistant/access/store.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { modelPayload, demoIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');

const rules = (values = {}) => ({
  instructions: '',
  dictionary: '',
  exampleSelection: 'manual',
  examples: [],
  ...values,
});
const example = (values = {}) => ({
  id: randomUUID(),
  text: 'Покажи расписание завтра',
  referenceDate: '2026-10-15',
  referenceTime: '10:00',
  enabled: true,
  expected: { intent: 'calendar', date: '2026-10-16' },
  ...values,
});
const api = (f) => f.store.assistant.admin.behavior;
const actor = (f) => f.admin.accountId;
const filename = (f) => path.join(f.platformDirectory, 'assistant-state.enc');
const readState = (f) => f.database.open(fs.readFileSync(filename(f)));
const command = (expectedRevision, values = {}) => ({
  expectedRevision,
  requestId: randomUUID(),
  reason: 'Synthetic behavior change',
  ...values,
});
function preview(f, nextRules, extra = {}) {
  return api(f).preview(actor(f), {
    expectedRevision: api(f).view(actor(f)).revision,
    rules: nextRules,
    ...extra,
  });
}
function approve(f, nextRules) {
  const review = preview(f, nextRules);
  return api(f).approve(
    actor(f),
    command(review.revision, {
      rules: review.rules,
      reviewHash: review.reviewHash,
      confirmed: true,
    }),
  );
}
function saveSettings(f, values) {
  const admin = f.store.assistant.admin;
  return admin.settings(actor(f), command(admin.view(actor(f)).revision, values));
}

test('behavior reads default-off and legacy encrypted settings without creating or rewriting state', async (t) => {
  const f = await adminFixture(t);
  const initial = api(f).view(actor(f));
  assert.equal(initial.version, 0);
  assert.deepEqual(initial.rules, rules());
  assert.equal(fs.existsSync(filename(f)), false);
  assert.equal(f.store.assistant.admin.view(actor(f)).policy.mode, 'off');
  const legacy = initialState();
  delete legacy.behavior;
  delete legacy.policy.examples;
  legacy.policy.instructions = 'Legacy preferences';
  fs.writeFileSync(filename(f), f.database.seal(legacy));
  const bytes = fs.readFileSync(filename(f)),
    loaded = api(f).view(actor(f));
  assert.equal(loaded.version, 0);
  assert.equal(loaded.rules.instructions, legacy.policy.instructions);
  assert.deepEqual(loaded.rules.examples, []);
  assert.deepEqual(fs.readFileSync(filename(f)), bytes);
});

test('all behavior administration operations reject tenant accounts and revoked global operators', async (t) => {
  const f = await adminFixture(t);
  const calls = [
    (id) => api(f).view(id),
    (id) => api(f).compare(id, 0, 0),
    (id) => api(f).preview(id, { expectedRevision: 0, rules: rules() }),
    (id) => api(f).approve(id, command(0)),
    (id) => api(f).restore(id, command(0)),
  ];
  for (const call of calls) assert.throws(() => call(f.owner.accountId), { status: 403 });
  f.database.db.prepare('UPDATE accounts SET global_admin=0 WHERE id=?').run(actor(f));
  for (const call of calls) assert.throws(() => call(actor(f)), { status: 403 });
  assert.equal(fs.existsSync(filename(f)), false);
});

test('preview returns normalized readable differences without activating a draft or exposing credentials', async (t) => {
  const f = await adminFixture(t);
  saveSettings(f, { timewebApiKey: 'SYNTHETIC-BEHAVIOR-KEY' });
  const before = fs.readFileSync(filename(f));
  const row = example({ expected: { intent: 'clients', query: '  Синтетический клиент  ' } });
  const next = rules({ instructions: '<img src=x onerror=alert(1)>', examples: [row] });
  const review = preview(f, next);
  assert.equal(review.rules.examples[0].expected.query, 'Синтетический клиент');
  assert.equal(review.changes.instructions.changed, true);
  assert.equal(review.changes.examples.added[0].id, row.id);
  assert.equal(typeof review.reviewHash, 'string');
  assert.deepEqual(api(f).view(actor(f)).rules, rules());
  assert.deepEqual(fs.readFileSync(filename(f)), before);
  const dto = JSON.stringify([api(f).view(actor(f)), review, api(f).compare(actor(f), 0, 0)]);
  assert.doesNotMatch(dto, /SYNTHETIC-BEHAVIOR-KEY|"credentials"|"grants"|"rates"/);
});

test('approval binds explicit confirmation, reviewed content, revision and the reviewing actor', async (t) => {
  const f = await adminFixture(t),
    next = rules({ instructions: 'Brief answer' });
  const review = preview(f, next);
  const body = command(review.revision, { rules: next, reviewHash: review.reviewHash });
  assert.throws(() => api(f).approve(actor(f), body), { status: 400 });
  assert.throws(() => api(f).approve(actor(f), { ...body, confirmed: false }), { status: 400 });
  assert.throws(
    () =>
      api(f).approve(actor(f), {
        ...body,
        confirmed: true,
        rules: rules({ instructions: 'Changed text' }),
      }),
    { status: 409 },
  );
  f.database.db.prepare('UPDATE accounts SET global_admin=1 WHERE id=?').run(f.other.accountId);
  assert.throws(() => api(f).approve(f.other.accountId, { ...body, confirmed: true }), {
    status: 409,
  });
  saveSettings(f, { rates: { llmInput: 42 } });
  assert.throws(() => api(f).approve(actor(f), { ...body, confirmed: true }), { status: 409 });
  assert.deepEqual(api(f).view(actor(f)).rules, rules());
});

test('an unknown-response retry replays one exact approval and rejects reuse for another change', async (t) => {
  const f = await adminFixture(t),
    review = preview(f, rules({ dictionary: 'Synthetic term' }));
  const body = command(review.revision, {
    rules: review.rules,
    reviewHash: review.reviewHash,
    confirmed: true,
  });
  const committed = api(f).approve(actor(f), body),
    state = readState(f);
  const retried = api(f).approve(actor(f), structuredClone(body));
  assert.deepEqual(retried, committed);
  assert.equal(readState(f).operations.length, state.operations.length);
  assert.equal(readState(f).behavior.history.length, state.behavior.history.length);
  assert.throws(() => api(f).approve(actor(f), { ...body, reason: 'Another reason' }), {
    status: 409,
  });
  f.reopen();
  assert.deepEqual(api(f).view(actor(f)), committed);
});

test('state lock rejects competing approval before any rules become active', async (t) => {
  const f = await adminFixture(t),
    review = preview(f, rules({ instructions: 'New style' }));
  const lock = path.join(f.platformDirectory, 'assistant-state.lock');
  fs.writeFileSync(lock, 'synthetic lock');
  try {
    assert.throws(
      () =>
        api(f).approve(
          actor(f),
          command(review.revision, {
            rules: review.rules,
            reviewHash: review.reviewHash,
            confirmed: true,
          }),
        ),
      { status: 503 },
    );
    assert.equal(fs.existsSync(filename(f)), false);
  } finally {
    fs.unlinkSync(lock);
  }
  assert.deepEqual(api(f).view(actor(f)).rules, rules());
});

test('version comparison describes additions, edits, removals and order without mutating state', async (t) => {
  const f = await adminFixture(t),
    a = example(),
    b = example({ text: 'Найди Тестового' });
  const first = approve(f, rules({ instructions: 'First version', examples: [a, b] }));
  const replacement = example({ text: 'Покажи сегодня' });
  const second = approve(
    f,
    rules({ dictionary: 'New dictionary', examples: [{ ...b, enabled: false }, replacement] }),
  );
  const bytes = fs.readFileSync(filename(f));
  const diff = api(f).compare(actor(f), first.version, second.version);
  assert.equal(diff.changes.instructions.before, 'First version');
  assert.equal(diff.changes.dictionary.after, 'New dictionary');
  assert.deepEqual(
    diff.changes.examples.removed.map((item) => item.id),
    [a.id],
  );
  assert.deepEqual(
    diff.changes.examples.added.map((item) => item.id),
    [replacement.id],
  );
  assert.equal(diff.changes.examples.changed[0].id, b.id);
  const reordered = preview(f, {
    ...second.rules,
    examples: second.rules.examples.slice().reverse(),
  });
  assert.equal(reordered.changes.examples.orderChanged, true);
  assert.deepEqual(reordered.changes.examples.changed, []);
  assert.deepEqual(fs.readFileSync(filename(f)), bytes);
  assert.throws(() => api(f).compare(actor(f), -1, second.version));
});

test('behavior restore preserves current keys, access, command switches, limits, providers and rates', async (t) => {
  const f = await adminFixture(t),
    first = approve(f, rules({ instructions: 'Initial style' }));
  approve(f, rules({ instructions: 'Later style', examples: [example()] }));
  saveSettings(f, {
    policy: { mode: 'selected', commands: { clients: false }, limits: { dailyRequests: 17 } },
    providers: { llm: { provider: 'codex', model: 'codex-default' } },
    timewebApiKey: 'SYNTHETIC-RESTORE-KEY',
    rates: { llmInput: 73 },
  });
  f.store.assistant.admin.setMember(
    actor(f),
    command(api(f).view(actor(f)).revision, {
      organizationId: f.owner.organizationId,
      accountId: f.owner.accountId,
      enabled: true,
    }),
  );
  const before = readState(f),
    review = api(f).preview(actor(f), {
      expectedRevision: before.revision,
      sourceVersion: first.version,
    });
  assert.equal(review.rules.instructions, 'Initial style');
  const restored = api(f).restore(
    actor(f),
    command(review.revision, {
      sourceVersion: first.version,
      reviewHash: review.reviewHash,
      confirmed: true,
    }),
  );
  assert.deepEqual(restored.rules, first.rules);
  assert.ok(restored.version > first.version);
  const after = readState(f);
  for (const key of ['credentials', 'grants', 'providers', 'rates', 'usage', 'daily'])
    assert.deepEqual(after[key], before[key]);
  for (const key of ['mode', 'commands', 'limits'])
    assert.deepEqual(after.policy[key], before.policy[key]);
});

test('generic settings cannot bypass review; generic restore preserves rules and behavior history is bounded', async (t) => {
  const f = await adminFixture(t);
  const first = approve(f, rules({ instructions: 'Version 1' }));
  for (const policy of [
    { instructions: 'Unreviewed change' },
    { dictionary: 'Unreviewed dictionary' },
    { examples: [example()] },
  ])
    assert.throws(() => saveSettings(f, { policy }), { status: 400 });
  assert.deepEqual(api(f).view(actor(f)).rules, first.rules);
  saveSettings(f, { policy: { ...first.rules, limits: { dailyRequests: 19 } } });
  assert.equal(api(f).view(actor(f)).version, first.version);
  f.store.assistant.admin.restore(
    actor(f),
    command(api(f).view(actor(f)).revision, { revision: 0 }),
  );
  assert.deepEqual(api(f).view(actor(f)).rules, first.rules);
  assert.equal(api(f).view(actor(f)).version, first.version);
  for (let i = 0; i < 12; i++) approve(f, rules({ instructions: 'Next version ' + i }));
  const view = api(f).view(actor(f));
  assert.equal(view.versions.filter((item) => !item.current).length, 10);
  assert.equal(view.versions.filter((item) => item.current).length, 1);
  assert.throws(() => api(f).compare(actor(f), first.version, view.version), { status: 404 });
});

test('typed examples reject malformed intents, dates, identifiers and corpus/prompt overflows', async (t) => {
  const f = await adminFixture(t);
  const invalid = [
    example({ id: 'not-a-uuid' }),
    example({ referenceDate: '2026-02-31' }),
    example({ referenceTime: '24:00' }),
    example({ text: 'a'.repeat(501) }),
    example({ expected: { intent: 'deleteAppointment' } }),
    example({ expected: { intent: 'prepareAppointment', duration: 7 } }),
    example({ expected: { intent: 'clients', accountId: randomUUID() } }),
  ];
  for (const row of invalid)
    assert.throws(() => preview(f, rules({ examples: [row] })), { status: 400 });
  assert.equal(
    preview(f, rules({ examples: Array.from({ length: 50 }, () => example({ enabled: false })) }))
      .rules.examples.length,
    50,
  );
  const duplicate = example();
  assert.throws(() => preview(f, rules({ examples: [duplicate, duplicate] })), { status: 400 });
  for (const rows of [
    Array.from({ length: 51 }, () => example({ enabled: false })),
    Array.from({ length: 13 }, () => example()),
    Array.from({ length: 12 }, () => example({ text: 'Я'.repeat(500) })),
    Array.from({ length: 50 }, () =>
      example({
        enabled: false,
        text: 'Я'.repeat(500),
        expected: { intent: 'clients', query: 'Я'.repeat(160) },
      }),
    ),
  ])
    assert.throws(() => preview(f, rules({ examples: rows })), { status: 400 });
  assert.equal(fs.existsSync(filename(f)), false);
});

test('only approved enabled examples enter bounded two-message model context; demo semantics stay unchanged', async (t) => {
  const f = await adminFixture(t);
  saveSettings(f, { providers: { llm: { provider: 'codex' } } });
  const active = example({ text: 'Синтетическая фраза активного примера' });
  const disabled = example({ text: 'Синтетическая фраза выключенного примера', enabled: false });
  const next = rules({ examples: [active, disabled] });
  preview(f, next);
  const before = modelPayload('Текущая команда', readState(f), 'Europe/Moscow').payload;
  assert.doesNotMatch(JSON.stringify(before), /Синтетическая фраза/);
  const clock = { date: '2026-10-15', hour: 10, minute: 0 };
  const demoBefore = demoIntent(active.text, clock);
  approve(f, next);
  const payload = modelPayload('Текущая команда', readState(f), 'Europe/Moscow').payload;
  assert.equal(payload.messages.length, 2);
  assert.deepEqual(payload.messages[1], { role: 'user', content: 'Текущая команда' });
  assert.match(payload.messages[0].content, /Синтетическая фраза активного примера/);
  assert.doesNotMatch(payload.messages[0].content, /Синтетическая фраза выключенного примера/);
  assert.equal(payload.messages[0].content.includes(active.id), false);
  assert.deepEqual(demoIntent(active.text, clock), demoBefore);
});

test('disaster restore retains active behavior but clears grants, secrets and histories and invalidates review', async (t) => {
  const f = await adminFixture(t);
  approve(
    f,
    rules({
      instructions: 'Retained preferences',
      dictionary: 'Example term',
      examples: [example()],
    }),
  );
  saveSettings(f, { policy: { mode: 'selected' }, timewebApiKey: 'SYNTHETIC-DISASTER-KEY' });
  f.store.assistant.admin.setMember(
    actor(f),
    command(api(f).view(actor(f)).revision, {
      organizationId: f.owner.organizationId,
      accountId: f.owner.accountId,
      enabled: true,
    }),
  );
  const old = api(f).view(actor(f)),
    review = preview(f, rules({ instructions: 'Stale draft' }));
  resetRestoredAssistant({
    directory: f.platformDirectory,
    seal: f.database.seal,
    open: f.database.open,
  });
  const restored = api(f).view(actor(f)),
    state = readState(f);
  assert.deepEqual(restored.rules, old.rules);
  assert.ok(restored.revision > old.revision);
  assert.ok(restored.version > old.version);
  assert.equal(state.policy.mode, 'off');
  for (const key of ['grants', 'operations', 'audit', 'history']) assert.deepEqual(state[key], []);
  assert.deepEqual(state.behavior.history, []);
  assert.deepEqual(state.credentials, {});
  assert.deepEqual(state.reservations, {});
  assert.throws(
    () =>
      api(f).approve(
        actor(f),
        command(review.revision, {
          rules: review.rules,
          reviewHash: review.reviewHash,
          confirmed: true,
        }),
      ),
    { status: 409 },
  );
});
