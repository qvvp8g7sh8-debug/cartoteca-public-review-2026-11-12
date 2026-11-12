const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { calendarToken163 } = require('../src/server/infrastructure/postgres/calendar-token163.cjs');
test('163 calendar fingerprint binds scope, renderer, durable versions and signed time boundary', () => {
  const now = Date.now(),
    until = now + 20000;
  const url = new URL(
    'http://test/api/cabinet/calendar?from=2035-01-01&to=2035-01-01&compact=1&monthFrom=2035-01-01&monthTo=2035-01-31',
  );
  const current = {
    organizationId: 'org',
    accountId: 'owner',
    sessionId: 'session',
    role: 'owner',
  };
  const hash = (text) => createHmac('sha256', 'synthetic-key').update(text).digest('hex');
  const create = (extra = {}) =>
    calendarToken163({
      current,
      url,
      hash,
      versions: 'committed-v1',
      runtime: [false],
      renderConfig: [true],
      ...extra,
    });
  url.searchParams.set('version', create().sign(7, until));
  url.searchParams.set('until', String(until));
  assert.deepEqual(create().read(), { revision: 7, unchanged: true });
  assert.equal(create({ versions: 'committed-v2' }).read(), null);
  assert.equal(create({ current: { ...current, role: 'cosmetologist' } }).read(), null);
  assert.equal(create({ runtime: [true] }).read(), null);
  url.searchParams.set('until', String(until + 1));
  assert.equal(create().read(), null);
  url.searchParams.set('until', String(now - 1));
  url.searchParams.set('version', create().sign(7, now - 1));
  assert.equal(create().read(), null);
  url.searchParams.set('version', 'c163.bad.bad');
  assert.equal(create().read(), null);
});
