const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const INDEX = 'booking-classic-receipt-index';
const markerKey = (org, key) =>
  'booking-classic:' +
  crypto
    .createHash('sha256')
    .update(JSON.stringify([org, key]))
    .digest('hex');
const submissionHash = ({ key, ...input }) =>
  crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

function classicReceipt(storage, org, input) {
  const receipt = storage.get(markerKey(org, input.key));
  if (!receipt) return null;
  if (receipt.hash !== submissionHash(input))
    throw Object.assign(fail(409, 'Этот запрос уже использован для другой записи.'), {
      code: 'BOOKING_KEY_CONFLICT',
    });
  return receipt.result;
}
// Called inside the appointment's cabinet transaction. Retain every live form
// (signed challenges expire after 30 minutes), never evict an active receipt.
// The organization submit budget bounds live receipts; no clinical copy is kept.
function writeClassicReceipt(storage, org, input, result, now) {
  const key = markerKey(org, input.key);
  const live = [];
  for (const item of storage.get(INDEX, [])) {
    if (item.expires <= now) storage.db.prepare('DELETE FROM meta WHERE key=?').run(item.key);
    else live.push(item);
  }
  storage.set(key, { hash: submissionHash(input), result });
  storage.set(INDEX, [...live, { key, expires: now + 31 * 60000 }]);
}
module.exports = { classicReceipt, writeClassicReceipt };
