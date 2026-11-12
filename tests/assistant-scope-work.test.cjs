const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { createAssistantPolicy } = require('../src/server/modules/assistant/access/policy.cjs');
const { createSpeechOutput } = require('../src/server/modules/assistant/providers/timeweb/timeweb-speech-stream.cjs');

function fixture(role = 'owner') {
  const current = { organizationId: 'synthetic-org', accountId: 'synthetic-account', role };
  const row = { role, status: 'active', created_at: 123, account_status: 'active',
    organization_status: 'active', global_admin: 0 };
  const state = initialState();
  state.revision = 7;
  state.policy.mode = 'selected';
  const membershipId = createHash('sha256')
    .update(JSON.stringify([current.organizationId, current.accountId, row.created_at]))
    .digest('base64url');
  state.grants = [{ membershipId, organizationId: current.organizationId,
    accountId: current.accountId, limits: { dailyRequests: 7, maxAudioSeconds: 10 } }];
  const counters = { reads: 0, memberships: 0, prepares: 0, assertions: 0 };
  const f = { current, row, state, counters, rowExists: true, sessionCurrent: true };
  const store = { read() { counters.reads++; return structuredClone(state); } };
  const db = { prepare(sql) {
    assert.match(sql, /SELECT m\.role,m\.status,m\.created_at/);
    assert.match(sql, /JOIN accounts a/);
    assert.match(sql, /JOIN organizations o/);
    counters.prepares++;
    return { get(organizationId, accountId) {
      counters.memberships++;
      assert.equal(organizationId, current.organizationId);
      assert.equal(accountId, current.accountId);
      const snapshot = f.rowExists ? { ...row } : null;
      f.afterMembership?.();
      return snapshot;
    } };
  } };
  f.policy = createAssistantPolicy({ db, open() { assert.fail('No encrypted clinical read'); } }, store);
  f.check = () => f.policy.requireScope(current, 7);
  f.guard = () => {
    counters.assertions++;
    if (!f.sessionCurrent) throw Object.assign(new Error('Synthetic session is no longer current.'), { status: 403 });
    return f.check();
  };
  return f;
}
function rejected(status) { return (error) => error.status === status; }
function response() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  Object.assign(res, { headersSent: false, destroyed: false, writableFinished: false, chunks: [],
    writeHead(status, headers) { this.headersSent = true; this.status = status; this.headers = headers; this.onHeaders?.(); },
    write(bytes) { this.chunks.push(Buffer.from(bytes)); return true; },
    end() { this.writableFinished = true; },
  });
  return { req, res };
}

test('constructing assistant policy performs no state, identity or provider work', () => {
  const f = fixture();
  assert.deepEqual(f.counters, { reads: 0, memberships: 0, prepares: 0, assertions: 0 });
});

test('one requireScope evaluation uses one JOIN and returns the same allowed member', async (t) => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) await t.test(role, () => {
    const f = fixture(role);
    const result = f.check();
    assert.equal(result.member.role, role);
    assert.equal(result.member.active, true);
    assert.equal(result.scope.enabled, true);
    assert.equal(result.scope.policyVersion, 7);
    assert.equal(result.state.policy.limits.dailyRequests, 7);
    assert.equal(result.state.policy.limits.maxAudioSeconds, 10);
    assert.equal(result.state.policy.limits.maxTextChars, f.state.policy.limits.maxTextChars);
    assert.deepEqual(result.scope.commands, f.state.policy.commands);
    assert.deepEqual(f.counters, { reads: 1, memberships: 1, prepares: 1, assertions: 0 });
  });
});

test('an explicit state snapshot is not reread and still uses one identity lookup', () => {
  const f = fixture();
  const result = f.policy.requireScope(f.current, 7, structuredClone(f.state));
  assert.equal(result.scope.enabled, true);
  assert.equal(f.counters.reads, 0);
  assert.equal(f.counters.memberships, 1);
});

test('the returned member is the member that passed this evaluation, with no second lookup', () => {
  const f = fixture();
  f.afterMembership = () => { f.row.status = 'suspended'; };
  const result = f.check();
  assert.equal(result.member.active, true);
  assert.equal(result.member.status, 'active');
  assert.equal(f.counters.memberships, 1);
  assert.throws(f.check, rejected(403));
  assert.equal(f.counters.memberships, 2);
  assert.equal(f.counters.reads, 2);
});

test('off, global administrator and anonymous access have no membership JOIN', async (t) => {
  const variants = [
    ['off', (f) => { f.state.policy.mode = 'off'; }, (f) => f.current],
    ['global administrator', () => {}, (f) => ({ ...f.current, globalAdmin: true })],
    ['anonymous', () => {}, () => null],
    ['no organization', () => {}, (f) => ({ ...f.current, organizationId: null })],
  ];
  for (const [name, change, actor] of variants) await t.test(name, () => {
    const f = fixture(); change(f);
    assert.equal(f.policy.access(actor(f)).enabled, false);
    assert.throws(() => f.policy.requireScope(actor(f), 7), rejected(403));
    assert.equal(f.counters.memberships, 0);
    assert.equal(f.counters.reads, 2);
  });
});

test('identity and grant denials remain fail closed', async (t) => {
  const variants = [
    ['missing membership', (f) => { f.rowExists = false; }],
    ['membership suspended', (f) => { f.row.status = 'suspended'; }],
    ['account suspended', (f) => { f.row.account_status = 'suspended'; }],
    ['organization suspended', (f) => { f.row.organization_status = 'suspended'; }],
    ['global account in membership', (f) => { f.row.global_admin = 1; }],
    ['role mismatch', (f) => { f.row.role = 'salon_admin'; }],
    ['grant absent', (f) => { f.state.grants = []; }],
  ];
  for (const [name, change] of variants) await t.test(name, () => {
    const f = fixture(); change(f);
    assert.throws(f.check, rejected(403));
    assert.equal(f.counters.reads, 1);
    assert.equal(f.counters.memberships, 1);
  });
});

test('revision validation keeps enabled-before-revision precedence', async (t) => {
  for (const revision of [6, 8, undefined]) await t.test(String(revision), () => {
    const f = fixture();
    assert.throws(() => f.policy.requireScope(f.current, revision), rejected(409));
    assert.equal(f.counters.memberships, 1);
    assert.equal(f.counters.reads, 1);
  });
  await t.test('disabled and stale revision is denied, not admitted as a refresh', () => {
    const f = fixture(); f.state.policy.mode = 'off';
    assert.throws(() => f.policy.requireScope(f.current, 6), rejected(403));
    assert.equal(f.counters.memberships, 0);
  });
});

test('every next evaluation sees ACL and policy changes without a cross-call cache', async (t) => {
  const variants = [
    ['grant revoked', (f) => { f.state.grants = []; }, 403, 2],
    ['membership revoked', (f) => { f.row.status = 'suspended'; }, 403, 2],
    ['account revoked', (f) => { f.row.account_status = 'suspended'; }, 403, 2],
    ['organization revoked', (f) => { f.row.organization_status = 'suspended'; }, 403, 2],
    ['role changed', (f) => { f.row.role = 'salon_admin'; }, 403, 2],
    ['actor role changed', (f) => { f.current.role = 'salon_admin'; }, 403, 2],
    ['actor account changed', (f) => { f.current.accountId = 'other-synthetic-account'; }, 403, 2],
    ['actor organization changed', (f) => { f.current.organizationId = 'other-synthetic-org'; }, 403, 2],
    ['membership recreated', (f) => { f.row.created_at++; }, 403, 2],
    ['policy changed', (f) => { f.state.revision++; }, 409, 2],
    ['policy disabled', (f) => { f.state.policy.mode = 'off'; }, 403, 1],
  ];
  for (const [name, change, status, joins] of variants) await t.test(name, () => {
    const f = fixture(); assert.equal(f.check().scope.enabled, true); change(f);
    assert.throws(f.check, rejected(status));
    assert.equal(f.counters.reads, 2);
    assert.equal(f.counters.memberships, joins);
  });
});

test('session assertion precedes policy work and no identity result survives session loss', () => {
  const f = fixture();
  assert.equal(f.guard().scope.enabled, true);
  f.sessionCurrent = false;
  assert.throws(f.guard, rejected(403));
  assert.equal(f.counters.assertions, 2);
  assert.equal(f.counters.reads, 1);
  assert.equal(f.counters.memberships, 1);
});

test('stream checks immediately before every write retain freshness with one JOIN each', async () => {
  const f = fixture(); const c = response();
  const output = createSpeechOutput(c, f.guard, 10000);
  try {
    await output.write(Buffer.from([1, 2]));
    await output.write(Buffer.from([3, 4]));
    assert.deepEqual(c.res.chunks, [Buffer.from([1, 2]), Buffer.from([3, 4])]);
    assert.equal(f.counters.assertions, 3);
    assert.equal(f.counters.reads, 3);
    assert.equal(f.counters.memberships, 3);
    assert.equal(c.res.headers['Cache-Control'], 'no-store');
  } finally { output.dispose(); }
});

test('a streamed response emits no additional bytes after scope revocation', async (t) => {
  const variants = [
    ['grant', (f) => { f.state.grants = []; }, 403],
    ['membership', (f) => { f.row.status = 'suspended'; }, 403],
    ['account', (f) => { f.row.account_status = 'suspended'; }, 403],
    ['organization', (f) => { f.row.organization_status = 'suspended'; }, 403],
    ['role', (f) => { f.row.role = 'salon_admin'; }, 403],
    ['policy revision', (f) => { f.state.revision++; }, 409],
    ['policy off', (f) => { f.state.policy.mode = 'off'; }, 403],
    ['session', (f) => { f.sessionCurrent = false; }, 403],
  ];
  for (const [name, change, status] of variants) await t.test(name, async () => {
    const f = fixture(); const c = response(); const output = createSpeechOutput(c, f.guard, 10000);
    try {
      await output.write(Buffer.from([1, 2]));
      change(f);
      await assert.rejects(output.write(Buffer.from([3, 4])), rejected(status));
      assert.deepEqual(c.res.chunks, [Buffer.from([1, 2])]);
      assert.equal(f.counters.assertions, 3);
      assert.equal(f.counters.reads, name === 'session' ? 2 : 3);
      assert.equal(f.counters.memberships, ['session', 'policy off'].includes(name) ? 2 : 3);
    } finally { output.dispose(); }
  });
});

test('revocation after headers but before the first byte is rejected by the second guard', async () => {
  const f = fixture(); const c = response();
  c.res.onHeaders = () => { f.state.grants = []; };
  const output = createSpeechOutput(c, f.guard, 10000);
  try {
    await assert.rejects(output.write(Buffer.from([1, 2])), rejected(403));
    assert.equal(c.res.headersSent, true);
    assert.deepEqual(c.res.chunks, []);
    assert.equal(f.counters.reads, 2);
    assert.equal(f.counters.memberships, 2);
  } finally { output.dispose(); }
});

test('transport abort stops stream before any further scope or identity work', async (t) => {
  for (const event of ['aborted', 'close']) await t.test(event, async () => {
    const f = fixture(); const c = response(); const output = createSpeechOutput(c, f.guard, 10000);
    try {
      await output.write(Buffer.from([1]));
      if (event === 'aborted') { c.req.aborted = true; c.req.emit('aborted'); }
      else { c.res.destroyed = true; c.res.emit('close'); }
      await assert.rejects(output.write(Buffer.from([2])), rejected(499));
      assert.deepEqual(c.res.chunks, [Buffer.from([1])]);
      assert.equal(f.counters.reads, 2);
      assert.equal(f.counters.memberships, 2);
    } finally { output.dispose(); }
  });
});

test('repeated checks stay linear and restored access is not held in a denial cache', () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) assert.equal(f.check().scope.enabled, true);
  assert.equal(f.counters.reads, 20);
  assert.equal(f.counters.memberships, 20);
  const grant = f.state.grants[0];
  f.state.grants = [];
  assert.throws(f.check, rejected(403));
  f.state.grants = [grant];
  assert.equal(f.check().scope.enabled, true);
  assert.equal(f.counters.reads, 22);
  assert.equal(f.counters.memberships, 22);
});
