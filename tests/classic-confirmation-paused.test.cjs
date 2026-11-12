const test = require('node:test');
const assert = require('node:assert/strict');
const { classicConfirmation, writeClassicConfirmation, classicNotices } =
  require('../src/server/modules/booking/classic-confirmation.cjs');

test('paused classic confirmation draft does not read or write receipts or schedule messages', () => {
  const unavailable = new Proxy({}, { get() { throw Error('Paused feature touched storage'); } });
  assert.equal(classicConfirmation(unavailable, unavailable, 'synthetic', {}, 'Europe/Moscow'), null);
  assert.equal(writeClassicConfirmation(unavailable, unavailable, 'synthetic', {}, 'Europe/Moscow', 0), undefined);
  assert.deepEqual(classicNotices(unavailable, 0), []);
});
