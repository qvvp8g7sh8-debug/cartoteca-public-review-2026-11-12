const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.CARTOTECA_LOAD_TOOLS || path.resolve(__dirname, '../scripts');
const fixture = require(path.join(root, 'benchmark-organizations-fixture.cjs'));
const {
  UUID,
  HARNESS_FILES,
  organizationUsers,
  dateRange,
  validateFixture,
  actionPlan,
  actorOrder,
  fixtureIdentity,
  harnessIdentity,
  environmentIdentity,
  observeTenantStorage,
  loadProfile,
} = require(path.join(root, 'benchmark-organizations-profile.cjs'));
const { BASE, createClient } = require(path.join(root, 'benchmark-organizations-client.cjs'));
const { runSchedule } = require(path.join(root, 'benchmark-organizations-scheduler.cjs'));
const { routeResults } = require(path.join(root, 'benchmark-organizations-results.cjs'));
const owner = {
  accountId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
};
function syntheticFixture() {
  const groups = Array.from({ length: 5 }, (_, index) => organizationUsers(index, owner));
  return {
    version: 2,
    schema: 17,
    first: '2030-02-07',
    cards: 200,
    visits: 10,
    organizations: groups.map((group) => group.org),
    actors: groups
      .flatMap((group) => group.users)
      .map((user, index) => ({
        ...user,
        cookie: 'synthetic-secret-cookie-' + index,
        patient: 'p-' + user.index + '-' + index,
        service: user.id + '-s0',
        provider: user.id,
      })),
  };
}
test('load fixture refuses unrelated paths and invalid dimensions before opening a database', async () => {
  for (const directory of ['/opt/cartoteca-v2', '/app/runtime', '.', '/tmp/other'])
    assert.throws(() => fixture.safe(directory));
  for (const [organizations, cards] of [
    [0, 200],
    [10001, 200],
    [200, 0],
    [200, 2001],
  ])
    await assert.rejects(fixture.grow('/not-an-app', '/not-data', organizations, cards));
  await assert.rejects(fixture.grow('/not-an-app', '/tmp/unmarked-other', 200, 200, '2030-02-07'));
});
test('actual generated organizations and all 1-5 accounts have valid unique UUIDs', () => {
  const data = syntheticFixture();
  assert.equal(data.organizations.length, 5);
  assert.equal(data.actors.length, 15);
  assert.equal(new Set(data.actors.map((user) => user.id)).size, 15);
  for (const id of [...data.organizations, ...data.actors.map((user) => user.id)])
    assert.match(id, UUID);
  assert.deepEqual(
    data.organizations.map((org) => data.actors.filter((user) => user.org === org).length),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(validateFixture(data), { first: '2030-02-07', monthEnd: '2030-02-28' });
  data.organizations[1] = 'synthetic-org-1';
  assert.throws(() => validateFixture(data));
});
test('explicit dates validate leap years and produce real month ends', () => {
  for (const first of [undefined, '', '2030-02-29', '2030-04-31', '2030-13-01', '2030-1-01'])
    assert.throws(() => dateRange(first));
  assert.equal(dateRange('2032-02-07').monthEnd, '2032-02-29');
  assert.equal(dateRange('2030-04-07').monthEnd, '2030-04-30');
  assert.equal(dateRange('2030-12-31').monthEnd, '2030-12-31');
});
test('public route mixture is independent of account population and never waits for a full account round', () => {
  for (const accounts of [15, 600, 1500, 3000, 6000]) {
    const order = actorOrder(accounts, 1234);
    assert.equal(new Set(order).size, accounts);
    assert.deepEqual(order, actorOrder(accounts, 1234));
    const counts = {};
    for (let sequence = 0; sequence < 90; sequence++) {
      assert.ok(order[sequence % accounts] >= 0);
      const name = actionPlan(sequence);
      counts[name] = (counts[name] || 0) + 1;
    }
    assert.deepEqual(counts, {
      search: 27,
      calendar: 27,
      card: 18,
      save: 9,
      'public-info': 3,
      'public-dates': 3,
      'public-availability': 3,
    });
    assert.ok(
      new Set(Array.from({ length: 10 }, (_, round) => actionPlan(round * accounts))).size > 1,
      'Repeated actor rounds must not pin each account to one route',
    );
  }
});
test('provenance covers every executable harness module but never serializes cookies or unrelated environment', () => {
  for (const name of HARNESS_FILES)
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(root, name), 'utf8')));
  const identity = harnessIdentity(root);
  assert.equal(Object.keys(identity.files).length, HARNESS_FILES.length);
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  const data = syntheticFixture(),
    first = fixtureIdentity(data);
  data.actors[0].cookie = 'changed-secret';
  assert.deepEqual(fixtureIdentity(data), first);
  assert.doesNotMatch(JSON.stringify(first), /cookie|secret|00000000/);
  const environment = environmentIdentity({
    SECRET: 'must-not-appear',
    LOAD_IMAGE_ID: 'sha256:' + 'a'.repeat(64),
  });
  assert.doesNotMatch(JSON.stringify(environment), /SECRET|must-not-appear/);
  assert.equal(environment.verifiedImageExternally, false);
  assert.throws(() => environmentIdentity({ LOAD_IMAGE_ID: 'not-an-image' }));
});
function fakeApi(data, modes = {}) {
  const patients = new Map(
    data.actors.map((user) => [
      user.patient,
      { id: user.patient, appointments: [{ notes: 'Before' }] },
    ]),
  );
  const receipts = new Map(),
    calls = [];
  async function fetchImpl(url, options) {
    assert.ok(url.startsWith(BASE + '/api/'));
    const target = new URL(url);
    calls.push({ path: target.pathname, method: options.method });
    const json = (value) => ({
      status: 200,
      async json() {
        return structuredClone(value);
      },
    });
    if (target.pathname === '/api/cabinet/patient')
      return json({ revision: 1, patients: [patients.get(target.searchParams.get('id'))] });
    if (target.pathname === '/api/cabinet/operation')
      return json(receipts.get(target.searchParams.get('id')) || { status: 'unknown' });
    if (target.pathname === '/api/cabinet/changes') {
      const body = JSON.parse(options.body),
        change = body.patients[0],
        mode = modes[change.id];
      if (mode === 'rejected') return { status: 409, body: { async cancel() {} } };
      if (mode !== 'unknown') {
        patients.set(change.id, change.after);
        receipts.set(options.headers['X-Cartoteca-Operation'], {
          status: 'committed',
          result: { patients: [change.after] },
        });
      }
      if (mode === 'unknown' || mode === 'lost-response')
        throw Object.assign(Error('Synthetic timeout'), { name: 'TimeoutError' });
      return json({ patients: [change.after] });
    }
    throw Error('Unexpected synthetic route');
  }
  return { fetchImpl, calls, patients, receipts };
}
test('lost write response is reconciled by the original receipt without retrying the mutation', async () => {
  const data = syntheticFixture(),
    user = data.actors[0],
    api = fakeApi(data, { [user.patient]: 'lost-response' });
  const client = createClient(data, 'receipt-test', api);
  await assert.rejects(client.action('save', user, 0, 8), { name: 'TimeoutError' });
  await assert.rejects(client.action('save', user, 0, 18), { name: 'UnresolvedWrite' });
  const measured = client.samples.length,
    result = await client.reconcile();
  assert.equal(result.unknownWritesResolved, 1);
  assert.equal(result.receiptConfirmed, 1);
  assert.equal(result.unresolvedWrites, 0);
  assert.equal(result.savedRecordsVerified, 1);
  assert.equal(client.samples.length, measured, 'Post-load verification is not throughput');
  assert.equal(api.calls.filter((call) => call.method === 'PATCH').length, 1);
});
test('unknown write stays explicit while independent acknowledged records are still verified', async () => {
  const data = syntheticFixture(),
    [unknown, ok] = data.actors,
    api = fakeApi(data, { [unknown.patient]: 'unknown' });
  const client = createClient(data, 'unknown-test', api);
  await assert.rejects(client.action('save', unknown, 0, 8));
  await client.action('save', ok, 1, 18);
  const result = await client.reconcile();
  assert.equal(result.unresolvedWrites, 1);
  assert.equal(result.savedRecordsVerified, 1);
  assert.equal(result.unknownWritesResolved, 0);
  assert.equal(api.calls.filter((call) => call.method === 'PATCH').length, 2);
});
test('read validation failures count once and cannot remain successful throughput samples', async () => {
  const data = syntheticFixture(),
    client = createClient(data, 'invalid-test', {
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { directory: [{ id: 'foreign-patient' }] };
        },
      }),
    });
  await assert.rejects(client.action('search', data.actors[0], 0, 0));
  assert.equal(client.samples.length, 1);
  const route = routeResults(client.samples).search;
  assert.equal(route.statuses['network-or-validation'], 1);
  assert.equal(route.p95Ms, null);
  assert.ok(route.allOutcomesP95Ms >= 0);
});
test('a paused public page is not accepted as a successful booking workload', async () => {
  const data = syntheticFixture(),
    client = createClient(data, 'paused-test', {
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { health: { available: false }, services: [] };
        },
      }),
    });
  await assert.rejects(client.action('public-info', data.actors[0], 0, 9), /not publicly bookable/);
  assert.equal(client.samples[0].status, 'network-or-validation');
});
test('bounded open-loop exposes refused arrivals instead of building an unbounded queue', async () => {
  const actors = syntheticFixture().actors;
  let time = 0,
    running = 0,
    peak = 0;
  const timers = [];
  const sleep = async (ms) => {
    time += ms;
    for (const timer of timers.splice(0)) {
      if (timer.due <= time) timer.resolve();
      else timers.push(timer);
    }
    if (time >= 3000 && timers.length) {
      time = Math.max(time, ...timers.map((timer) => timer.due));
      for (const timer of timers.splice(0)) timer.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  const result = await runSchedule({
    mode: 'open',
    actors,
    seconds: 3,
    rate: 20,
    concurrent: 2,
    now: () => time,
    sleep,
    action: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => timers.push({ due: time + 400, resolve }));
      running--;
    },
  });
  assert.equal(result.offered, 60);
  assert.equal(result.started, result.completed);
  assert.equal(
    result.offered,
    result.started +
      result.droppedAtLimit +
      result.droppedBusyAccount +
      result.missedGeneratorSchedule,
  );
  assert.ok(result.droppedAtLimit > 0);
  assert.ok(peak <= 2);
  assert.equal(running, 0);
  assert.equal(result.plannedRoutes['public-availability'], 2);
});
test('stand keeps the private target, disables delivery and reports cache/close/resource evidence', () => {
  assert.equal(BASE, 'http://10.234.12.2:4173');
  const source = fs.readFileSync(path.join(root, 'benchmark-organizations-server.cjs'), 'utf8');
  for (const name of [
    'pushEnabled',
    'telegramAutostart',
    'supportAutostart',
    'maxAutostart',
    'pushAutostart',
    'adminEmailAutostart',
    'bookingPublicationAutostart',
  ])
    assert.match(source, new RegExp(name + ': false'));
  assert.match(source, /sendMail: null/);
  assert.match(source, /telegramBot: null/);
  assert.match(source, /tenantCloseMs/);
  assert.match(source, /runtimeFlags/);
  assert.match(source, /processRole: profile\.processRole/);
  assert.match(source, /telegramIdentityAutostart: false/);
  assert.match(source, /processRoleObserved = server\.processRole \|\| null/);
});
test('optional fake background changes only the accepted Origin, never the private HTTP target', async () => {
  assert.deepEqual(loadProfile({}), {
    name: 'none',
    backgroundEnabled: false,
    origin: BASE,
    processRole: 'web',
  });
  const profile = loadProfile({ LOAD_BACKGROUND_PROFILE: 'notifications-v1' });
  assert.equal(profile.processRole, 'combined');
  assert.equal(profile.origin, 'https://10.234.12.2:4173');
  assert.throws(() => loadProfile({ LOAD_BACKGROUND_PROFILE: 'production' }));
  const data = syntheticFixture();
  const client = createClient(data, 'private-profile', {
    origin: profile.origin,
    fetchImpl: async (target, options) => {
      assert.ok(target.startsWith(BASE + '/'));
      assert.equal(options.headers.Origin, profile.origin);
      return {
        status: 200,
        async json() {
          return { patients: [{ id: data.actors[0].patient }] };
        },
      };
    },
  });
  await client.action('card', data.actors[0], 0, 0);
  assert.throws(() => createClient(data, 'invalid', { origin: 'https://example.invalid/' }));
});
test('storage lifecycle instrumentation preserves shared-budget options, receivers and close errors', () => {
  const budget = {},
    options = { readCacheBudget: budget },
    receiver = {},
    calls = [];
  let time = 0;
  const store = {
    close(argument) {
      assert.equal(this, store);
      assert.equal(argument, 'close-marker');
      time += 3;
      throw Error('Synthetic close failure');
    },
  };
  const observed = observeTenantStorage(
    function (...args) {
      assert.equal(this, receiver);
      assert.deepEqual(args, ['/synthetic/tenants/org', options, 'extra-argument']);
      assert.equal(args[1].readCacheBudget, budget);
      time += 2;
      return store;
    },
    (event, duration) => calls.push([event, duration]),
    () => time,
  );
  assert.equal(observed.call(receiver, '/synthetic/tenants/org', options, 'extra-argument'), store);
  assert.throws(() => store.close('close-marker'), /Synthetic close failure/);
  assert.deepEqual(calls, [
    ['open', 2],
    ['close', 3],
  ]);
  const legacy = { close() {} },
    before = legacy.close;
  assert.equal(
    observeTenantStorage(
      () => legacy,
      () => assert.fail('Root store is not a tenant'),
    )('/synthetic'),
    legacy,
  );
  assert.equal(legacy.close, before);
});
