const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDialogueStore,
  TTL_MS,
} = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const {
  createDialogueRegistry,
  MAX_CAPACITY,
} = require('../src/server/modules/assistant/dialogue/dialogue-registry.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');

function fixture(capacity = 2) {
  let instant = 1000;
  const store = createDialogueStore({ now: () => instant, capacity });
  const member = { membershipId: 'synthetic-member' },
    state = { revision: 1 };
  const context = (index) => ({
    current: {
      accountId: 'synthetic-account-' + index,
      organizationId: 'synthetic-org-' + index,
      sessionId: 'synthetic-session-' + index,
      role: 'owner',
      expiresAt: instant + TTL_MS * 2,
    },
  });
  function create(index) {
    const c = context(index),
      ticket = store.beginCommand(c, member, state);
    return { c, ticket, entry: store.create(c, member, state, ticket, { synthetic: index }) };
  }
  return {
    store,
    member,
    state,
    context,
    create,
    advance(ms) {
      instant += ms;
    },
  };
}

test('full command admission preserves every active account and permits the same pending candidate after capacity is released', () => {
  const f = fixture(),
    a = f.create('a'),
    b = f.create('b'),
    c = f.context('c');
  const waiting = f.store.prepareCommand(c, f.member, f.state);
  assert.throws(() => f.store.acceptCommand(waiting), {
    status: 503,
    code: 'ASSISTANT_DIALOGUE_CAPACITY',
    retryAfter: 2,
    outcomeUnknown: false,
  });
  for (const owned of [a, b]) {
    f.store.assertCommand(owned.ticket);
    assert.equal(f.store.get(owned.c, f.member, f.state, owned.entry.id), owned.entry);
  }
  assert.equal(
    f.store.stats().pending.active,
    1,
    'a rejected acceptance does not erase its candidate',
  );
  f.store.clearAccount(a.c.current.accountId);
  f.store.acceptCommand(waiting);
  const admitted = f.store.create(c, f.member, f.state, waiting, {});
  assert.equal(f.store.get(c, f.member, f.state, admitted.id), admitted);
  assert.equal(f.store.get(b.c, f.member, f.state, b.entry.id), b.entry);
  assert.equal(f.store.stats().commands.rejected, 1);
});

test('pending capacity rejects the newcomer without expelling an older outstanding candidate or accepted dialogue', () => {
  const f = fixture(),
    a = f.create('a');
  const first = f.store.prepareCommand(f.context('b'), f.member, f.state);
  const second = f.store.prepareCommand(f.context('c'), f.member, f.state);
  assert.throws(() => f.store.prepareCommand(f.context('d'), f.member, f.state), { status: 503 });
  f.store.assertCommand(a.ticket);
  assert.equal(f.store.get(a.c, f.member, f.state, a.entry.id), a.entry);
  f.store.acceptCommand(first);
  f.store.abandonCommand(second);
  assert.equal(f.store.stats().pending.active, 0);
  assert.equal(f.store.stats().pending.rejected, 1);
});

test('replacing an owned command at capacity fences its old dialogue while preserving unrelated accounts', () => {
  const f = fixture(),
    a = f.create('a'),
    b = f.create('b');
  const next = f.store.beginCommand(a.c, f.member, f.state);
  const replacement = f.store.create(a.c, f.member, f.state, next, { replacement: true });
  assert.throws(() => f.store.assertCommand(a.ticket), { status: 409 });
  assert.throws(() => f.store.get(a.c, f.member, f.state, a.entry.id), { status: 409 });
  assert.equal(f.store.get(a.c, f.member, f.state, replacement.id), replacement);
  assert.equal(f.store.get(b.c, f.member, f.state, b.entry.id), b.entry);
  assert.equal(f.store.stats().commands.rejected, 0);
});

test('dialogue capacity failure retains existing options and replay state until their actual expiry', () => {
  const f = fixture(1),
    a = f.create('a');
  a.entry.options.set('opaque-synthetic', { action: 'selected' });
  a.entry.response = { text: 'Синтетический ответ', dialogue: { version: 0 } };
  assert.throws(() => f.store.create(a.c, f.member, f.state, a.ticket, {}), { status: 503 });
  const retained = f.store.get(a.c, f.member, f.state, a.entry.id);
  assert.equal(retained.options.get('opaque-synthetic').action, 'selected');
  assert.equal(retained.response.text, 'Синтетический ответ');
  f.advance(TTL_MS);
  assert.throws(() => f.store.get(a.c, f.member, f.state, a.entry.id), { status: 409 });
  const fresh = f.create('b');
  assert.equal(f.store.get(fresh.c, f.member, f.state, fresh.entry.id), fresh.entry);
  assert.equal(f.store.stats().dialogues.expired, 1);
});

test('indexed deletion and arbitrary expiry order retain no stale heap nodes, account keys or session ownership', () => {
  let now = 10;
  const registry = createDialogueRegistry({ now: () => now, capacity: 8 });
  for (let pass = 0; pass < 1000; pass++) {
    for (let index = 0; index < 8; index++)
      registry.set('key-' + index, {
        accountId: 'account-' + index,
        sessionId: 'session-' + index,
        expiresAt: now + [30, 10, 70, 20, 40, 80, 60, 50][index],
      });
    registry.clearAccount('account-3');
    registry.clearSession('session-6');
    registry.delete('key-0');
    now += 50;
    registry.sweep();
    assert.equal(registry.stats().active, 2);
    assert.equal(registry.stats().expiryEntries, 2);
    assert.equal(registry.get('key-2').accountId, 'account-2');
    assert.equal(registry.get('key-5').accountId, 'account-5');
    now += 50;
    registry.sweep();
    assert.equal(registry.stats().active, 0);
    assert.equal(registry.stats().expiryEntries, 0);
    assert.deepEqual(registry.forAccount('account-2'), []);
  }
});

test('capacity options are explicit bounded integers rather than an implicit unbounded cache increase', () => {
  for (const capacity of [0, -1, NaN, Infinity, 1.5, '3000', null, MAX_CAPACITY + 1])
    assert.throws(() => createDialogueStore({ capacity }), /capacity/);
  assert.equal(createDialogueStore().stats().dialogues.capacity, 100);
  assert.equal(createDialogueStore({ capacity: 3000 }).stats().dialogues.capacity, 3000);
});

test('3000 explicitly admitted synthetic dialogue snapshots keep their own options, replay and session isolation', (t) => {
  const sample = dialogueFixture();
  const started = sample.start({
    query: 'Анну Семенову',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
  });
  const template = sample.flow.get(sample.c, sample.member, sample.state, started.dialogue.id);
  const f = fixture(3000),
    owned = [],
    before = process.memoryUsage().heapUsed;
  for (let index = 0; index < 3000; index++) {
    const current = f.create(index);
    current.entry.data = structuredClone(template.data);
    current.entry.options = structuredClone(template.options);
    current.entry.response = structuredClone(template.response);
    owned.push(current);
  }
  const snapshot = f.store.stats();
  assert.equal(snapshot.dialogues.active, 3000);
  assert.equal(snapshot.commands.active, 3000);
  assert.equal(snapshot.pending.active, 0);
  assert.throws(() => f.create(3000), { status: 503 });
  for (let index = 0; index < owned.length; index++) {
    const current = owned[index],
      other = owned[(index + 1) % owned.length];
    assert.equal(f.store.get(current.c, f.member, f.state, current.entry.id), current.entry);
    assert.throws(() => f.store.get(other.c, f.member, f.state, current.entry.id), { status: 409 });
  }
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /synthetic|Семенов|accountId|sessionId|organizationId/,
  );
  t.diagnostic(
    JSON.stringify({
      syntheticDialogues: 3000,
      heapDeltaBytesWithoutForcedGC: process.memoryUsage().heapUsed - before,
      registry: snapshot,
      boundary:
        'process-local synthetic storage sample; not throughput, RSS sizing or cross-process durability',
    }),
  );
});
