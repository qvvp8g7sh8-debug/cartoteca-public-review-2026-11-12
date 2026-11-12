const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const {
  hotCalendarCandidate169,
  prepareHotCalendar169,
} = require('../src/server/infrastructure/postgres/hot-calendar169.cjs');
const { calendarToken163 } = require('../src/server/infrastructure/postgres/calendar-token163.cjs');
const { authorityValue } = require('../src/server/infrastructure/postgres/read-session152.cjs');
const ids = Array.from(
  { length: 5 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);
const [accountId, organizationId, sessionId, storeId, otherOrg] = ids;
const runtime = {
  timestamp: 1,
  telegram: { configured: false, connected: false, botId: '' },
  providers: {
    telegram: { configured: false, connected: false, botId: '' },
    max: { configured: false, connected: false, botId: '' },
  },
};
const hash = (value) =>
  createHmac('sha256', 'synthetic-calendar-key169').update(value).digest('hex');
const initial = Date.UTC(2026, 9, 29, 0, 0);

function fixture169() {
  let now = initial;
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
  const decode = (input) => (input.toString() === 'account' ? account : session);
  const current = authorityValue([{ ...row }], decode).current;
  const url = new URL(
    'http://native.invalid/api/cabinet/calendar?compact=1&from=2026-10-29&to=2026-10-29&projection=details&monthFrom=2026-10-01&monthTo=2026-10-31',
  );
  const metadata = {
    eligible: true,
    authorityRows: [row],
    versions: 'synthetic-source-proof169',
    scope: { kind: 'cabinet', storeId, organizationId },
  };
  const version = calendarToken163({
    current,
    url,
    hash,
    versions: metadata.versions,
    runtime: [runtime.telegram, runtime.providers.telegram, runtime.providers.max],
    renderConfig: [false, null],
  }).sign(91, initial + 30000);
  url.searchParams.set('version', version);
  url.searchParams.set('until', String(initial + 30000));
  const headers = {
    'x-cartoteca-account-id': accountId,
    'x-cartoteca-organization-id': organizationId,
  };
  const input = {
    url,
    headers,
    token: 'synthetic-cookie169',
    assertActive() {},
    config: { dataDir: 'C:/synthetic169' },
    engine: {
      marker: {
        stores: [
          {
            kind: 'cabinet',
            organizationId,
            storeId,
            relativeDirectory: 'tenants/' + organizationId,
          },
        ],
      },
      async hotMetadata169(value) {
        calls.push(['sql', value]);
        return metadata;
      },
    },
    keyCache: {
      async forPlatform() {
        calls.push(['P']);
        return { decode };
      },
      async forOperation() {
        calls.push(['PC']);
        return { platform: { decode }, cabinet: { hash } };
      },
    },
  };
  const finishContext = {
    contextMatches(value) {
      if (
        value.accountId !== headers['x-cartoteca-account-id'] ||
        value.organizationId !== headers['x-cartoteca-organization-id']
      )
        throw Object.assign(Error('context'), { status: 428, code: 'AUTH_CONTEXT_CHANGED' });
    },
    runtime: () => runtime,
    respond: (observed, value) => ({ observed, value }),
  };
  return {
    input,
    calls,
    row,
    account,
    session,
    metadata,
    finishContext,
    clock: () => now,
    advance: (n) => {
      now += n;
    },
  };
}

test('169 hot calendar preserves fresh authorization and existing163 token semantics', async (t) => {
  const cases = [
    [
      'acknowledged token accepts unchanged after metadata SQL and fresh P+C',
      async (f) => {
        const finish = await prepareHotCalendar169(f.input);
        assert.deepEqual(
          f.calls.map((x) => x[0]),
          ['sql', 'PC'],
        );
        assert.deepEqual(finish(f.finishContext).value, { revision: 91, unchanged: true });
        assert.equal(f.calls.filter((x) => x[0] === 'sql').length, 1);
      },
    ],
    [
      'source change declines old token',
      async (f) => {
        f.metadata.versions = 'different-source-proof169';
        assert.equal((await prepareHotCalendar169(f.input))(f.finishContext), null);
      },
    ],
    [
      'query change declines old token',
      async (f) => {
        f.input.url.searchParams.set('from', '2026-10-30');
        f.input.url.searchParams.set('to', '2026-10-30');
        assert.equal((await prepareHotCalendar169(f.input))(f.finishContext), null);
      },
    ],
    [
      'expiry during awaited assets denies at final gate',
      async (f) => {
        const original = f.input.keyCache.forOperation;
        f.input.keyCache.forOperation = async (...args) => {
          const value = await original(...args);
          f.advance(60001);
          return value;
        };
        const finish = await prepareHotCalendar169(f.input);
        assert.throws(() => finish(f.finishContext), { status: 401 });
      },
    ],
    [
      'different tab gets428 without opening the claimed cabinet key',
      async (f) => {
        f.input.headers['x-cartoteca-organization-id'] = otherOrg;
        f.metadata.eligible = false;
        const finish = await prepareHotCalendar169(f.input);
        assert.deepEqual(
          f.calls.map((x) => x[0]),
          ['sql', 'P'],
        );
        assert.throws(() => finish(f.finishContext), { status: 428, code: 'AUTH_CONTEXT_CHANGED' });
      },
    ],
    [
      'revoked membership denies without cabinet key',
      async (f) => {
        f.row.membership_status = 'revoked';
        f.metadata.eligible = false;
        const finish = await prepareHotCalendar169(f.input);
        assert.deepEqual(
          f.calls.map((x) => x[0]),
          ['sql', 'P'],
        );
        assert.throws(() => finish(f.finishContext), { status: 401 });
      },
    ],
    [
      'global admin MFA revision mismatch keeps401 precedence',
      async (f) => {
        f.row.global_admin = 1;
        f.metadata.eligible = false;
        f.account.adminMfa = { enabled: true, revision: 2 };
        f.session.adminMfaRevision = 1;
        const finish = await prepareHotCalendar169(f.input);
        assert.throws(() => finish(f.finishContext), { status: 401 });
        assert.equal(
          f.calls.some((x) => x[0] === 'PC'),
          false,
        );
      },
    ],
    [
      'global admin with current MFA gets403',
      async (f) => {
        f.row.global_admin = 1;
        f.metadata.eligible = false;
        f.account.adminMfa = { enabled: true, revision: 2 };
        f.session.adminMfaRevision = 2;
        assert.throws((await prepareHotCalendar169(f.input)).bind(null, f.finishContext), {
          status: 403,
        });
      },
    ],
    [
      'missing session gets401 using only fresh platform assets',
      async (f) => {
        f.metadata.authorityRows = [{ fence_locked: true, id: null }];
        f.metadata.eligible = false;
        const finish = await prepareHotCalendar169(f.input);
        assert.throws(() => finish(f.finishContext), { status: 401 });
        assert.equal(
          f.calls.some((x) => x[0] === 'PC'),
          false,
        );
      },
    ],
    [
      'large authority or unprepared component explicitly keeps cold path',
      async (f) => {
        f.input.engine.hotMetadata169 = async () => ({
          unsupported: 'authority-size',
          authorityRows: null,
        });
        assert.equal(await prepareHotCalendar169(f.input), null);
      },
    ],
    [
      'SQL error is propagated without retry or finalizer',
      async (f) => {
        let submitted = 0;
        f.input.engine.hotMetadata169 = async () => {
          submitted++;
          throw Object.assign(Error('sql'), { code: 'XX000' });
        };
        await assert.rejects(prepareHotCalendar169(f.input), { code: 'XX000' });
        assert.equal(submitted, 1);
        assert.equal(
          f.calls.some((x) => x[0] === 'PC'),
          false,
        );
      },
    ],
    [
      'key identity failure after SQL cannot return unchanged',
      async (f) => {
        f.input.keyCache.forOperation = async () => {
          throw Object.assign(Error('asset'), { status: 503 });
        };
        await assert.rejects(prepareHotCalendar169(f.input), { status: 503 });
      },
    ],
    [
      'cancellation before final gate cannot return unchanged',
      async (f) => {
        let cancelled = false;
        f.input.assertActive = () => {
          if (cancelled) throw Object.assign(Error('cancel'), { status: 499 });
        };
        const finish = await prepareHotCalendar169(f.input);
        cancelled = true;
        assert.throws(() => finish(f.finishContext), { status: 499 });
      },
    ],
    [
      'noncandidate performs no IO',
      async (f) => {
        f.input.url.searchParams.delete('version');
        assert.equal(hotCalendarCandidate169(f.input.url, f.input.headers), false);
        assert.equal(await prepareHotCalendar169(f.input), null);
        assert.deepEqual(f.calls, []);
      },
    ],
  ];
  for (const [name, callback] of cases)
    await t.test(name, async () => {
      t.mock.method(Date, 'now', () => initial);
      const f = fixture169();
      t.mock.method(Date, 'now', f.clock);
      try {
        await callback(f);
      } finally {
        t.mock.restoreAll();
      }
    });
});
