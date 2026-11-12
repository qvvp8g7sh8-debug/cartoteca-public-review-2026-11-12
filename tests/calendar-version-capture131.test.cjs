const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarRead } = require('../src/server/modules/cabinet/calendar-read.cjs');
const { calendarPeriod } = require('../src/server/modules/cabinet/queries.cjs');

function fixture() {
  let platformVersion = 1,
    storageVersion = 1,
    revision = 1,
    connected = true,
    beforeSnapshot = () => {};
  const counters = {};
  const count = (name) => {
    counters[name] = (counters[name] || 0) + 1;
  };
  const c = {
    url: new URL(
      'http://localhost/api/cabinet/calendar?from=2030-01-01&to=2030-01-01&compact=1&monthFrom=2030-01-01&monthTo=2030-02-11',
    ),
    current: { organizationId: 'org', accountId: 'owner', role: 'owner', sessionId: 'session' },
    tenantStore: () => ({
      get: () => revision,
      readVersion() {
        count('storage');
        return storageVersion;
      },
      calendarSnapshot() {
        count('snapshot');
        beforeSnapshot();
        return { revision, appointments: [], overview: [] };
      },
    }),
    platform: {
      organizationTimeZone: () => 'UTC',
      subscription() {
        count('subscription');
        return { status: 'active' };
      },
      readVersion() {
        count('platform');
        return platformVersion;
      },
    },
    telegram: {
      status() {
        count('provider');
        return { connected };
      },
    },
    appointmentState: { decorate: (value) => value },
    json: (_res, _status, value) => value,
  };
  return {
    c,
    counters,
    read: () => calendarRead(c, calendarPeriod),
    reset() {
      for (const key of Object.keys(counters)) delete counters[key];
    },
    pin(result) {
      c.url.searchParams.set('version', result.version);
      c.url.searchParams.set('until', result.validUntil);
    },
    platformChanged: () => platformVersion++,
    storageChanged: () => storageVersion++,
    revisionChanged: () => revision++,
    providerChanged: () => {
      connected = !connected;
    },
    duringSnapshot: (work) => {
      beforeSnapshot = work;
    },
  };
}

test('a compact conditional miss captures SQL versions and plan once, and a hit skips the snapshot', () => {
  const f = fixture();
  const first = f.read();
  f.pin(first);
  f.platformChanged();
  f.reset();
  const changed = f.read();
  assert.equal(changed.unchanged, undefined);
  assert.deepEqual(f.counters, {
    platform: 1,
    storage: 1,
    provider: 1,
    subscription: 1,
    snapshot: 1,
  });
  f.pin(changed);
  f.reset();
  assert.equal(f.read().unchanged, true);
  assert.deepEqual(f.counters, { platform: 1, storage: 1, provider: 1, subscription: 1 });
});

test('compact invalidation preserves independent scope, provider, cabinet and platform observations', () => {
  for (const change of [
    (f) => f.storageChanged(),
    (f) => f.revisionChanged(),
    (f) => f.platformChanged(),
    (f) => f.providerChanged(),
    (f) => {
      f.c.current.organizationId = 'other-org';
    },
    (f) => {
      f.c.current.accountId = 'other-account';
    },
    (f) => {
      f.c.current.sessionId = 'other-session';
    },
    (f) => {
      f.c.current.role = 'cosmetologist';
    },
  ]) {
    const f = fixture();
    f.pin(f.read());
    change(f);
    f.reset();
    assert.equal(f.read().unchanged, undefined);
    assert.equal(f.counters.snapshot, 1);
    assert.equal(f.counters.platform, 1);
    assert.equal(f.counters.storage, 1);
    assert.equal(f.counters.subscription, 1);
  }
});

test('a write observed during the snapshot cannot attach a later version to the earlier response', () => {
  const f = fixture();
  f.duringSnapshot(() => {
    f.platformChanged();
    f.storageChanged();
    f.duringSnapshot(() => {});
  });
  const first = f.read();
  f.pin(first);
  f.reset();
  const second = f.read();
  assert.equal(second.unchanged, undefined, 'capture stays before the cabinet snapshot');
  assert.equal(f.counters.snapshot, 1);
  f.pin(second);
  assert.equal(f.read().unchanged, true);
});
