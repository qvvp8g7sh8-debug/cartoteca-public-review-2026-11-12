const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { rowsFixture } = require('./helpers/assistant-rows-core-fixture.cjs');
const { validateSnapshot } = require('../src/server/modules/assistant/access/row-store.cjs');
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function configure(state) {
  state.providers.llm.provider = 'timeweb';
  state.providers.tts.provider = 'timeweb';
  state.credentials.timeweb = 'synthetic-timeweb-key-94';
}
function http(f) {
  const req = new EventEmitter(),
    res = Object.assign(new EventEmitter(), {
      chunks: [],
      headersSent: false,
      destroyed: false,
      writeHead() {
        this.headersSent = true;
      },
      write(bytes) {
        this.chunks.push(Buffer.from(bytes));
        return true;
      },
      end() {
        this.writableFinished = true;
      },
      destroy() {
        this.destroyed = true;
        this.emit('close');
      },
    });
  return { ...f.c(), req, res };
}
function revoke(f) {
  f.context.db
    .prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?')
    .run('suspended', f.owner.organizationId, f.owner.accountId);
}

test('SQL queued outbound rechecks revoked membership before provider POST and closes its admitted reservation', async (t) => {
  const f = await rowsFixture(t, { initial: configure }),
    entered = gate(),
    release = gate();
  const original = f.context.asyncTransaction;
  let writes = 0,
    provider = 0;
  f.context.asyncTransaction = async (callback) => {
    if (++writes === 2) {
      entered.resolve();
      await release.promise;
    }
    return original(callback);
  };
  const api = f.api({
    fetchImpl: async () => {
      provider++;
      throw Error('Unexpected external provider');
    },
  });
  const pending = api.turn(f.c(), { text: 'Календарь', policyVersion: 3 });
  const rejected = assert.rejects(pending, { status: 403 });
  await entered.promise;
  assert.equal(validateSnapshot(f.context).reservations, 1);
  revoke(f);
  release.resolve();
  await rejected;
  assert.equal(provider, 0);
  assert.equal(validateSnapshot(f.context).reservations, 0);
  assert.equal(f.repository.month(f.month).spentMicrorub, 0);
  assert.equal(f.repository.month(f.month).calls, 1);
  assert.equal(f.repository.day(f.date, f.membershipId), 1);
});

test('revocation after SQL outbound still conservatively settles provider debt before rejecting result', async (t) => {
  const f = await rowsFixture(t, { initial: configure }),
    entered = gate(),
    release = gate();
  let provider = 0;
  const api = f.api({
    fetchImpl: async () => {
      provider++;
      entered.resolve();
      await release.promise;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"intent":"calendar"}' } }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const pending = api.turn(f.c(), { text: 'Календарь', policyVersion: 3 });
  const rejected = assert.rejects(pending, { status: 403 });
  await entered.promise;
  const quote = f.repository.month(f.month).reservedMicrorub;
  assert.ok(quote > 0);
  assert.equal(
    f.context.db.prepare('SELECT state FROM assistant_reservations').get().state,
    'outbound',
  );
  revoke(f);
  release.resolve();
  await rejected;
  assert.equal(provider, 1);
  assert.equal(validateSnapshot(f.context).reservations, 0);
  assert.equal(f.repository.month(f.month).spentMicrorub, quote);
  assert.equal(f.repository.month(f.month).uncertainCalls, 1);
});

test('rejected asynchronous SQL speech admission preserves429 and never settles a Promise or starts provider', async (t) => {
  const f = await rowsFixture(t, {
    initial(state, { date, membershipId }) {
      configure(state);
      state.policy.limits.dailyRequests = 1;
      state.daily[date + ':' + membershipId] = 1;
    },
  });
  let provider = 0,
    writes = 0;
  const original = f.context.asyncTransaction;
  f.context.asyncTransaction = (callback) => {
    writes++;
    return original(callback);
  };
  const api = f.api({
    fetchImpl: async () => {
      provider++;
      throw Error('Unexpected external provider');
    },
  });
  const ticket = await api.speak(f.c(), { text: 'На какую дату?', policyVersion: 3, stream: true });
  const c = http(f);
  c.url = new URL(ticket.streamUrl, 'http://localhost');
  await assert.rejects(api.speakAudio(c), { status: 429 });
  assert.equal(writes, 1, 'Only failed admission; no attempt to settle a rejected Promise');
  assert.equal(provider, 0);
  assert.equal(validateSnapshot(f.context).reservations, 0);
  assert.equal(getEventListeners(c.req, 'aborted').length, 0);
  assert.equal(getEventListeners(c.res, 'close').length, 0);
  await assert.rejects(api.speakAudio(c), { status: 410 });
});

test('successful SQL speech EOF awaits actual settlement and cached follower reserves zero without second provider', async (t) => {
  const f = await rowsFixture(t, { initial: configure });
  let provider = 0;
  const mp3 = Buffer.alloc(417);
  Buffer.from([255, 251, 144, 100]).copy(mp3);
  const api = f.api({
    fetchImpl: async () => {
      provider++;
      return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  for (let i = 0; i < 2; i++) {
    const ticket = await api.speak(f.c(), {
      text: 'На какую дату?',
      policyVersion: 3,
      stream: true,
    });
    const c = http(f);
    c.url = new URL(ticket.streamUrl, 'http://localhost');
    await api.speakAudio(c);
    assert.equal(c.res.writableFinished, true);
    assert.deepEqual(Buffer.concat(c.res.chunks), mp3);
    assert.equal(validateSnapshot(f.context).reservations, 0);
    assert.equal(getEventListeners(c.req, 'aborted').length, 0);
    assert.equal(getEventListeners(c.res, 'close').length, 0);
  }
  assert.equal(provider, 1);
  assert.equal(f.repository.month(f.month).calls, 2);
  assert.equal(f.repository.day(f.date, f.membershipId), 2);
  assert.ok(f.repository.month(f.month).spentMicrorub > 0);
  assert.equal(f.repository.month(f.month).uncertainCalls, 0);
});

test('asynchronous SQL success/fallback settlement failures clear generic cache without dropping pending debt or giving a free retry', async (t) => {
  const f = await rowsFixture(t, { initial: configure });
  const original = f.context.asyncTransaction;
  let writes = 0,
    provider = 0;
  f.context.asyncTransaction = (callback) => {
    if ([3, 4].includes(++writes))
      return Promise.reject(
        Object.assign(Error('Synthetic SQL writer unavailable'), { status: 503 }),
      );
    return original(callback);
  };
  const mp3 = Buffer.alloc(417);
  Buffer.from([255, 251, 144, 100]).copy(mp3);
  const api = f.api({
    fetchImpl: async () => {
      provider++;
      return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  const first = await api.speak(f.c(), { text: 'На какую дату?', policyVersion: 3, stream: true });
  const a = http(f);
  a.url = new URL(first.streamUrl, 'http://localhost');
  await assert.rejects(api.speakAudio(a), { status: 503 });
  assert.equal(a.res.writableFinished, undefined, 'EOF is not acknowledged before accounting');
  assert.equal(validateSnapshot(f.context).reservations, 1);
  const outstanding = f.repository.month(f.month).reservedMicrorub;
  assert.ok(outstanding > 0);
  const retry = await api.speak(f.c(), { text: 'На какую дату?', policyVersion: 3, stream: true });
  const b = http(f);
  b.url = new URL(retry.streamUrl, 'http://localhost');
  await api.speakAudio(b);
  assert.equal(provider, 2, 'Failed commit must not promote the reply into free generic cache');
  assert.equal(f.repository.month(f.month).reservedMicrorub, outstanding);
  assert.equal(validateSnapshot(f.context).reservations, 1);
  assert.equal(f.repository.day(f.date, f.membershipId), 2);
});
