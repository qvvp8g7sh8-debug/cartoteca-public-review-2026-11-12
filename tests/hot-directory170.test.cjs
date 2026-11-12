const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareHotDirectory170,
} = require('../src/server/infrastructure/postgres/hot-directory170.cjs');
const {
  fullDirectoryKey170,
} = require('../src/server/infrastructure/postgres/directory-key170.cjs');
const ids = Array.from(
  { length: 7 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);
const [accountId, organizationId, sessionId, storeId, epoch, platformStoreId, other] = ids;
const initial = Date.UTC(2026, 9, 29);
function fixture170() {
  let now = initial,
    bodyReads = 0,
    hinted = true,
    present = true;
  const calls = [],
    account = { email: 'synthetic@example.invalid', displayName: 'Synthetic' },
    session = {};
  const row = {
    fence_locked: true,
    id: sessionId,
    account_id: accountId,
    organization_id: organizationId,
    expires_at: initial + 60000,
    global_admin: 0,
    account_status: 'active',
    membership_role: 'owner',
    membership_status: 'active',
    organization_status: 'active',
    account_value: Buffer.from('account'),
    session_value: Buffer.from('session'),
  };
  const input = {
    url: new URL('http://native.invalid/api/cabinet/directory?q=synthetic&today=2026-10-29'),
    token: 'synthetic170-cookie',
    headers: { 'x-cartoteca-account-id': accountId, 'x-cartoteca-organization-id': organizationId },
    epoch,
    assertActive() {},
    config: { dataDir: 'C:/synthetic170' },
  };
  const oldKey = fullDirectoryKey170({
    epoch,
    storeId,
    current: { accountId, organizationId, sessionId, role: 'owner' },
    url: input.url,
  });
  const json = '{"patients":[{"name":"Ёж 🦔"}],"nextCursor":null}';
  const metadata = {
    eligible: true,
    authorityRows: [row],
    versions: 'proof170',
    scope: { kind: 'cabinet', storeId, organizationId },
  };
  const decode = (value) => (value.toString() === 'account' ? account : session);
  input.engine = {
    marker: {
      platformStoreId,
      stores: [
        {
          kind: 'cabinet',
          organizationId,
          storeId,
          relativeDirectory: 'tenants/' + organizationId,
        },
      ],
    },
    async hotMetadata169() {
      calls.push('SQL');
      return metadata;
    },
  };
  input.keyCache = {
    async forPlatform() {
      calls.push('P');
      return { decode };
    },
    async forOperation() {
      calls.push('PC');
      return { platform: { decode }, cabinet: {} };
    },
  };
  input.cache = {
    hasClaim170() {
      calls.push('hint');
      return hinted;
    },
    get(key, stamp) {
      calls.push('get');
      if (!present || key !== oldKey || stamp !== 'proof170') return null;
      return {
        get json() {
          bodyReads++;
          return json;
        },
      };
    },
  };
  const context = {
    contextMatches(current) {
      calls.push('context');
      if (
        current.accountId !== input.headers['x-cartoteca-account-id'] ||
        current.organizationId !== input.headers['x-cartoteca-organization-id']
      )
        throw Object.assign(Error('context'), { status: 428, code: 'AUTH_CONTEXT_CHANGED' });
    },
    runtime() {
      calls.push('runtime');
      return { timestamp: now };
    },
    respondSerialized(runtime, value) {
      calls.push('serialized');
      return { runtime, value };
    },
  };
  return {
    input,
    row,
    metadata,
    account,
    session,
    calls,
    context,
    json,
    bodyReads: () => bodyReads,
    clock: () => now,
    advance: (n) => {
      now += n;
    },
    evict: () => {
      present = false;
    },
    noHint: () => {
      hinted = false;
    },
  };
}
test('170 directory body is available only after current authority, assets and source proof', async (t) => {
  const cases = [
    [
      'matching fresh identity and stamp return exact immutable JSON without parsing it',
      async (f) => {
        const finish = await prepareHotDirectory170(f.input);
        assert.deepEqual(f.calls, ['hint', 'SQL', 'PC']);
        assert.equal(f.bodyReads(), 0);
        const parse = JSON.parse;
        JSON.parse = () => {
          throw Error('Cached clinical body must not be parsed');
        };
        try {
          assert.equal(finish(f.context).value, f.json);
        } finally {
          JSON.parse = parse;
        }
        assert.equal(f.bodyReads(), 1);
        assert.deepEqual(f.calls.slice(3), ['context', 'runtime', 'get', 'serialized']);
      },
    ],
    [
      'no candidate performs no SQL or key work',
      async (f) => {
        f.noHint();
        assert.equal(await prepareHotDirectory170(f.input), null);
        assert.deepEqual(f.calls, ['hint']);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'eviction during asset await causes cold miss without captured body',
      async (f) => {
        const original = f.input.keyCache.forOperation;
        f.input.keyCache.forOperation = async () => {
          const value = await original();
          f.evict();
          return value;
        };
        assert.equal((await prepareHotDirectory170(f.input))(f.context), null);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'source stamp change declines body',
      async (f) => {
        f.metadata.versions = 'changed170';
        assert.equal((await prepareHotDirectory170(f.input))(f.context), null);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'role change uses actual full binding and declines old body',
      async (f) => {
        f.row.membership_role = 'salon_admin';
        assert.equal((await prepareHotDirectory170(f.input))(f.context), null);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'session identity rotation declines old body',
      async (f) => {
        f.row.id = other;
        assert.equal((await prepareHotDirectory170(f.input))(f.context), null);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'expiry during final awaited assets denies before body lookup',
      async (f) => {
        const original = f.input.keyCache.forOperation;
        f.input.keyCache.forOperation = async () => {
          const value = await original();
          f.advance(60001);
          return value;
        };
        const finish = await prepareHotDirectory170(f.input);
        assert.throws(() => finish(f.context), { status: 401 });
        assert.equal(f.calls.includes('get'), false);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'revoked membership denies using only fresh platform assets',
      async (f) => {
        f.row.membership_status = 'inactive';
        f.metadata.eligible = false;
        const finish = await prepareHotDirectory170(f.input);
        assert.throws(() => finish(f.context), { status: 401 });
        assert.equal(f.calls.includes('PC'), false);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'misleading wrong-tab hint cannot grant or open foreign cabinet',
      async (f) => {
        f.input.headers['x-cartoteca-organization-id'] = other;
        f.metadata.eligible = false;
        const finish = await prepareHotDirectory170(f.input);
        assert.throws(() => finish(f.context), { status: 428 });
        assert.equal(f.calls.includes('PC'), false);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'global admin MFA failure retains401 before body',
      async (f) => {
        f.row.global_admin = 1;
        f.metadata.eligible = false;
        f.account.adminMfa = { enabled: true, revision: 2 };
        f.session.adminMfaRevision = 1;
        const finish = await prepareHotDirectory170(f.input);
        assert.throws(() => finish(f.context), { status: 401 });
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'current global admin is denied403',
      async (f) => {
        f.row.global_admin = 1;
        f.metadata.eligible = false;
        assert.throws((await prepareHotDirectory170(f.input)).bind(null, f.context), {
          status: 403,
        });
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'SQL failure propagates once without replay or body',
      async (f) => {
        let submitted = 0;
        f.input.engine.hotMetadata169 = async () => {
          submitted++;
          throw Object.assign(Error('SQL'), { code: 'XX000' });
        };
        await assert.rejects(prepareHotDirectory170(f.input), { code: 'XX000' });
        assert.equal(submitted, 1);
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'fresh key identity error denies body',
      async (f) => {
        f.input.keyCache.forOperation = async () => {
          throw Object.assign(Error('asset'), { status: 503 });
        };
        await assert.rejects(prepareHotDirectory170(f.input), { status: 503 });
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'cancellation after SQL and assets denies before body',
      async (f) => {
        let cancelled = false;
        f.input.assertActive = () => {
          if (cancelled) throw Object.assign(Error('cancel'), { status: 499 });
        };
        const finish = await prepareHotDirectory170(f.input);
        cancelled = true;
        assert.throws(() => finish(f.context), { status: 499 });
        assert.equal(f.bodyReads(), 0);
      },
    ],
    [
      'unsupported large authority explicitly keeps cold path',
      async (f) => {
        f.input.engine.hotMetadata169 = async () => ({
          authorityRows: null,
          unsupported: 'authority-size',
        });
        assert.equal(await prepareHotDirectory170(f.input), null);
        assert.equal(f.bodyReads(), 0);
      },
    ],
  ];
  for (const [name, run] of cases)
    await t.test(name, async (st) => {
      const f = fixture170();
      st.mock.method(Date, 'now', f.clock);
      await run(f);
    });
});
