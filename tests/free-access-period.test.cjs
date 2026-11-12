const test = require('node:test');
const assert = require('node:assert/strict');
const { freeAccessPeriod } = require('../src/server/modules/billing/free-access-period.cjs');

test('free year uses calendar months and clamps the leap-day anniversary', () => {
  assert.deepEqual(
    freeAccessPeriod('2024-02-29T10:00:00Z', 'Europe/Moscow', new Date('2024-02-29T12:00:00Z')),
    { status: 'active', startDate: '2024-02-29', endDate: '2025-02-28', remainingDays: 365 },
  );
  assert.equal(
    freeAccessPeriod('2023-03-01T10:00:00Z', 'Europe/Moscow', new Date('2023-03-01T12:00:00Z'))
      .remainingDays,
    366,
  );
});

test('last free day and anniversary use organization midnight rather than device time', () => {
  const registeredAt = '2025-10-10T22:30:00Z';
  const before = freeAccessPeriod(registeredAt, 'Asia/Yerevan', new Date('2026-10-10T19:59:59Z'));
  assert.deepEqual(before, {
    status: 'active',
    startDate: '2025-10-11',
    endDate: '2026-10-11',
    remainingDays: 1,
  });
  const ended = freeAccessPeriod(registeredAt, 'Asia/Yerevan', new Date('2026-10-10T20:00:00Z'));
  assert.equal(ended.status, 'ended');
  assert.equal(ended.remainingDays, 0);
  assert.equal(
    freeAccessPeriod(registeredAt, 'Asia/Yerevan', new Date('2027-11-01T12:00:00Z')).remainingDays,
    0,
  );
});

test('civil day counting survives daylight saving transitions and rejects missing/future dates', () => {
  assert.equal(
    freeAccessPeriod('2025-03-30T01:30:00Z', 'Europe/Berlin', new Date('2026-03-29T12:00:00Z'))
      .remainingDays,
    1,
  );
  for (const value of [null, '', 'invalid', '2030-01-01T00:00:00Z'])
    assert.equal(freeAccessPeriod(value, 'Europe/Moscow', new Date('2026-10-11T12:00:00Z')), null);
});
