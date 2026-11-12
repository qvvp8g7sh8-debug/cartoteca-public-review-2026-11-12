const test = require('node:test');
const assert = require('node:assert/strict');
const journal = require('../src/server/modules/notifications/appointment-event-journal.cjs');

function fixture() {
  const values = new Map();
  return {
    db: { isTransaction: true },
    get: (key) => structuredClone(values.get(key)),
    set: (key, value) => values.set(key, structuredClone(value)),
  };
}

test('journal audiences share encrypted-meta port but acknowledge only their own stable event IDs', () => {
  const storage = fixture(),
    now = 1000;
  const [client] = journal.record(
    storage,
    'client',
    [{ kind: 'created', appointmentId: 'a' }],
    now,
  );
  const [staff] = journal.record(
    storage,
    'staff',
    [
      {
        kind: 'created',
        reference: { id: 'a' },
        recipients: { telegram: [{ accountId: 'staff', bindingId: 'binding' }] },
      },
    ],
    now,
  );
  assert.notEqual(client.id, staff.id);
  assert.equal(journal.pending(storage, now).length, 2);
  const ids = journal.replay(storage, 'client', (entry) => entry.id === client.id, now);
  assert.deepEqual(ids, [client.id]);
  assert.equal(
    journal.pending(storage, now).length,
    2,
    'select/enqueue must not retire before platform COMMIT',
  );
  journal.retire(storage, ids, now);
  assert.deepEqual(
    journal.pending(storage, now).map((entry) => entry.id),
    [staff.id],
  );
  assert.deepEqual(journal.pending(storage, now, 'staff')[0].recipients, {
    telegram: [{ accountId: 'staff', bindingId: 'binding' }],
  });
});

test('journal enforces the cabinet transaction and rejects asynchronous replay', () => {
  const storage = fixture();
  storage.db.isTransaction = false;
  assert.throws(
    () => journal.record(storage, 'client', [{ kind: 'created' }], 1),
    /cabinet transaction/,
  );
  storage.db.isTransaction = true;
  journal.record(storage, 'client', [{ kind: 'created' }], 1);
  assert.throws(
    () => journal.replay(storage, 'client', () => Promise.resolve(true), 1),
    /Asynchronous/,
  );
  assert.equal(journal.pending(storage, 1).length, 1);
});

test('journal expiry is capped at24h and replay processes a bounded50 entries per pass', () => {
  const storage = fixture(),
    now = 1000;
  journal.record(
    storage,
    'client',
    Array.from({ length: 75 }, (_, n) => ({
      kind: 'created',
      appointmentId: String(n),
      expiresAt: now + 7 * 86400000,
    })),
    now,
  );
  assert.equal(journal.replay(storage, 'client', () => true, now).length, 50);
  assert.equal(journal.pending(storage, now + 86400000 - 1).length, 75);
  assert.equal(journal.pending(storage, now + 86400000).length, 0);
  journal.retire(storage, [], now + 86400000);
  assert.equal(journal.pending(storage, now).length, 0);
});

test('journal capacity failure preserves the previously committed events instead of dropping notices', () => {
  const storage = fixture(),
    now = 1000;
  const first = journal.record(storage, 'staff', [{ kind: 'created' }], now)[0];
  assert.throws(
    () =>
      journal.record(
        storage,
        'client',
        Array.from({ length: 2000 }, () => ({ kind: 'created' })),
        now,
      ),
    { status: 409 },
  );
  assert.deepEqual(
    journal.pending(storage, now).map((entry) => entry.id),
    [first.id],
  );
  assert.throws(
    () =>
      journal.record(
        storage,
        'client',
        [{ kind: 'created', oversized: 'x'.repeat(1024 * 1024) }],
        now,
      ),
    { status: 409 },
  );
  assert.deepEqual(
    journal.pending(storage, now).map((entry) => entry.id),
    [first.id],
  );
});
