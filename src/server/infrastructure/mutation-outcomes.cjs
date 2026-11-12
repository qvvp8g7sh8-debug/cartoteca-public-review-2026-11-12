// Compact commit proofs outlive replay snapshots without retaining clinical data.
// They share the cabinet transaction, encrypted meta storage and backup lifetime.
const { fail } = require('../../shared/errors.cjs');

const INDEX = 'mutation-outcome-index',
  MAX_COUNT = 512,
  TTL = 86400000;
const outcomeKey = (key) => key + ':committed';

function readOutcome(storage, key, expectedHash) {
  const value = storage.get(outcomeKey(key));
  if (!value || value.expires <= Date.now()) return null;
  if (expectedHash && value.hash !== expectedHash)
    throw fail(409, 'Номер операции уже использован для другого изменения.');
  return value;
}

function writeOutcome(storage, key, identity, saved) {
  const now = Date.now(),
    name = outcomeKey(key),
    index = storage.get(INDEX, []),
    live = [];
  for (const item of index) {
    if (item.expires <= now || item.key === name)
      storage.db.prepare('DELETE FROM meta WHERE key=?').run(item.key);
    else live.push(item);
  }
  while (live.length >= MAX_COUNT)
    storage.db.prepare('DELETE FROM meta WHERE key=?').run(live.shift().key);
  const value = {
    hash: identity.hash,
    revision: saved.revision,
    committedAt: now,
    expires: now + TTL,
  };
  storage.set(name, value);
  live.push({ key: name, expires: value.expires });
  storage.set(INDEX, live);
}

module.exports = { outcomeKey, readOutcome, writeOutcome };
