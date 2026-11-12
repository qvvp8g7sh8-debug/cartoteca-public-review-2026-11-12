const { randomUUID } = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');

const key = 'appointment-notification-events-v1';
const ttl = 24 * 60 * 60000;
const maxEntries = 2000;
const maxBytes = 1024 * 1024;

// Cabinet-owned encrypted metadata, committed with the authorized appointment.
// Platform queues are a projection; retiring an entry must follow their COMMIT.
function pending(storage, now = Date.now(), audience = '') {
  const saved = storage.get(key);
  if (saved !== undefined && saved !== null && !Array.isArray(saved))
    throw Error('Invalid appointment notification journal.');
  return (saved || []).filter(
    (entry) => entry.expiresAt > now && (!audience || entry.audience === audience),
  );
}
function record(storage, audience, events, now = Date.now()) {
  if (!['client', 'staff'].includes(audience) || !Array.isArray(events))
    throw Error('Invalid appointment notification audience.');
  if (!events.length) return [];
  if (storage.db && !storage.db.isTransaction)
    throw Error('Appointment event must commit with cabinet transaction.');
  const entries = events.map((event) => ({
    ...event,
    id: randomUUID(),
    audience,
    createdAt: now,
    expiresAt: Math.min(Number.isFinite(event.expiresAt) ? event.expiresAt : now + ttl, now + ttl),
  }));
  const next = [...pending(storage, now), ...entries].filter((entry) => entry.expiresAt > now);
  if (next.length > maxEntries || Buffer.byteLength(JSON.stringify(next)) > maxBytes)
    throw fail(409, 'Очередь уведомлений занята. Повторите сохранение позже.');
  storage.set(key, next);
  return entries;
}
function retire(storage, ids, now = Date.now()) {
  const removed = new Set(ids);
  const saved = storage.get(key) || [];
  const next = pending(storage, now).filter((entry) => !removed.has(entry.id));
  if (next.length !== saved.length) storage.set(key, next);
}
// The caller owns platform -> cabinet locks. Return acknowledgements to retire
// AFTER the owning platform transaction commits, never from inside its callback.
function replay(storage, audience, deliver, now = Date.now()) {
  const accepted = [];
  for (const entry of pending(storage, now, audience).slice(0, 50)) {
    const result = deliver(entry);
    if (result && typeof result.then === 'function')
      throw Error('Asynchronous appointment event replay is forbidden.');
    if (result === true) accepted.push(entry.id);
  }
  return accepted;
}
module.exports = { record, pending, retire, replay };
