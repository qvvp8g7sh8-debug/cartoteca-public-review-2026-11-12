const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const {
  prepareHotDirectory170,
} = require('../src/server/infrastructure/postgres/hot-directory170.cjs');
const {
  prepareHotCalendar169,
} = require('../src/server/infrastructure/postgres/hot-calendar169.cjs');
const { calendarToken163 } = require('../src/server/infrastructure/postgres/calendar-token163.cjs');
const initial = Date.UTC(2026, 9, 29);
const ids = Array.from(
  { length: 6 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);
const [accountId, organizationId, sessionId, storeId, epoch, platformStoreId] = ids;
const runtime = {
  timestamp: initial,
  telegram: { configured: false, connected: false, botId: '' },
  providers: {
    telegram: { configured: false, connected: false, botId: '' },
    max: { configured: false, connected: false, botId: '' },
  },
};
function fixture171() {
  let now = initial,
    hint = false,
    cached = false;
  const calls = [],
    accepted = [],
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
    url: new URL('http://native.invalid/api/cabinet/directory?q=Synthetic&today=2026-10-29'),
    headers: { 'x-cartoteca-account-id': accountId, 'x-cartoteca-organization-id': organizationId },
    token: 'synthetic171-cookie',
    epoch,
    assertActive() {},
    config: { dataDir: 'C:/synthetic171' },
  };
  const metadata = {
    eligible: true,
    authorityRows: [row],
    versions: 'new171',
    scope: { kind: 'cabinet', storeId, organizationId },
  };
  const decode = (v) => (v.toString() === 'account' ? account : session);
  const hash = (v) => createHmac('sha256', 'synthetic171-key').update(v).digest('hex');
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
      return { platform: { decode }, cabinet: { hash } };
    },
  };
  input.cache = {
    hasClaim170: () => true,
    hasStamp171() {
      calls.push('hint');
      return hint;
    },
    get() {
      calls.push('BODY');
      return cached ? { json: '{"directory":[]}' } : null;
    },
  };
  const context = {
    contextMatches: () => calls.push('context'),
    runtime: () => runtime,
    respondSerialized: (_, json) => ({ json }),
    respond: (_, value) => ({ value }),
    acceptColdAuthority171(current) {
      calls.push('accept');
      accepted.push(current);
    },
  };
  return {
    input,
    row,
    metadata,
    context,
    calls,
    accepted,
    account,
    session,
    hash,
    clock: () => now,
    advance: () => {
      now += 60001;
    },
    hint: (v) => {
      hint = v;
    },
    cached: (v) => {
      cached = v;
    },
  };
}
test('171 planned misses hand fresh current to the same job without a clinical source proof', async (t) => {
  const cases = [
    [
      'false stamp hint avoids C assets and never upgrades to a later body',
      async (f) => {
        const p = f.input.keyCache.forPlatform;
        let checked = 0;
        f.input.keyCache.forPlatform = async () => {
          const crypto = await p();
          if (++checked === 1) f.cached(true);
          return crypto;
        };
        const finish = await prepareHotDirectory170(f.input);
        assert.deepEqual(f.calls, ['SQL', 'hint', 'P']);
        assert.equal(finish(f.context), null);
        assert.equal(f.calls.includes('PC'), false);
        assert.equal(f.calls.includes('BODY'), false);
        assert.equal(f.accepted.length, 1);
        assert.equal(f.accepted[0].sessionId, sessionId);
        assert.equal(Object.hasOwn(f.accepted[0], 'versions'), false);
        assert.equal(Object.hasOwn(f.accepted[0], 'metadata'), false);
      },
    ],
    [
      'true hint evicted during assets keeps fresh C checks then hands off current',
      async (f) => {
        f.hint(true);
        const finish = await prepareHotDirectory170(f.input);
        assert.equal(finish(f.context), null);
        assert.equal(f.accepted.length, 1);
        assert.deepEqual(f.calls, ['SQL', 'hint', 'PC', 'context', 'BODY', 'accept']);
      },
    ],
    [
      'accepted hot response has no cold authority handoff',
      async (f) => {
        f.hint(true);
        f.cached(true);
        assert.deepEqual((await prepareHotDirectory170(f.input))(f.context), {
          json: '{"directory":[]}',
        });
        assert.equal(f.accepted.length, 0);
      },
    ],
    [
      'source-version calendar token miss hands off only fresh current',
      async (f) => {
        f.input.url = new URL(
          'http://native.invalid/api/cabinet/calendar?from=2026-10-29&to=2026-10-29&compact=1&monthFrom=2026-10-01&monthTo=2026-10-31&projection=details',
        );
        const current = { accountId, organizationId, sessionId, role: 'owner' };
        const producer = calendarToken163({
          current,
          url: f.input.url,
          hash: f.hash,
          versions: 'old171',
          runtime: [runtime.telegram, runtime.providers.telegram, runtime.providers.max],
          renderConfig: [false, null],
        });
        f.input.url.searchParams.set('version', producer.sign(4, initial + 30000));
        f.input.url.searchParams.set('until', String(initial + 30000));
        const finish = await prepareHotCalendar169(f.input);
        assert.equal(finish(f.context), null);
        assert.equal(f.accepted.length, 1);
        assert.equal(f.accepted[0].expiresAt, initial + 60000);
        assert.equal(f.calls.includes('PC'), true);
      },
    ],
    [
      'expiry during final P await cannot hand off current',
      async (f) => {
        let checked = 0;
        const p = f.input.keyCache.forPlatform;
        f.input.keyCache.forPlatform = async () => {
          const crypto = await p();
          if (++checked === 1) f.advance();
          return crypto;
        };
        const finish = await prepareHotDirectory170(f.input);
        assert.throws(() => finish(f.context), { status: 401 });
        assert.equal(f.accepted.length, 0);
      },
    ],
    [
      'revoked membership never hands off',
      async (f) => {
        f.row.membership_status = 'inactive';
        assert.throws((await prepareHotDirectory170(f.input)).bind(null, f.context), {
          status: 401,
        });
        assert.equal(f.accepted.length, 0);
      },
    ],
    [
      'unsupported current role keeps old authorization path',
      async (f) => {
        f.row.membership_role = 'unsupported';
        assert.equal((await prepareHotDirectory170(f.input))(f.context), null);
        assert.equal(f.accepted.length, 0);
      },
    ],
    [
      'metadata-ineligible generation keeps old authorization path',
      async (f) => {
        f.metadata.eligible = false;
        assert.equal((await prepareHotDirectory170(f.input))(f.context), null);
        assert.equal(f.accepted.length, 0);
      },
    ],
    [
      'key failures never become a planned miss',
      async (f) => {
        f.input.keyCache.forPlatform = async () => {
          throw Object.assign(Error('asset'), { status: 503 });
        };
        await assert.rejects(prepareHotDirectory170(f.input), { status: 503 });
        assert.equal(f.accepted.length, 0);
      },
    ],
  ];
  for (const [name, run] of cases)
    await t.test(name, async (st) => {
      const f = fixture171();
      st.mock.method(Date, 'now', f.clock);
      await run(f);
    });
});
