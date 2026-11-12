const { Uint32Array } = globalThis;
const {
  ownedBytes,
  retainValueBytes,
  readValueBytes,
} = require('../../infrastructure/retained-value-bytes138.cjs');
const { readCabinetSnapshot } = require('../../infrastructure/cabinet-read-snapshot.cjs');
const { fail } = require('../../../shared/errors.cjs');
const {
  patientNameParts,
  patientSearchText,
  normalizePatientSearchQuery,
} = require('../../../shared/patient-names.cjs');
const { zonedClock } = require('../../../shared/time-zone.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const cache = new Map(),
  collator = new Intl.Collator('ru', { sensitivity: 'base' });
const MAX_ROWS = 50000,
  MAX_ENTRIES = 256;
const searchValues = new globalThis.WeakMap();
const retainedEntries = new globalThis.WeakMap();
function removeCached(scope, releaseBudget = true) {
  const entry = cache.get(scope);
  if (!entry) return;
  cache.delete(scope);
  if (releaseBudget) entry.budget?.remove(entry);
  for (const collection of [entry.views, entry.sorted]) {
    for (const value of collection.values()) entry.budget?.remove(value.token);
    collection.clear();
  }
}
function eviction(entry) {
  const scope = entry.scope;
  return () => {
    if (cache.get(scope) === entry) removeCached(scope, false);
  };
}
function decodedRows(entry) {
  const stored = readValueBytes(entry.data);
  stored.rows.forEach((row, index) => searchValues.set(row, stored.search[index]));
  return stored.rows;
}
function expose(entry, rows = null) {
  if (!rows) rows = decodedRows(entry);
  const value = {
    scope: entry.scope,
    revision: entry.revision,
    encode: entry.encode,
    rows,
  };
  retainedEntries.set(value, entry);
  return value;
}
function derived(entry, collection, key, indices, limit, counts = null) {
  const value = {
    token: {},
    indices: Uint32Array.from(indices),
    ...(counts ? { counts: { ...counts } } : {}),
  };
  if (cache.get(entry.scope) !== entry) return value;
  if (collection.size >= limit) {
    const oldest = collection.keys().next().value;
    entry.budget?.remove(collection.get(oldest).token);
    collection.delete(oldest);
  }
  const bytes = value.indices.byteLength + Buffer.byteLength(key) + 128;
  const release = () => {
    if (collection.get(key) === value) collection.delete(key);
  };
  if (!entry.budget || entry.budget.retain(value.token, bytes, release, entry.encode)) {
    // Admission can evict the parent or an older derivative. Never resurrect it.
    if (cache.get(entry.scope) === entry) collection.set(key, value);
    else entry.budget?.remove(value.token);
  }
  return value;
}
function searchValue(row) {
  let value = searchValues.get(row);
  if (!value) {
    value = { names: patientNameParts(row), text: patientSearchText(row) };
    searchValues.set(row, value);
  }
  return value;
}
function cachedSearchText(row) {
  return searchValue(row).text;
}
function parameters(url, timeZone = 'Europe/Moscow') {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase(),
    sort = url.searchParams.get('sort') || 'first',
    filter = url.searchParams.get('filter') || 'all',
    today = url.searchParams.get('today') || zonedClock(new Date(), timeZone).date,
    limit = Number(url.searchParams.get('limit') || 60);
  if (
    q.length > 160 ||
    !['first', 'last'].includes(sort) ||
    !['all', 'recent', 'inactive', 'appointment'].includes(filter) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(today) ||
    !Number.isFinite(Date.parse(today)) ||
    new Date(today).toISOString().slice(0, 10) !== today ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw fail(400, 'Неверные параметры поиска клиентов.');
  return { q, sort, filter, today, limit };
}
function cachedRows(storage, current, snapshot) {
  const revision = snapshot ? snapshot.revision : storage.get('revision', 0),
    scope = JSON.stringify([
      storage.filename,
      current.organizationId,
      current.role,
      current.role === 'cosmetologist' ? current.accountId : '*',
    ]);
  let entry = cache.get(scope);
  const identity = storage.readCacheIdentity || storage.encode;
  const cacheVersion = storage.readCacheVersion ?? revision;
  const previous = entry?.encode === identity ? entry : null;
  if (
    previous &&
    previous.revision === revision &&
    previous.cacheVersion === cacheVersion &&
    Date.now() - previous.created < 120000
  ) {
    cache.delete(scope);
    cache.set(scope, previous);
    previous.budget?.touch(previous);
    return expose(previous);
  }
  for (const [id, value] of cache)
    if (id === scope || Date.now() - value.created >= 120000) removeCached(id);
  const encoded = new Map(),
    priorRows =
      !snapshot?.directory && previous
        ? new Map(decodedRows(previous).map((row) => [row.id, row]))
        : null;
  const rows = snapshot?.directory
    ? snapshot.directory
    : storage.indexes.summaryRows(current).map(({ patient_id: id, value }) => {
        const prior = previous?.encoded.get(id),
          row =
            prior?.equals(value) && priorRows?.has(id) ? priorRows.get(id) : storage.decode(value);
        encoded.set(id, ownedBytes(value));
        return row;
      });
  entry = {
    scope,
    revision,
    data: retainValueBytes({ rows, search: rows.map(searchValue) }),
    rowCount: rows.length,
    encoded,
    encode: identity,
    cacheVersion,
    created: Date.now(),
    views: new Map(),
    sorted: new Map(),
    day: null,
    budget: storage.readCacheBudget,
  };
  const maxRows = storage.readCacheBudget?.directoryMaxRows === 150000 ? 150000 : MAX_ROWS;
  let size = rows.length;
  for (const value of cache.values()) size += value.rowCount;
  while (cache.size && (cache.size >= MAX_ENTRIES || size > maxRows)) {
    const oldest = cache.keys().next().value;
    size -= cache.get(oldest).rowCount;
    removeCached(oldest);
  }
  if (size <= maxRows) {
    const retainedBytes =
      entry.data.byteLength +
      Buffer.byteLength(scope) +
      256 +
      [...encoded].reduce(
        (sum, [id, value]) => sum + value.byteLength + Buffer.byteLength(id) + 32,
        0,
      );
    if (!entry.budget || entry.budget.retain(entry, retainedBytes, eviction(entry), identity))
      cache.set(scope, entry);
  }
  return expose(entry, rows);
}
function viewFor(entry, params) {
  const key = JSON.stringify([params.q, params.sort, params.filter, params.today]);
  const retained = retainedEntries.get(entry);
  if (retained.views.has(key)) {
    const view = retained.views.get(key);
    retained.views.delete(key);
    retained.views.set(key, view);
    retained.budget?.touch(view.token);
    return {
      rows: Array.from(view.indices, (index) => entry.rows[index]),
      counts: { ...view.counts },
    };
  }
  const dateAgo = (days) =>
      new Date(Date.parse(params.today + 'T00:00:00Z') - days * 86400000)
        .toISOString()
        .slice(0, 10),
    recent = dateAgo(30),
    inactive = dateAgo(90);
  const hasPastAppointmentSince = (p, from) =>
    (p.appointments || []).some(
      (a) => isActiveAppointment(a) && a.date >= from && a.date <= params.today,
    );
  const matches = (p, filter) =>
    filter === 'appointment'
      ? (p.appointments || []).some((a) => a.date >= params.today)
      : filter === 'recent'
        ? Boolean(
            (p.lastVisit?.date && p.lastVisit.date >= recent && p.lastVisit.date <= params.today) ||
            hasPastAppointmentSince(p, recent),
          )
        : filter === 'inactive'
          ? (!p.lastVisit?.date || p.lastVisit.date < inactive) &&
            !hasPastAppointmentSince(p, inactive)
          : true;
  if (retained.day?.today !== params.today) {
    const counts = {
      all: entry.rows.length,
      appointment: 0,
      recent: 0,
      inactive: 0,
    };
    for (const row of entry.rows)
      for (const filter of ['appointment', 'recent', 'inactive'])
        if (matches(row, filter)) counts[filter]++;
    retained.day = { today: params.today, counts };
  }
  let order = retained.sorted.get(params.sort)?.indices;
  if (!order) {
    const sorted = Array.from({ length: entry.rows.length }, (_, index) => index).sort((ai, bi) => {
      const a = entry.rows[ai],
        b = entry.rows[bi];
      const x = searchValue(a).names,
        y = searchValue(b).names;
      if (params.sort === 'last' && Boolean(x.last) !== Boolean(y.last)) return x.last ? -1 : 1;
      return (
        (params.sort === 'last'
          ? collator.compare(x.last, y.last)
          : collator.compare(x.first, y.first)) ||
        (params.sort === 'last'
          ? collator.compare(x.first, y.first)
          : collator.compare(x.last, y.last)) ||
        collator.compare(x.full, y.full) ||
        collator.compare(a.id, b.id)
      );
    });
    order = derived(retained, retained.sorted, params.sort, sorted, 2).indices;
  }
  const terms = normalizePatientSearchQuery(params.q).split(/\s+/).filter(Boolean);
  const indices = Array.from(order).filter((index) => {
    const row = entry.rows[index];
    return (
      matches(row, params.filter) &&
      (!terms.length || terms.every((term) => searchValue(row).text.includes(term)))
    );
  });
  derived(retained, retained.views, key, indices, 8, retained.day.counts);
  return {
    rows: indices.map((index) => entry.rows[index]),
    counts: { ...retained.day.counts },
  };
}
function directoryPage(storage, current, url, snapshot, timeZone = 'Europe/Moscow') {
  const read = () => {
    const entry = cachedRows(storage, current, snapshot);
    if (url.searchParams.get('picker') === '1')
      return {
        revision: entry.revision,
        patients: entry.rows.map(({ id, name, phone }) => ({
          id,
          name,
          phone,
        })),
      };
    const params = parameters(url, timeZone),
      scope = JSON.stringify([current.accountId, current.role, current.organizationId, params]),
      view = viewFor(entry, params),
      token = url.searchParams.get('cursor');
    let offset = 0;
    if (token) {
      let cursor;
      try {
        if (token.length > 4096) throw Error('cursor');
        cursor = storage.decode(Buffer.from(token, 'base64url'));
      } catch {
        throw fail(400, 'Недействительное продолжение списка.');
      }
      if (cursor.scope !== scope || !Number.isInteger(cursor.offset) || cursor.offset < 0)
        throw fail(400, 'Продолжение не соответствует поиску.');
      if (cursor.revision !== entry.revision)
        throw fail(409, 'Список клиентов изменился. Повторите поиск.');
      offset = cursor.offset;
    }
    const directory = view.rows.slice(offset, offset + params.limit),
      next = offset + directory.length;
    return {
      revision: entry.revision,
      directory,
      total: entry.rows.length,
      matched: view.rows.length,
      counts: view.counts,
      nextCursor:
        next < view.rows.length
          ? storage.encode({ scope, revision: entry.revision, offset: next }).toString('base64url')
          : null,
    };
  };
  if (snapshot) return read();
  return readCabinetSnapshot(storage, read);
}
// Internal summary reader shared with contact matching. It carries the same
// revision, connection/key identity, TTL and global memory bounds as directory.
module.exports = { directoryPage, parameters, cachedRows, cachedSearchText };
