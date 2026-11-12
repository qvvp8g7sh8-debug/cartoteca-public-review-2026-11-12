const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDialogueStore,
  TTL_MS,
  MAX_DIALOGUES,
} = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
function fixture() {
  let now = 1000;
  const c = {
    current: {
      accountId: 'owner',
      organizationId: 'org',
      sessionId: 'session',
      role: 'owner',
      expiresAt: 1000 + TTL_MS * 2,
    },
  };
  const member = { membershipId: 'member' },
    state = { revision: 1 };
  const store = createDialogueStore({ now: () => now });
  return {
    store,
    c,
    member,
    state,
    advance(ms) {
      now += ms;
    },
    prepare() {
      return store.prepareCommand(c, member, state);
    },
    create(ticket) {
      return store.create(c, member, state, ticket, { selected: 'preserve' });
    },
  };
}

test('unaccepted or abandoned candidates preserve the previously accepted command and dialogue', () => {
  const f = fixture(),
    active = f.store.beginCommand(f.c, f.member, f.state),
    entry = f.create(active);
  const rejected = f.prepare();
  f.store.assertCommand(active);
  assert.equal(f.store.get(f.c, f.member, f.state, entry.id), entry);
  f.store.abandonCommand(rejected);
  f.store.assertCommand(active);
  assert.throws(() => f.store.acceptCommand(rejected), { status: 409 });
  assert.equal(f.store.get(f.c, f.member, f.state, entry.id).data.selected, 'preserve');
});

test('older acceptance preserves a newer pending candidate and newer acceptance fences the older generation', () => {
  const f = fixture(),
    a = f.prepare(),
    b = f.prepare();
  f.store.acceptCommand(a);
  const old = f.create(a);
  f.store.acceptCommand(b);
  f.store.acceptCommand(b);
  f.store.assertCommand(b);
  assert.throws(() => f.store.assertCommand(a), { status: 409 });
  assert.throws(() => f.store.get(f.c, f.member, f.state, old.id), { status: 409 });
  f.create(b);
  const g = fixture(),
    first = g.prepare(),
    second = g.prepare();
  g.store.acceptCommand(second);
  assert.throws(() => g.store.acceptCommand(first), { status: 409 });
  g.store.assertCommand(second);
});

test('account or session revocation invalidates pending and accepted tickets without affecting another account', () => {
  for (const revoke of ['account', 'session']) {
    const f = fixture(),
      active = f.store.beginCommand(f.c, f.member, f.state),
      pending = f.prepare();
    const other = { current: { ...f.c.current, accountId: 'other', sessionId: 'other-session' } };
    const otherTicket = f.store.prepareCommand(other, f.member, f.state);
    if (revoke === 'account') f.store.clearAccount('owner');
    else f.store.clearSession('session');
    assert.throws(() => f.store.acceptCommand(pending), { status: 409 });
    assert.throws(() => f.store.assertCommand(active), { status: 409 });
    f.store.acceptCommand(otherTicket);
    f.store.assertCommand(otherTicket);
  }
});

test('pending tickets expire and bounded pending admission does not discard an accepted dialogue', () => {
  const f = fixture(),
    active = f.store.beginCommand(f.c, f.member, f.state),
    entry = f.create(active),
    old = f.prepare();
  for (let i = 1; i < MAX_DIALOGUES; i++) f.prepare();
  assert.throws(() => f.prepare(), { status: 503, code: 'ASSISTANT_DIALOGUE_CAPACITY' });
  f.store.acceptCommand(old);
  assert.equal(f.store.stats().pending.active, MAX_DIALOGUES - 1);
  assert.throws(() => f.store.assertCommand(active), { status: 409 });
  const accepted = f.create(old);
  assert.equal(f.store.get(f.c, f.member, f.state, accepted.id), accepted);
  assert.throws(() => f.store.get(f.c, f.member, f.state, entry.id), { status: 409 });
  const expiring = f.prepare();
  f.advance(TTL_MS);
  assert.throws(() => f.store.acceptCommand(expiring), { status: 409 });
});

test('a ticket cannot create a dialogue under a changed role identity', () => {
  const f = fixture(),
    ticket = f.store.beginCommand(f.c, f.member, f.state);
  f.c.current.role = 'salon_admin';
  assert.throws(() => f.create(ticket), { status: 409 });
});

test('cancelling a current preparation invalidates pending candidates and retains exact spoken-cancel replay', () => {
  for (const spoken of [true, false]) {
    const f = dialogueFixture();
    const initial = f.start({
      query: 'Анну Семенову',
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
    });
    const pending = f.flow.prepareCommand(f.c, f.member, f.state);
    const accepted = f.answer(spoken ? { text: 'отмена' } : { cancel: true });
    assert.equal(accepted.result.dialogue, null);
    assert.equal(accepted.result.action, null);
    assert.throws(() => f.flow.acceptCommand(pending), { status: 409 });
    assert.deepEqual(
      f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock),
      accepted.result,
    );
    assert.equal(f.patients[0].appointments.length, 0);
    assert.equal(initial.action, null);
  }
});
