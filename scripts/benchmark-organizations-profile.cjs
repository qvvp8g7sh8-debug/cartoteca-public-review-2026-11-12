// Pure, reproducible definitions shared by the synthetic fixture and generators.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const HARNESS_FILES = [
  'benchmark-organizations.cjs',
  'benchmark-organizations-fixture.cjs',
  'benchmark-organizations-server.cjs',
  'benchmark-organizations-profile.cjs',
  'benchmark-organizations-client.cjs',
  'benchmark-organizations-scheduler.cjs',
  'benchmark-organizations-results.cjs',
  'benchmark-organizations-diagnostics.cjs',
  'benchmark-notifications-fixture.cjs',
  'benchmark-notifications-adapters.cjs',
];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function loadProfile(environment = process.env) {
  const name = environment.LOAD_BACKGROUND_PROFILE || 'none';
  assert.ok(['none', 'notifications-v1'].includes(name), 'Invalid synthetic background profile');
  const backgroundEnabled = name === 'notifications-v1';
  return {
    name,
    backgroundEnabled,
    origin: (backgroundEnabled ? 'https' : 'http') + '://10.234.12.2:4173',
    processRole: backgroundEnabled ? 'combined' : 'web',
  };
}
function dateRange(first) {
  assert.equal(typeof first, 'string', 'Set an explicit LOAD_FIRST_DATE (YYYY-MM-DD)');
  assert.match(first, /^\d{4}-\d{2}-\d{2}$/);
  const date = new Date(first + 'T00:00:00Z');
  assert.ok(
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === first,
    'Invalid fixture date',
  );
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
  return { first, monthEnd };
}
function organizationUsers(index, owner) {
  const org = index === 0 ? owner.organizationId : randomUUID();
  assert.match(org, UUID);
  const users = Array.from({ length: 1 + (index % 5) }, (_, n) => ({
    id: index === 0 && n === 0 ? owner.accountId : randomUUID(),
    role: n === 0 ? 'owner' : n === 1 && index % 5 >= 2 ? 'salon_admin' : 'cosmetologist',
    org,
    index,
  }));
  for (const user of users) assert.match(user.id, UUID);
  return { org, users };
}
// Every block of 30 actions has the same route mix, independent of account count.
function actionPlan(sequence) {
  assert.ok(Number.isSafeInteger(sequence) && sequence >= 0);
  // Vary each 30-action deck so a population divisible by 10 does not bind an
  // account to one route forever. Every full deck still has identical weights.
  const block = Math.floor(sequence / 30);
  const entry = actorOrder(30, (20261012 + block) >>> 0 || 1)[sequence % 30];
  const slot = entry % 10;
  return slot < 3
    ? 'search'
    : slot < 6
      ? 'calendar'
      : slot < 8
        ? 'card'
        : slot === 8
          ? 'save'
          : ['public-info', 'public-dates', 'public-availability'][Math.floor(entry / 10)];
}
function actorOrder(size, seed = 20261012) {
  assert.ok(Number.isInteger(size) && size >= 1 && size <= 50000);
  assert.ok(Number.isInteger(seed) && seed >= 1 && seed <= 0xffffffff);
  const result = Array.from({ length: size }, (_, n) => n);
  let state = seed >>> 0;
  for (let n = size - 1; n > 0; n--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const other = (state >>> 0) % (n + 1);
    [result[n], result[other]] = [result[other], result[n]];
  }
  return result;
}
function validateFixture(fixture) {
  const dates = dateRange(fixture.first);
  assert.equal(fixture.schema, 17);
  assert.ok(fixture.organizations.length >= 1 && fixture.organizations.length <= 10000);
  const counts = new Map(
    fixture.organizations.map((id) => {
      assert.match(id, UUID);
      return [id, 0];
    }),
  );
  assert.equal(counts.size, fixture.organizations.length);
  const ids = new Set();
  for (const user of fixture.actors) {
    assert.match(user.id, UUID);
    assert.ok(!ids.has(user.id));
    ids.add(user.id);
    assert.ok(counts.has(user.org));
    counts.set(user.org, counts.get(user.org) + 1);
  }
  assert.ok([...counts.values()].every((n) => n >= 1 && n <= 5));
  return dates;
}
function harnessIdentity(directory = __dirname) {
  const files = Object.fromEntries(
    HARNESS_FILES.map((name) => [
      name,
      createHash('sha256')
        .update(fs.readFileSync(path.join(directory, name)))
        .digest('hex'),
    ]),
  );
  return {
    version: 2,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  };
}
function environmentIdentity(env = process.env) {
  const imageId = env.LOAD_IMAGE_ID || null,
    sourceHash = env.LOAD_SOURCE_HASH || null;
  if (imageId) assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  if (sourceHash) assert.match(sourceHash, /^[a-f0-9]{64}$/);
  return {
    imageId,
    sourceHash,
    verifiedImageExternally: false,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
}
function fixtureIdentity(fixture) {
  // Hash only the documented shape, never cookies, key material or account values.
  const shape = {
    version: fixture.version,
    schema: fixture.schema,
    first: fixture.first,
    organizations: fixture.organizations.length,
    accounts: fixture.actors.length,
    cardsPerOrganization: fixture.cards,
    visitsPerCard: fixture.visits,
    roles: fixture.actors.reduce((counts, user) => {
      counts[user.role] = (counts[user.role] || 0) + 1;
      return counts;
    }, {}),
  };
  return {
    ...shape,
    shapeSha256: createHash('sha256').update(JSON.stringify(shape)).digest('hex'),
  };
}
function observeTenantStorage(create, observe, now = () => performance.now()) {
  // This wrapper measures lifecycle only: forward options (including the shared
  // process cache budget) unchanged on old and new application versions.
  return function (...args) {
    const start = now(),
      store = create.apply(this, args);
    if (path.basename(path.dirname(args[0])) === 'tenants') {
      observe('open', now() - start);
      const close = store.close;
      store.close = function (...closeArgs) {
        const closeStart = now();
        try {
          return close.apply(this, closeArgs);
        } finally {
          observe('close', now() - closeStart);
        }
      };
    }
    return store;
  };
}
module.exports = {
  HARNESS_FILES,
  UUID,
  dateRange,
  organizationUsers,
  actionPlan,
  actorOrder,
  validateFixture,
  harnessIdentity,
  environmentIdentity,
  fixtureIdentity,
  observeTenantStorage,
  loadProfile,
};
