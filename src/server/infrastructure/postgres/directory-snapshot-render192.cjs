const { parameters } = require('../../modules/cabinet/directory.cjs');
const { normalizePatientSearchQuery } = require('../../../shared/patient-names.cjs');
const { fail } = require('../../../shared/errors.cjs');
const renderers = new WeakMap();
const MAX_VIEWS = 64,
  MAX_BODY = 64 * 1024;
// Reserve the complete worst-case private derivative storage before the parent
// index is admitted. No view can grow the shared cache's admitted charge.
function directorySnapshotRenderCharge192(rows) {
  return 2048 + rows + MAX_VIEWS * 1024 + 8 * rows * 4;
}
function createDirectorySnapshotRender192({
  revision,
  timeZone,
  texts,
  lastDates,
  dates,
  order,
  json,
  previous = null,
  oldToNew = null,
}) {
  const total = json.length,
    views = [];
  const state = { day: null, flags: null, counts: null, views, positions: 0 };
  let inherited = renderers.get(previous);
  if (inherited && oldToNew && oldToNew.length === total && inherited.day !== null) {
    state.day = inherited.day;
    state.counts = { ...inherited.counts };
    let identity = true;
    for (let old = 0; old < total; old++) if (oldToNew[old] !== old) identity = false;
    state.flags = identity ? inherited.flags : new Uint8Array(total);
    if (!identity)
      for (let old = 0; old < total; old++) state.flags[oldToNew[old]] = inherited.flags[old];
    for (const view of inherited.views) {
      state.positions += view.indices.length;
      views.push({
        q: view.q,
        sort: view.sort,
        filter: view.filter,
        indices: identity ? view.indices : Uint32Array.from(view.indices, (old) => oldToNew[old]),
      });
    }
  }
  // Retain only derived scalar/typed-array data, never the prior renderer or
  // its clinical strings/closure. Arrays are private and are never mutated.
  inherited = previous = oldToNew = null;
  function prepareDay(today) {
    if (state.day === today) return;
    // One day only, including explicit historical/future days. Discard old
    // derivatives before allocating replacements, rather than retaining a map
    // for every requested date.
    views.length = 0;
    state.positions = 0;
    state.flags = null;
    state.counts = null;
    state.day = null;
    const dateAgo = (days) =>
      new Date(Date.parse(today + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
    const recent = dateAgo(30),
      inactive = dateAgo(90),
      next = new Uint8Array(total),
      totals = { all: total, appointment: 0, recent: 0, inactive: 0 };
    for (let i = 0; i < total; i++) {
      let future = false,
        sinceRecent = false,
        sinceInactive = false;
      for (const value of dates[i]) {
        if (value >= today) future = true;
        if (value <= today) {
          if (value >= recent) sinceRecent = true;
          if (value >= inactive) sinceInactive = true;
        }
      }
      let mask = 1;
      if (future) {
        mask |= 2;
        totals.appointment++;
      }
      if ((lastDates[i] && lastDates[i] >= recent && lastDates[i] <= today) || sinceRecent) {
        mask |= 4;
        totals.recent++;
      }
      if ((!lastDates[i] || lastDates[i] < inactive) && !sinceInactive) {
        mask |= 8;
        totals.inactive++;
      }
      next[i] = mask;
    }
    state.flags = next;
    state.counts = totals;
    state.day = today;
  }
  function selection(params) {
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      if (view.q === params.q && view.sort === params.sort && view.filter === params.filter) {
        views.splice(i, 1);
        views.push(view);
        return view.indices;
      }
    }

    const terms = normalizePatientSearchQuery(params.q).split(/\s+/).filter(Boolean),
      filter = { all: 1, appointment: 2, recent: 4, inactive: 8 }[params.filter],
      selected = new Uint32Array(total);
    let matched = 0;
    for (const i of order[params.sort]) {
      if (!(state.flags[i] & filter)) continue;
      let matches = true;
      for (const term of terms)
        if (!texts[i].includes(term)) {
          matches = false;
          break;
        }
      if (matches) selected[matched++] = i;
    }
    while (views.length && (views.length >= MAX_VIEWS || state.positions + matched > 8 * total))
      state.positions -= views.shift().indices.length;
    // A subarray would retain the complete N-row backing for a one-row match.
    // Keep only matched positions; at most eight full-directory equivalents.
    const indices = matched === total ? selected : selected.slice(0, matched);
    state.positions += matched;
    // q is validated by parameters: <=160 UTF-16 code units. The reserved
    // 1024 bytes per view include its two-byte string, object and array headers.
    views.push({ q: params.q, sort: params.sort, filter: params.filter, indices });
    return indices;
  }
  function render({ current, url, cursorCrypto }) {
    if (
      !cursorCrypto ||
      typeof cursorCrypto.encode !== 'function' ||
      typeof cursorCrypto.decode !== 'function'
    )
      return null;
    const params = parameters(url, timeZone),
      scope = JSON.stringify([current.accountId, current.role, current.organizationId, params]),
      token = url.searchParams.get('cursor');
    let offset = 0;
    if (token) {
      let cursor;
      try {
        if (token.length > 4096) throw Error('cursor');
        cursor = cursorCrypto.decode(Buffer.from(token, 'base64url'));
      } catch {
        throw fail(400, 'Недействительное продолжение списка.');
      }
      if (cursor.scope !== scope || !Number.isInteger(cursor.offset) || cursor.offset < 0)
        throw fail(400, 'Продолжение не соответствует поиску.');
      if (cursor.revision !== revision)
        throw fail(409, 'Список клиентов изменился. Повторите поиск.');
      offset = cursor.offset;
    }
    prepareDay(params.today);
    const indices = selection(params),
      selected = [];
    let bodyBytes = 0;
    const end = Math.min(indices.length, offset + params.limit);
    for (let n = offset; n < end; n++) {
      const value = json[indices[n]];
      bodyBytes += Buffer.byteLength(value);
      if (bodyBytes > MAX_BODY) return null;
      selected.push(value);
    }
    const next = offset + selected.length,
      nextCursor =
        next < indices.length
          ? cursorCrypto.encode({ scope, revision, offset: next }).toString('base64url')
          : null;
    const header = JSON.stringify({
      revision,
      directory: null,
      total,
      matched: indices.length,
      counts: state.counts,
      nextCursor,
    });
    const serialized = header.replace(
      '"directory":null',
      () => '"directory":[' + selected.join(',') + ']',
    );
    return Buffer.byteLength(serialized) <= MAX_BODY ? serialized : null;
  }
  renderers.set(render, state);
  return render;
}
module.exports = { createDirectorySnapshotRender192, directorySnapshotRenderCharge192 };
