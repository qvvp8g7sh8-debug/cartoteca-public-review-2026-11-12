const { fail } = require('../../../../shared/errors.cjs');

const DEFAULT_CAPACITY = 100;
const MAX_CAPACITY = 10000;
function dialogueCapacity(value = DEFAULT_CAPACITY) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CAPACITY)
    throw Error('Assistant dialogue capacity must be an integer between 1 and 10000.');
  return value;
}

// A removable expiry heap avoids both full scans and unbounded stale heap nodes.
// Account/session indexes contain only keys owned by that account/session.
function createDialogueRegistry({
  capacity = DEFAULT_CAPACITY,
  now = Date.now,
  capacityError = () =>
    Object.assign(fail(503, 'Помощник занят. Повторите новую команду немного позже.'), {
      code: 'ASSISTANT_DIALOGUE_CAPACITY',
      retryAfter: 2,
      outcomeUnknown: false,
    }),
} = {}) {
  capacity = dialogueCapacity(capacity);
  const rows = new Map(),
    accounts = new Map(),
    sessions = new Map(),
    heap = [];
  let peak = 0,
    rejected = 0,
    expired = 0;
  function swap(a, b) {
    [heap[a], heap[b]] = [heap[b], heap[a]];
    heap[a].position = a;
    heap[b].position = b;
  }
  function bubble(index) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].expiresAt <= heap[index].expiresAt) break;
      swap(parent, index);
      index = parent;
    }
    return index;
  }
  function sink(index) {
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1].expiresAt < heap[child].expiresAt) child++;
      if (heap[index].expiresAt <= heap[child].expiresAt) break;
      swap(index, child);
      index = child;
    }
  }
  function indexAdd(index, value, key) {
    let keys = index.get(value);
    if (!keys) index.set(value, (keys = new Set()));
    keys.add(key);
  }
  function indexDelete(index, value, key) {
    const keys = index.get(value);
    if (!keys) return;
    keys.delete(key);
    if (!keys.size) index.delete(value);
  }
  function remove(key) {
    const row = rows.get(key);
    if (!row) return false;
    rows.delete(key);
    indexDelete(accounts, row.value.accountId, key);
    indexDelete(sessions, row.value.sessionId, key);
    const position = row.position,
      last = heap.pop();
    if (position < heap.length) {
      heap[position] = last;
      last.position = position;
      sink(bubble(position));
    }
    return true;
  }
  function sweep() {
    const instant = now();
    while (heap.length && heap[0].expiresAt <= instant) {
      remove(heap[0].key);
      expired++;
    }
  }
  function rejectCapacity() {
    rejected++;
    throw capacityError();
  }
  function assertCapacity(releasing = 0) {
    if (rows.size - releasing >= capacity) rejectCapacity();
  }
  function assertSessionCapacity(sessionId, limit) {
    if ((sessions.get(sessionId)?.size || 0) >= limit) rejectCapacity();
  }
  function set(key, value) {
    assertCapacity(Number(rows.has(key)));
    if (rows.has(key)) remove(key);
    const row = { key, value, expiresAt: value.expiresAt, position: heap.length };
    rows.set(key, row);
    indexAdd(accounts, value.accountId, key);
    indexAdd(sessions, value.sessionId, key);
    heap.push(row);
    bubble(row.position);
    peak = Math.max(peak, rows.size);
  }
  function forAccount(accountId) {
    return [...(accounts.get(accountId) || [])].map((key) => rows.get(key).value);
  }
  function clearIndex(index, value) {
    for (const key of [...(index.get(value) || [])]) remove(key);
  }
  return {
    get: (key) => rows.get(key)?.value,
    set,
    delete: remove,
    sweep,
    assertCapacity,
    assertSessionCapacity,
    forAccount,
    forSession: (id) => [...(sessions.get(id) || [])].map((key) => rows.get(key).value),
    clearAccount: (id) => clearIndex(accounts, id),
    clearSession: (id) => clearIndex(sessions, id),
    stats() {
      return { active: rows.size, capacity, peak, rejected, expired, expiryEntries: heap.length };
    },
  };
}
module.exports = { createDialogueRegistry, dialogueCapacity, DEFAULT_CAPACITY, MAX_CAPACITY };
