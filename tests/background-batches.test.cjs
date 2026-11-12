const test = require('node:test');
const assert = require('node:assert/strict');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const {
  createBookingPublicationRuntime,
} = require('../src/server/modules/booking/publication-runtime.cjs');

function pushFixture({ stoppedOnYield = false, expiredOnYield = false } = {}) {
  const ids = Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(3, '0'));
  const visits = [],
    pages = [],
    turns = [];
  let claims = 0,
    active = true,
    runtime;
  const store = {
    organizations: () => assert.fail('Runtime must not read all organizations at once'),
    organizationPage(cursor, limit) {
      assert.equal(limit, 10);
      const organizations = ids.filter((id) => id > cursor).slice(0, limit);
      pages.push(organizations.length);
      return { organizations, cursor: organizations.length === limit ? organizations.at(-1) : '' };
    },
    allowed(org) {
      visits.push(org);
      return false;
    },
    claim() {
      claims++;
      return null;
    },
  };
  runtime = createPushRuntime({
    platform: { staffPush: store },
    tenantStore: () => assert.fail('No tenant data needed'),
    origin: 'https://synthetic.test',
    enabled: true,
    send: () => assert.fail('No real sends'),
    canRun: () => active,
    yieldTurn: async () => {
      turns.push(visits.length);
      if (stoppedOnYield) runtime.stop();
      if (expiredOnYield) active = false;
      await new Promise(setImmediate);
    },
  });
  return { runtime, visits, pages, turns, claims: () => claims, ids };
}

test('Push schedules organizations in keyset batches and yields between organizations before queue delivery', async () => {
  const f = pushFixture();
  f.runtime.start();
  try {
    await f.runtime.tick();
    assert.deepEqual(f.visits, f.ids);
    assert.deepEqual(f.pages, [10, 10, 5]);
    assert.deepEqual(f.turns, [10, 20]);
    assert.equal(f.claims(), 1);
  } finally {
    f.runtime.stop();
  }
});

test('shutdown during a Push scheduling yield does not reopen storage or claim messages', async () => {
  const f = pushFixture({ stoppedOnYield: true });
  f.runtime.start();
  await f.runtime.tick();
  assert.equal(f.visits.length, 10);
  assert.deepEqual(f.pages, [10]);
  assert.equal(f.claims(), 0);
});

test('publication maintenance limits each synchronous batch and resumes its cursor', () => {
  const calls = [];
  const runtime = createBookingPublicationRuntime({
    publication: {
      reconcileBatch(cursor, limit) {
        calls.push({ cursor, limit });
        return { cursor: cursor ? '' : 'next-organization' };
      },
    },
  });
  runtime.tick();
  runtime.tick();
  assert.deepEqual(calls, [
    { cursor: '', limit: 10 },
    { cursor: 'next-organization', limit: 10 },
  ]);
  runtime.stop();
});

test('an expired background lease stops Push scheduling after yield before new claims', async () => {
  const f = pushFixture({ expiredOnYield: true });
  f.runtime.start();
  try {
    await f.runtime.tick();
    assert.equal(f.visits.length, 10);
    assert.deepEqual(f.pages, [10]);
    assert.equal(f.claims(), 0);
  } finally {
    f.runtime.stop();
  }
});

test('publication skips database writes while background ownership is unproven', () => {
  const runtime = createBookingPublicationRuntime({
    publication: { reconcileBatch: () => assert.fail('No database writes after expiry') },
    canRun: () => false,
  });
  assert.deepEqual(runtime.tick(), { cursor: '', skipped: true });
});
