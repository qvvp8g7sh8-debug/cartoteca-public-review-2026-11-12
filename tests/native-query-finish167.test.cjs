const test = require('node:test'),
  assert = require('node:assert/strict');
// Only the unused legacy platform factory is replaced. The actual native kernel
// and its fresh-authority/context checks run unchanged, with no files or sockets.
const platformPath = require.resolve('../src/server/infrastructure/native-query-platform.cjs');
const previousPlatform = require.cache[platformPath];
require.cache[platformPath] = {
  id: platformPath,
  filename: platformPath,
  loaded: true,
  exports: { createNativeQueryPlatform: () => ({ close() {} }) },
};
let createNativeQueryKernel;
try {
  ({ createNativeQueryKernel } = require('../src/server/infrastructure/native-query-kernel.cjs'));
} finally {
  if (previousPlatform) require.cache[platformPath] = previousPlatform;
  else delete require.cache[platformPath];
}
test('167 private finish validates current authority per job and missing callback keeps ordinary postauth', async () => {
  const actor = {
    accountId: 'synthetic-account',
    organizationId: 'synthetic-organization',
    token: 'synthetic-private-token',
  };
  const current = {
    ...actor,
    sessionId: 'synthetic-session',
    role: 'owner',
    globalAdmin: false,
    expiresAt: Date.now() + 60000,
  };
  let authorizations = 0,
    mode = 'legacy',
    runs = 0;
  const authority = () => ({ supported: true, current: { ...current } });
  const operations = {
    async authorize() {
      authorizations++;
      return authority();
    },
    sqlCalls: () => 0,
    async close() {},
    async run(context) {
      runs++;
      const result = context.json(context.res, 200, { synthetic: 'owned' });
      if (mode === 'accept') await context.assertFreshAfterCommit167(authority());
      if (mode === 'denied')
        await context.assertFreshAfterCommit167({ supported: true, current: null });
      if (mode === 'role')
        await context.assertFreshAfterCommit167({
          supported: true,
          current: { ...authority().current, role: 'cosmetologist' },
        });
      return result;
    },
  };
  const kernel = createNativeQueryKernel(
    { origin: 'http://127.0.0.1:4174' },
    { readOperations: operations },
  );
  const metadata = () => ({
    method: 'GET',
    url: '/api/cabinet/directory',
    headers: {
      host: '127.0.0.1:4174',
      cookie: 'cartoteca_v2_session=' + actor.token,
      'x-cartoteca-account-id': actor.accountId,
      'x-cartoteca-organization-id': actor.organizationId,
    },
    runtime: {
      timestamp: Date.now(),
      telegram: { configured: false, connected: false, botId: '' },
      providers: {
        telegram: { configured: false, connected: false, botId: '' },
        max: { configured: false, connected: false, botId: '' },
      },
    },
  });
  const run = async () => {
    const reply = await kernel.run(metadata());
    return { status: reply.status, body: JSON.parse(Buffer.from(reply.body).toString()) };
  };
  try {
    let before = authorizations;
    assert.deepEqual(await run(), { status: 200, body: { synthetic: 'owned' } });
    assert.equal(
      authorizations - before,
      2,
      'fake borrowed.run without finish callback retains fresh postauth',
    );
    mode = 'accept';
    before = authorizations;
    assert.deepEqual(await run(), { status: 200, body: { synthetic: 'owned' } });
    assert.equal(
      authorizations - before,
      1,
      'only accepted same-job callback suppresses the redundant SQL call',
    );
    mode = 'denied';
    assert.equal((await run()).status, 401);
    mode = 'role';
    assert.equal((await run()).status, 403);
    mode = 'legacy';
    before = authorizations;
    assert.equal((await run()).status, 200);
    assert.equal(authorizations - before, 2, 'finalized flag never escapes its job');
    const bad = metadata();
    bad.headers['x-cartoteca-organization-id'] = 'other';
    const prior = runs;
    assert.equal((await kernel.run(bad)).status, 428);
    assert.equal(runs, prior);
  } finally {
    await kernel.close();
  }
});
