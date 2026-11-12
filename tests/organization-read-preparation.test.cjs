const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrganizations } = require('../src/server/modules/organizations/service.cjs');
const {
  DEFAULT_TIME_ZONE,
  createOrganizationTimeZone,
} = require('../src/server/modules/organizations/time-zone.cjs');

const SQL = Object.freeze({
  organization: 'SELECT id,value,slug,status FROM organizations WHERE id=?',
  subscription: 'SELECT plan,status,limits,changed_at FROM subscriptions WHERE organization_id=?',
  timeZone: 'SELECT value FROM organizations WHERE id=?',
});

function syntheticContext(name = 'First') {
  const organizations = new Map([
    [
      'org-a',
      {
        id: 'org-a',
        slug: 'first',
        status: 'active',
        value: JSON.stringify({ name, timeZone: DEFAULT_TIME_ZONE }),
      },
    ],
    [
      'org-b',
      {
        id: 'org-b',
        slug: 'second',
        status: 'active',
        value: '{"name":"Second","timeZone":"UTC"}',
      },
    ],
  ]);
  const subscriptions = new Map([
    ['org-a', { plan: 'free', status: 'active', limits: '{"members":3}', changed_at: 1 }],
    ['org-b', { plan: 'team', status: 'active', limits: '{"members":9}', changed_at: 2 }],
  ]);
  const calls = { prepares: [], reads: [], opens: 0 };
  const db = {
    prepare(sql) {
      assert.ok(Object.values(SQL).includes(sql), 'Only the three fixed read statements are used');
      calls.prepares.push(sql);
      return {
        get(...parameters) {
          assert.equal(parameters.length, 1);
          const [id] = parameters;
          calls.reads.push({ sql, id });
          const row = (sql === SQL.subscription ? subscriptions : organizations).get(id);
          if (!row) return undefined;
          return sql === SQL.timeZone ? { value: row.value } : { ...row };
        },
      };
    },
  };
  const context = {
    db,
    open(value) {
      calls.opens++;
      return JSON.parse(value);
    },
    fail: (status, message) => Object.assign(Error(message), { status }),
  };
  return { context, organizations, subscriptions, calls };
}

test('organization reads prepare once while fetching current rows for each organization and deletion', () => {
  const f = syntheticContext(),
    service = createOrganizations(f.context);
  assert.deepEqual(f.calls.prepares, []);
  assert.equal(service.organization('org-a').name, 'First');
  f.organizations.set('org-a', {
    id: 'org-a',
    slug: 'changed',
    status: 'suspended',
    value: '{"name":"Changed"}',
  });
  assert.deepEqual(service.organization('org-a'), {
    id: 'org-a',
    slug: 'changed',
    status: 'suspended',
    name: 'Changed',
  });
  assert.equal(service.organization('org-b').name, 'Second');
  const returned = service.organization('org-a');
  returned.name = 'Caller mutation';
  assert.equal(service.organization('org-a').name, 'Changed');
  f.organizations.delete('org-a');
  assert.throws(() => service.organization('org-a'), { status: 404 });
  f.organizations.set('org-a', {
    id: 'org-a',
    slug: 'restored',
    status: 'active',
    value: '{"name":"Restored"}',
  });
  assert.equal(service.organization('org-a').name, 'Restored');
  assert.deepEqual(f.calls.prepares, [SQL.organization]);
  assert.deepEqual(
    f.calls.reads.map(({ id }) => id),
    ['org-a', 'org-a', 'org-b', 'org-a', 'org-a', 'org-a', 'org-a'],
  );
  assert.equal(f.calls.opens, 6);
});

test('subscription reads retain fresh plan, status, limits and timestamp without caching missing rows', () => {
  const f = syntheticContext(),
    service = createOrganizations(f.context);
  assert.deepEqual(f.calls.prepares, []);
  assert.deepEqual(service.subscription('org-a'), {
    plan: 'free',
    status: 'active',
    limits: { members: 3 },
    changedAt: 1,
  });
  f.subscriptions.set('org-a', {
    plan: 'team',
    status: 'suspended',
    limits: '{"members":1}',
    changed_at: 8,
  });
  assert.deepEqual(service.subscription('org-a'), {
    plan: 'team',
    status: 'suspended',
    limits: { members: 1 },
    changedAt: 8,
  });
  assert.equal(service.subscription('org-b').limits.members, 9);
  f.subscriptions.delete('org-a');
  assert.throws(() => service.subscription('org-a'), { status: 404 });
  f.subscriptions.set('org-a', {
    plan: 'free',
    status: 'active',
    limits: '{"members":2}',
    changed_at: 9,
  });
  assert.equal(service.subscription('org-a').changedAt, 9);
  assert.deepEqual(f.calls.prepares, [SQL.subscription]);
  assert.deepEqual(
    f.calls.reads.map(({ id }) => id),
    ['org-a', 'org-a', 'org-b', 'org-a', 'org-a'],
  );
  assert.equal(f.calls.opens, 4);
});

test('time-zone reads reuse preparation and observe changed, deleted, default and invalid values', () => {
  const f = syntheticContext(),
    service = createOrganizationTimeZone(f.context);
  assert.deepEqual(f.calls.prepares, []);
  assert.equal(service.organizationTimeZone('org-a'), DEFAULT_TIME_ZONE);
  f.organizations.get('org-a').value = '{"timeZone":"Asia/Yerevan"}';
  assert.equal(service.organizationTimeZone('org-a'), 'Asia/Yerevan');
  assert.equal(service.organizationTimeZone('org-b'), 'UTC');
  f.organizations.delete('org-a');
  assert.throws(() => service.organizationTimeZone('org-a'), { status: 404 });
  f.organizations.set('org-a', { value: '{}' });
  assert.equal(service.organizationTimeZone('org-a'), DEFAULT_TIME_ZONE);
  f.organizations.get('org-a').value = '{"timeZone":"Synthetic/Invalid"}';
  assert.throws(() => service.organizationTimeZone('org-a'), { status: 400 });
  f.organizations.get('org-a').value = '{"timeZone":"Europe/Samara"}';
  assert.equal(service.organizationTimeZone('org-a'), 'Europe/Samara');
  assert.deepEqual(f.calls.prepares, [SQL.timeZone]);
  assert.equal(f.calls.reads.length, 7);
  assert.equal(f.calls.opens, 6);
});

test('lazy private statements stay isolated between contexts without replacing public db.prepare', () => {
  const first = syntheticContext('First context'),
    second = syntheticContext('Second context');
  const prepareMethods = [first.context.db.prepare, second.context.db.prepare];
  const services = [first, second].map(({ context }) => ({
    organizations: createOrganizations(context),
    zones: createOrganizationTimeZone(context),
  }));
  assert.deepEqual(first.calls.prepares, []);
  assert.deepEqual(second.calls.prepares, []);
  assert.equal(services[0].organizations.organization('org-a').name, 'First context');
  assert.equal(services[1].organizations.organization('org-a').name, 'Second context');
  for (let index = 0; index < services.length; index++) {
    const f = [first, second][index],
      service = services[index];
    assert.equal(service.organizations.subscription('org-a').plan, 'free');
    assert.equal(service.zones.organizationTimeZone('org-b'), 'UTC');
    assert.deepEqual(f.calls.prepares, [SQL.organization, SQL.subscription, SQL.timeZone]);
    assert.equal(f.calls.reads.length, 3);
    assert.equal(f.context.db.prepare, prepareMethods[index]);
  }
  first.organizations.get('org-a').value = '{"name":"Changed only first"}';
  assert.equal(services[0].organizations.organization('org-a').name, 'Changed only first');
  assert.equal(services[1].organizations.organization('org-a').name, 'Second context');
  assert.equal(first.calls.prepares.length, 3);
  assert.equal(second.calls.prepares.length, 3);
});

test('failed lazy preparation is retried and a successful statement still reads on every call', () => {
  const f = syntheticContext(),
    originalPrepare = f.context.db.prepare;
  const unavailable = Error('Synthetic preparation unavailable');
  let attempts = 0;
  f.context.db.prepare = function (sql) {
    if (++attempts === 1) throw unavailable;
    return originalPrepare.call(this, sql);
  };
  const service = createOrganizations(f.context);
  assert.equal(attempts, 0);
  assert.throws(
    () => service.organization('org-a'),
    (error) => error === unavailable,
  );
  assert.equal(service.organization('org-a').name, 'First');
  f.organizations.get('org-a').value = '{"name":"Fresh after retry"}';
  assert.equal(service.organization('org-a').name, 'Fresh after retry');
  assert.equal(attempts, 2);
  assert.deepEqual(f.calls.prepares, [SQL.organization]);
  assert.equal(f.calls.reads.length, 2);
});
