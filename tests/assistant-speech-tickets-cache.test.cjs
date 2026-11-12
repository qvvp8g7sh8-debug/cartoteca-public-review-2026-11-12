const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechTickets } = require('../src/server/modules/assistant/speech/speech-tickets.cjs');
const {
  createSpeechCache,
  GENERIC_QUESTIONS,
} = require('../src/server/modules/assistant/speech/speech-cache.cjs');
function fixture() {
  const c = { current: { accountId: 'a', organizationId: 'o', sessionId: 's', role: 'owner' } };
  const state = {
    revision: 1,
    providers: { tts: { model: 'voice-model', voice: 'alloy' } },
    credentials: { timeweb: 'synthetic-key' },
    policy: { limits: {} },
    rates: {},
  };
  const member = { membershipId: 'm' };
  return { c, state, member, scope: () => ({ state, member }) };
}
test('speech tickets expire, are one-use and never contain spoken names in their URL', () => {
  let now = 1000;
  const t = createSpeechTickets({ now: () => now }),
    f = fixture();
  const url = t.issue(f.c, f.state, f.member, 'Синтетическая Анна, завтра');
  assert.match(
    url,
    /^\/api\/assistant\/speak-audio\?ticket=[A-Za-z0-9_-]{43}&accountContext=a&organizationContext=o$/,
  );
  const id = new URL(url, 'http://localhost').searchParams.get('ticket');
  assert.equal(t.take(f.c, id, f.scope).ticket.text, 'Синтетическая Анна, завтра');
  assert.throws(() => t.take(f.c, id, f.scope), { status: 410 });
  const expired = new URL(t.issue(f.c, f.state, f.member, 'Ответ'), 'http://localhost');
  now += 30001;
  assert.throws(() => t.take(f.c, expired.searchParams.get('ticket'), f.scope), { status: 410 });
});
test('tickets reject another session, organization, membership, credential or policy revision', () => {
  for (const change of [
    (f) => {
      f.c.current.sessionId = 'other';
    },
    (f) => {
      f.c.current.organizationId = 'other';
    },
    (f) => {
      f.member.membershipId = 'other';
    },
    (f) => {
      f.state.credentials.timeweb = 'different-synthetic-key';
    },
    (f) => {
      f.state.revision++;
    },
  ]) {
    const f = fixture(),
      tickets = createSpeechTickets();
    const id = new URL(
      tickets.issue(f.c, f.state, f.member, 'Ответ'),
      'http://localhost',
    ).searchParams.get('ticket');
    change(f);
    assert.throws(() => tickets.take(f.c, id, f.scope), { status: 403 });
  }
});
test('logout and account revocation clear unconsumed tickets', () => {
  const f = fixture(),
    t = createSpeechTickets();
  for (const kind of ['clearSession', 'clearAccount']) {
    const id = new URL(
      t.issue(f.c, f.state, f.member, 'Ответ'),
      'http://localhost',
    ).searchParams.get('ticket');
    t[kind](kind === 'clearSession' ? 's' : 'a');
    assert.throws(() => t.take(f.c, id, f.scope), { status: 410 });
  }
});
test('cache accepts only exact generic questions and coalesces pending generation', async () => {
  const f = fixture(),
    cache = createSpeechCache();
  for (const text of ['Анна?', 'На завтра?', 'На какую дату? Анна', 'Услуга PRX', 'на какую дату?'])
    assert.equal(cache.claim(f.state, 'o', text), null);
  const first = cache.claim(f.state, 'o', GENERIC_QUESTIONS[0]);
  const second = cache.claim(f.state, 'o', GENERIC_QUESTIONS[0]);
  assert.equal(first.owner, true);
  assert.equal(second.owner, false);
  const bytes = Buffer.from('synthetic-audio');
  first.finish(bytes);
  assert.equal((await second.promise).bytes, bytes);
  assert.equal((await cache.claim(f.state, 'o', GENERIC_QUESTIONS[0]).promise).bytes, bytes);
});
test('cache identity changes with credentials, voice, policy and organization; failed generation is not cached', async () => {
  const f = fixture(),
    cache = createSpeechCache(),
    text = GENERIC_QUESTIONS[0];
  const first = cache.claim(f.state, 'o', text),
    waiter = cache.claim(f.state, 'o', text);
  const error = new Error('Synthetic provider failure');
  first.fail(error);
  assert.equal((await waiter.promise).error, error);
  const next = cache.claim(f.state, 'o', text);
  assert.equal(next.owner, true);
  next.finish(Buffer.from('audio'));
  for (const changed of [
    { ...f.state, revision: 2 },
    { ...f.state, credentials: { timeweb: 'new-synthetic' } },
    { ...f.state, providers: { tts: { model: 'voice-model', voice: 'nova' } } },
  ])
    assert.equal(cache.claim(changed, 'o', text).owner, true);
  assert.equal(cache.claim(f.state, 'other-organization', text).owner, true);
});

test('frequent generic retry, closed-day and duration questions are cacheable only as exact literals', () => {
  assert.equal(GENERIC_QUESTIONS.length, 19);
  const f = fixture(),
    cache = createSpeechCache();
  for (const text of [
    'Как зовут клиента?',
    'Сколько минут длится приём?',
    'Что нужно сделать?',
    'День не открыт. Записать?',
    'Уточните полное имя или телефон клиента.',
    'Клиент не найден. Уточните имя или телефон.',
    'Не услышал ответ. Повторите.',
    'Повторите дату коротко, например «завтра».',
    'Назовите услугу коротко.',
    'Скажите «да» или «нет», либо назовите полное имя.',
    'Повторите ответ коротко или продолжите текстом.',
  ]) {
    assert.equal(cache.claim(f.state, 'o', text).owner, true, text);
    for (const changed of [text + ' Анна', text.toLowerCase(), ' ' + text])
      assert.equal(cache.claim(f.state, 'o', changed), null, changed);
  }
});

test('entry capacity evicts the least recently used completed question while preserving a recent hit', async () => {
  const f = fixture(),
    cache = createSpeechCache(),
    text = GENERIC_QUESTIONS[0];
  for (let i = 0; i < 24; i++)
    cache.claim(f.state, 'organization-' + i, text).finish(Buffer.from('audio-' + i));
  const recent = cache.claim(f.state, 'organization-0', text);
  assert.equal(recent.owner, false);
  assert.equal((await recent.promise).bytes.toString(), 'audio-0');
  const added = cache.claim(f.state, 'organization-24', text);
  assert.equal(added.owner, true);
  added.finish(Buffer.from('new-audio'));
  assert.equal(cache.claim(f.state, 'organization-0', text).owner, false);
  assert.equal(cache.claim(f.state, 'organization-1', text).owner, true);
});

test('byte capacity evicts completed LRU entries but retains the current generation and recent audio', async () => {
  const f = fixture(),
    cache = createSpeechCache(),
    text = GENERIC_QUESTIONS[0];
  const audio = Buffer.alloc(256 * 1024, 1);
  for (let i = 0; i < 8; i++) cache.claim(f.state, 'organization-' + i, text).finish(audio);
  assert.equal(cache.claim(f.state, 'organization-0', text).owner, false);
  const added = cache.claim(f.state, 'organization-8', text);
  added.finish(audio);
  const current = cache.claim(f.state, 'organization-8', text);
  assert.equal(current.owner, false);
  assert.equal((await current.promise).bytes, audio);
  assert.equal(cache.claim(f.state, 'organization-0', text).owner, false);
  assert.equal(cache.claim(f.state, 'organization-1', text).owner, true);
});

test('24 pending generations cannot be evicted and their followers remain coalesced', async () => {
  const f = fixture(),
    cache = createSpeechCache(),
    text = GENERIC_QUESTIONS[0];
  const owners = Array.from({ length: 24 }, (_, i) => cache.claim(f.state, 'pending-' + i, text));
  const marker = { synthetic: true };
  owners[0].bindGeneration(marker);
  const follower = cache.claim(f.state, 'pending-0', text);
  assert.equal(follower.owner, false);
  assert.equal(follower.generation, marker);
  assert.equal(cache.claim(f.state, 'overflow', text), null);
  owners[1].finish(Buffer.from('completed'));
  assert.equal(cache.claim(f.state, 'overflow', text).owner, true);
  const current = cache.claim(f.state, 'pending-0', text);
  assert.equal(current.owner, false);
  assert.equal(current.promise, follower.promise);
  assert.equal(current.generation, marker);
  const bytes = Buffer.from('eventually-complete');
  owners[0].finish(bytes);
  assert.equal((await follower.promise).bytes, bytes);
});

test('byte eviction does not detach a pending generation or its existing waiter', async () => {
  const f = fixture(),
    cache = createSpeechCache(),
    text = GENERIC_QUESTIONS[0];
  const pending = cache.claim(f.state, 'pending', text);
  const follower = cache.claim(f.state, 'pending', text);
  for (let i = 0; i < 9; i++)
    cache.claim(f.state, 'completed-' + i, text).finish(Buffer.alloc(256 * 1024, i));
  assert.equal(cache.claim(f.state, 'pending', text).promise, follower.promise);
  const bytes = Buffer.from('pending-result');
  pending.finish(bytes);
  assert.equal((await follower.promise).bytes, bytes);
  assert.equal(cache.claim(f.state, 'pending', text).owner, false);
});

test('cache hits do not extend the 15-minute TTL', () => {
  let now = 1000;
  const f = fixture(),
    cache = createSpeechCache({ now: () => now }),
    text = GENERIC_QUESTIONS[0];
  cache.claim(f.state, 'o', text).finish(Buffer.from('audio'));
  now += 15 * 60 * 1000 - 1;
  assert.equal(cache.claim(f.state, 'o', text).owner, false);
  now++;
  assert.equal(cache.claim(f.state, 'o', text).owner, true);
});

test('oversized finished audio serves its waiters without evicting useful completed questions or entering cache', async () => {
  const f = fixture(),
    cache = createSpeechCache(),
    text = GENERIC_QUESTIONS[0];
  for (let i = 0; i < 8; i++)
    cache.claim(f.state, 'completed-' + i, text).finish(Buffer.alloc(256 * 1024, i));
  const first = cache.claim(f.state, 'oversized', text),
    second = cache.claim(f.state, 'oversized', text);
  const bytes = Buffer.alloc(256 * 1024 + 1, 3);
  first.finish(bytes);
  assert.equal((await second.promise).bytes, bytes);
  assert.equal(cache.claim(f.state, 'oversized', text).owner, true);
  for (let i = 0; i < 8; i++)
    assert.equal(cache.claim(f.state, 'completed-' + i, text).owner, false);
});

test('LRU does not merge policy limits, rates, model, voice, credentials, revision or organizations', () => {
  const f = fixture(),
    cache = createSpeechCache(),
    text = GENERIC_QUESTIONS[0];
  cache.claim(f.state, 'o', text).finish(Buffer.from('original'));
  for (const changed of [
    { ...f.state, revision: 2 },
    { ...f.state, providers: { tts: { model: 'other-model', voice: 'alloy' } } },
    { ...f.state, providers: { tts: { model: 'voice-model', voice: 'nova' } } },
    { ...f.state, credentials: { timeweb: 'other-synthetic' } },
    { ...f.state, policy: { limits: { maxReplyChars: 100 } } },
    { ...f.state, rates: { ttsInput: 1 } },
  ])
    assert.equal(cache.claim(changed, 'o', text).owner, true);
  assert.equal(cache.claim(f.state, 'other-organization', text).owner, true);
  assert.equal(cache.claim(f.state, 'o', text).owner, false);
});
