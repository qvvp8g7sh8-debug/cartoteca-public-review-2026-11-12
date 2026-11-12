const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const {
  createOperationCryptoCache,
} = require('../src/server/infrastructure/postgres/read-operation-crypto145.cjs');
const {
  prepareHotCalendar169,
} = require('../src/server/infrastructure/postgres/hot-calendar169.cjs');
const {
  prepareHotDirectory170,
} = require('../src/server/infrastructure/postgres/hot-directory170.cjs');
const { calendarToken163 } = require('../src/server/infrastructure/postgres/calendar-token163.cjs');

async function fixture(t, family) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cartoteca-hot-assets191-'));
  const [platformStoreId, storeId, organizationId, accountId, sessionId, epoch] = Array.from(
    { length: 6 },
    () => randomUUID(),
  );
  const directory = path.join(root, 'tenants', organizationId);
  const rootCabinetStoreId = randomUUID();
  const marker = {
    version: 1,
    backend: 'postgres',
    migrationId: randomUUID(),
    platformStoreId,
    rootCabinetStoreId,
    budgetStoreId: null,
    notificationSchema: 19,
    cabinetSchema: 1,
    cabinetTemplates: { 1: 'a'.repeat(64), 2: 'b'.repeat(64) },
    stores: [
      {
        kind: 'platform',
        storeId: platformStoreId,
        organizationId: null,
        relativeDirectory: 'platform',
        schemaVersion: 19,
      },
      {
        kind: 'cabinet',
        storeId: rootCabinetStoreId,
        organizationId: null,
        relativeDirectory: '.',
        schemaVersion: 1,
      },
      {
        kind: 'cabinet',
        storeId,
        organizationId,
        relativeDirectory: 'tenants/' + organizationId,
        schemaVersion: 1,
      },
    ],
  };
  await fs.promises.mkdir(path.join(root, 'platform'));
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(root, 'postgresql-runtime.json'), JSON.stringify(marker));
  const platformKey = path.join(root, 'platform/platform.key');
  await fs.promises.writeFile(platformKey, randomBytes(32));
  await fs.promises.writeFile(path.join(directory, 'encryption.key'), randomBytes(32));
  let cache;
  t.after(async () => {
    cache?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-hot-assets191-'));
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  cache = await createOperationCryptoCache(root, marker, { maximumEntries: 4 });
  const crypto = await cache.forOperation(directory, () => {});
  const now = Date.now(),
    current = { accountId, organizationId, sessionId, role: 'owner' },
    runtime = {
      timestamp: now,
      telegram: { configured: false, connected: false, botId: '' },
      providers: {
        telegram: { configured: false, connected: false, botId: '' },
        max: { configured: false, connected: false, botId: '' },
      },
    };
  const metadata = {
    eligible: true,
    versions: 'synthetic-source191',
    scope: { kind: 'cabinet', storeId, organizationId },
    authorityRows: [
      {
        fence_locked: true,
        id: sessionId,
        account_id: accountId,
        organization_id: organizationId,
        expires_at: now + 3600000,
        global_admin: 0,
        account_status: 'active',
        membership_role: 'owner',
        membership_status: 'active',
        organization_status: 'active',
        account_value: crypto.platform.encode({
          email: 'synthetic@example.invalid',
          displayName: 'Synthetic191',
        }),
        session_value: crypto.platform.encode({}),
      },
    ],
  };
  const url = new URL(
    family === 'calendar'
      ? 'http://native.invalid/api/cabinet/calendar?compact=1&from=2035-01-01&to=2035-01-01&projection=details&monthFrom=2035-01-01&monthTo=2035-01-31'
      : 'http://native.invalid/api/cabinet/directory?q=Synthetic&today=2035-01-01&limit=100',
  );
  if (family === 'calendar') {
    const until = now + 300000;
    url.searchParams.set(
      'version',
      calendarToken163({
        current,
        url,
        hash: crypto.cabinet.hash,
        versions: metadata.versions,
        runtime: [runtime.telegram, runtime.providers.telegram, runtime.providers.max],
        renderConfig: [false, null],
      }).sign(91, until),
    );
    url.searchParams.set('until', String(until));
  }
  const state = {
    sql: 0,
    platformCalls: 0,
    operationCalls: 0,
    decoded: 0,
    bodyReads: 0,
    responses: 0,
    cancelled: false,
    calls: [],
    metadataHook: null,
  };
  const check = () => {
    if (state.cancelled) throw Object.assign(Error('Synthetic191 cancelled'), { status: 499 });
  };
  const wrap = (value) => ({
    ...value,
    decode(input) {
      state.decoded++;
      return value.decode(input);
    },
  });
  const input = {
    url,
    token: 'synthetic191-cookie',
    headers: { 'x-cartoteca-account-id': accountId, 'x-cartoteca-organization-id': organizationId },
    epoch,
    assertActive: check,
    config: { dataDir: root },
    engine: {
      marker,
      async hotMetadata169(_value, assertActive) {
        assertActive();
        state.sql++;
        state.calls.push('SQL');
        await state.metadataHook?.();
        assertActive();
        return metadata;
      },
    },
    keyCache: {
      async forPlatform(active) {
        state.platformCalls++;
        state.calls.push('P');
        return wrap(await cache.forPlatform(active));
      },
      async forOperation(target, active) {
        state.operationCalls++;
        state.calls.push('PC');
        const value = await cache.forOperation(target, active);
        return { platform: wrap(value.platform), cabinet: value.cabinet };
      },
    },
    cache: {
      hasClaim170: () => true,
      hasStamp171: () => true,
      get: () => ({
        get json() {
          state.bodyReads++;
          return '{"directory":[]}';
        },
      }),
    },
  };
  const context = {
    contextMatches(value) {
      assert.equal(value.accountId, accountId);
      assert.equal(value.organizationId, organizationId);
    },
    runtime: () => runtime,
    respond(_observed, value) {
      state.responses++;
      return value;
    },
    respondSerialized(_observed, value) {
      state.responses++;
      return value;
    },
  };
  return {
    input,
    state,
    context,
    cache,
    metadata,
    root,
    directory,
    platformKey,
    prepare: family === 'calendar' ? prepareHotCalendar169 : prepareHotDirectory170,
  };
}
test('191 hot calendar and directory use only fresh post-SQL P+C or P checks before decode/body', async (t) => {
  for (const family of ['calendar', 'directory']) {
    for (const mode of ['PC', 'P']) {
      const f = await fixture(t, family);
      if (mode === 'P') f.metadata.eligible = false;
      const real = fs.promises.lstat;
      const observedPaths = [];
      let beforeSql = 0;
      const mock = t.mock.method(fs.promises, 'lstat', async (...args) => {
        observedPaths.push(path.resolve(args[0]));
        if (!f.state.sql) beforeSql++;
        return real.apply(fs.promises, args);
      });
      try {
        const finish = await f.prepare(f.input);
        assert.deepEqual(f.state.calls, ['SQL', mode]);
        assert.equal(beforeSql, 0);
        const requiredPaths = [
          path.join(f.root, 'postgresql-runtime.json'),
          f.root,
          path.join(f.root, 'platform'),
          f.platformKey,
          ...(mode === 'PC'
            ? [path.join(f.root, 'tenants'), f.directory, path.join(f.directory, 'encryption.key')]
            : []),
        ];
        assert.deepEqual(
          observedPaths.sort(),
          requiredPaths.sort(),
          'fresh post-SQL proof observes exactly every required marker/parent/key path once',
        );
        assert.equal(f.state.decoded, 0);
        assert.equal(f.state.bodyReads, 0);
        const result = finish(f.context);
        if (mode === 'PC') assert.ok(result);
        else assert.equal(result, null);
        assert.equal(f.state.responses, mode === 'PC' ? 1 : 0);
        assert.equal(
          f.state.decoded,
          1,
          'fresh SQL account is decoded only with post-SQL checked P key',
        );
        assert.equal(f.state.bodyReads, mode === 'PC' && family === 'directory' ? 1 : 0);
      } finally {
        mock.mock.restore();
      }
    }
  }
});
test('191 invalid P existing before metadata SQL still fails before authority decode or body', async (t) => {
  for (const family of ['calendar', 'directory']) {
    const f = await fixture(t, family);
    await fs.promises.unlink(f.platformKey);
    await assert.rejects(f.prepare(f.input), { status: 503, code: 'POSTGRES_READ_ASSETS_CHANGED' });
    assert.equal(f.state.sql, 1, 'metadata-only SQL is now allowed before P validation');
    assert.equal(f.state.decoded, 0);
    assert.equal(f.state.bodyReads, 0);
    assert.equal(f.state.responses, 0);
  }
});
test('191 P mutation during metadata await is caught by the unchanged post-SQL asset proof', async (t) => {
  for (const family of ['calendar', 'directory']) {
    const f = await fixture(t, family);
    f.state.metadataHook = () => fs.promises.writeFile(f.platformKey, randomBytes(32));
    await assert.rejects(f.prepare(f.input), { status: 503, code: 'POSTGRES_READ_ASSETS_CHANGED' });
    assert.equal(f.state.sql, 1);
    assert.deepEqual(f.state.calls, ['SQL', 'PC']);
    assert.equal(f.state.decoded + f.state.bodyReads + f.state.responses, 0);
  }
});
test('191 cancellation during metadata or after final assets cannot decode or return a body', async (t) => {
  for (const family of ['calendar', 'directory']) {
    for (const phase of ['metadata', 'final']) {
      const f = await fixture(t, family);
      if (phase === 'metadata') {
        f.state.metadataHook = () => {
          f.state.cancelled = true;
        };
        await assert.rejects(f.prepare(f.input), { status: 499 });
        assert.equal(f.state.operationCalls, 0);
      } else {
        const finish = await f.prepare(f.input);
        f.state.cancelled = true;
        assert.throws(() => finish(f.context), { status: 499 });
      }
      assert.equal(f.state.sql, 1);
      assert.equal(f.state.decoded + f.state.bodyReads + f.state.responses, 0);
    }
  }
});
test('191 unsupported metadata has no body; ordinary fallback validates P, and SQL errors never become fallback', async (t) => {
  for (const family of ['calendar', 'directory']) {
    for (const reason of ['unsupported', 'sql-error']) {
      const f = await fixture(t, family);
      await fs.promises.appendFile(path.join(f.root, 'postgresql-runtime.json'), '\n');
      if (reason === 'unsupported') {
        f.metadata.authorityRows = null;
        assert.equal(await f.prepare(f.input), null);
        assert.equal(f.state.platformCalls + f.state.operationCalls, 0);
        await assert.rejects(f.input.keyCache.forPlatform(f.input.assertActive), {
          status: 503,
          code: 'POSTGRES_READ_ASSETS_CHANGED',
        });
      } else {
        f.state.metadataHook = () => {
          throw Object.assign(Error('Synthetic191 SQL failure'), { code: 'XX000' });
        };
        await assert.rejects(f.prepare(f.input), { code: 'XX000' });
        assert.equal(
          f.state.platformCalls + f.state.operationCalls,
          0,
          'SQL error has precedence and is not retried',
        );
      }
      assert.equal(f.state.sql, 1);
      assert.equal(f.state.decoded + f.state.bodyReads + f.state.responses, 0);
    }
  }
});
