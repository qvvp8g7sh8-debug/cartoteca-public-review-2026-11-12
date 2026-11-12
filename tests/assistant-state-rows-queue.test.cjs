const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { rowsFixture } = require('./helpers/assistant-rows-core-fixture.cjs');
const { createRequestHandler } = require('../src/server/http/request-handler.cjs');
const { routes } = require('../src/server/modules/assistant/routes.cjs');
const { validateSnapshot } = require('../src/server/modules/assistant/access/row-store.cjs');
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const command = (values) => ({
  expectedRevision: 3,
  requestId: randomUUID(),
  reason: 'Синтетическая проверка очереди SQL',
  ...values,
});
function request(f, api) {
  const done = gate(),
    released = gate(),
    data = Buffer.from(JSON.stringify({ text: 'Календарь', policyVersion: 3 }));
  const current = f.current();
  const req = Object.assign(Readable.from([data]), {
    complete: true,
    aborted: false,
    method: 'POST',
    url: '/api/assistant/turn',
    socket: { localPort: 4197 },
    headers: {
      host: '127.0.0.1:4197',
      origin: 'http://127.0.0.1:4197',
      'x-cartoteca-request': '1',
      'content-type': 'application/json',
      'content-length': String(data.length),
      cookie: 'cartoteca_v2_session=' + f.ownerSession.token,
      'x-cartoteca-account-id': current.accountId,
      'x-cartoteca-organization-id': current.organizationId,
    },
  });
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(bytes) {
      this.body = JSON.parse(bytes);
      this.writableEnded = true;
      this.writableFinished = true;
      this.emit('finish');
      done.resolve();
    },
  });
  const noop = () => {};
  const handler = createRequestHandler({
    config: { origin: 'http://127.0.0.1:4197' },
    platform: { ...f.store, assistant: api },
    routes,
    pool: {
      lease: () => ({
        get() {
          throw Error('Unexpected clinical read');
        },
        release: () => released.resolve(),
      }),
    },
    metrics: { track: () => ({ stage: noop, route: noop, phase: noop, failure: noop }) },
    requestDispatcher: { run: (callback) => Promise.resolve().then(callback) },
    clientAddress: () => '127.0.0.1',
    services: {},
  });
  handler(req, res);
  return { req, res, finished: Promise.all([done.promise, released.promise]) };
}

for (const [change, expected] of [
  ['grant OFF', 403],
  ['global revision', 409],
  ['logout', 401],
  ['session expiry', 401],
  ['session account switch', 428],
])
  test(
    'actual HTTP context fences ' + change + ' after queued SQL admission without provider or debt',
    { timeout: 10000 },
    async (t) => {
      const f = await rowsFixture(t, {
        initial(state) {
          state.providers.llm.provider = 'timeweb';
          state.credentials.timeweb = 'synthetic-timeweb-key-94';
        },
      });
      const entered = gate(),
        release = gate();
      t.after(release.resolve);
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
      const beforeSession = f.current(),
        otherBefore = f.context.db
          .prepare('SELECT value FROM accounts WHERE id=?')
          .get(f.other.accountId).value;
      const pending = request(f, api);
      await entered.promise;
      assert.equal(validateSnapshot(f.context).reservations, 1);
      assert.ok(f.repository.month(f.month).reservedMicrorub > 0);
      if (change === 'grant OFF')
        api.admin.setMember(
          f.admin.accountId,
          command({
            organizationId: beforeSession.organizationId,
            accountId: beforeSession.accountId,
            enabled: false,
          }),
        );
      if (change === 'global revision')
        api.admin.settings(
          f.admin.accountId,
          command({ policy: { limits: { maxTextChars: 1800 } } }),
        );
      if (change === 'logout') f.store.logout(f.ownerSession.token);
      if (change === 'session expiry')
        f.context.db
          .prepare('UPDATE platform_sessions SET expires_at=? WHERE id=?')
          .run(Date.now() - 1, beforeSession.sessionId);
      if (change === 'session account switch')
        f.context.db
          .prepare('UPDATE platform_sessions SET account_id=?,organization_id=? WHERE id=?')
          .run(f.other.accountId, f.other.organizationId, beforeSession.sessionId);
      release.resolve();
      await pending.finished;
      assert.equal(pending.res.status, expected);
      if (expected === 428) assert.equal(pending.res.body.code, 'AUTH_CONTEXT_CHANGED');
      assert.equal(provider, 0);
      assert.equal(validateSnapshot(f.context).reservations, 0);
      assert.equal(f.repository.month(f.month).spentMicrorub, 0);
      assert.equal(f.repository.month(f.month).reservedMicrorub, 0);
      assert.equal(f.repository.month(f.month).uncertainCalls, 0);
      assert.equal(f.repository.day(f.date, f.membershipId), 1);
      assert.deepEqual(
        f.context.db.prepare('SELECT value FROM accounts WHERE id=?').get(f.other.accountId).value,
        otherBefore,
      );
      assert.equal(f.context.db.prepare('SELECT count(*) n FROM billing_reservations').get().n, 0);
      assert.equal(getEventListeners(pending.req, 'aborted').length, 0);
      assert.equal(getEventListeners(pending.res, 'close').length, 0);
      assert.doesNotMatch(
        JSON.stringify(pending.res.body),
        /synthetic-timeweb-key|provider_quote|credentials|@admin.test/,
      );
    },
  );
