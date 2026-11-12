const { parameters } = require('../../modules/cabinet/directory.cjs');
const { normalizePatientSearchQuery } = require('../../../shared/patient-names.cjs');
const { fail } = require('../../../shared/errors.cjs');
const states = new WeakMap(),
  MAX_BODY = 64 * 1024;
const collator = new Intl.Collator('ru', { sensitivity: 'base' });
function flags196(dates, last, today, recent, inactive) {
  let future = false,
    sinceRecent = false,
    sinceInactive = false;
  for (const day of dates) {
    if (day >= today) future = true;
    if (day <= today && day >= recent) sinceRecent = true;
    if (day <= today && day >= inactive) sinceInactive = true;
  }
  return (
    1 |
    (future ? 2 : 0) |
    ((last && last >= recent && last <= today) || sinceRecent ? 4 : 0) |
    ((!last || last < inactive) && !sinceInactive ? 8 : 0)
  );
}
function createDirectoryDeltaRender196({ base, overlay, revision, timeZone, previous = null }) {
  let inherited = states.get(previous);
  const state = {
    day: inherited?.day ?? null,
    flags: inherited?.flags ?? null,
    counts: inherited ? { ...inherited.counts } : null,
    views: inherited ? inherited.views.map((view) => ({ ...view })) : [],
    positions: inherited?.positions ?? 0,
  };
  inherited = previous = null;
  function prepareDay(today) {
    if (state.day === today) return;
    state.views.length = 0;
    state.positions = 0;
    const recent = new Date(Date.parse(today + 'T00:00:00Z') - 30 * 86400000)
        .toISOString()
        .slice(0, 10),
      inactive = new Date(Date.parse(today + 'T00:00:00Z') - 90 * 86400000)
        .toISOString()
        .slice(0, 10),
      flags = new Uint8Array(base.ids.length),
      counts = { all: base.ids.length, appointment: 0, recent: 0, inactive: 0 };
    for (let i = 0; i < flags.length; i++) {
      flags[i] = flags196(base.dates[i], base.lastDates[i], today, recent, inactive);
      if (flags[i] & 2) counts.appointment++;
      if (flags[i] & 4) counts.recent++;
      if (flags[i] & 8) counts.inactive++;
    }
    state.flags = flags;
    state.counts = counts;
    state.day = today;
  }
  function selection(params, terms, mask) {
    const at = state.views.findIndex(
      (v) => v.q === params.q && v.sort === params.sort && v.filter === params.filter,
    );
    if (at >= 0) {
      const [view] = state.views.splice(at, 1);
      state.views.push(view);
      return view.indices;
    }
    const selected = new Uint32Array(base.ids.length);
    let matched = 0;
    for (const position of base.order[params.sort])
      if (
        state.flags[position] & mask &&
        terms.every((term) => base.texts[position].includes(term))
      )
        selected[matched++] = position;
    while (
      state.views.length &&
      (state.views.length >= 64 || state.positions + matched > 8 * base.ids.length)
    )
      state.positions -= state.views.shift().indices.length;
    const indices = matched === selected.length ? selected : selected.slice(0, matched);
    state.positions += matched;
    state.views.push({ q: params.q, sort: params.sort, filter: params.filter, indices });
    return indices;
  }
  function compare(a, b, sort) {
    if (sort === 'last' && Boolean(a.last) !== Boolean(b.last)) return a.last ? -1 : 1;
    return (
      (sort === 'last' ? collator.compare(a.last, b.last) : collator.compare(a.first, b.first)) ||
      (sort === 'last' ? collator.compare(a.first, b.first) : collator.compare(a.last, b.last)) ||
      collator.compare(a.full, b.full) ||
      collator.compare(a.id, b.id) ||
      a.rank - b.rank
    );
  }
  const rowAt = (i) => ({
    id: base.ids[i],
    first: base.first[i],
    last: base.last[i],
    full: base.full[i],
    json: base.json[i],
    rank: i,
  });
  function render({
    current,
    url,
    cursorCrypto,
    revision: freshRevision = revision,
    proofOnly196 = false,
    expectedSelected196,
  }) {
    if (
      !Number.isSafeInteger(freshRevision) ||
      freshRevision < 0 ||
      ((!proofOnly196 || url.searchParams.get('cursor')) &&
        (!cursorCrypto ||
          typeof cursorCrypto.encode !== 'function' ||
          typeof cursorCrypto.decode !== 'function'))
    )
      return null;
    if (
      expectedSelected196 !== undefined &&
      (!Array.isArray(expectedSelected196) ||
        expectedSelected196.length > 100 ||
        expectedSelected196.some(
          (row) =>
            typeof row?.id !== 'string' ||
            !row.id ||
            row.id.length > 120 ||
            !/^[a-f0-9]{64}$/.test(row.fullHash || ''),
        ))
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
      if (!proofOnly196 && cursor.revision !== freshRevision)
        throw fail(409, 'Список клиентов изменился. Повторите поиск.');
      offset = cursor.offset;
    }
    prepareDay(params.today);
    const recent = new Date(Date.parse(params.today + 'T00:00:00Z') - 30 * 86400000)
        .toISOString()
        .slice(0, 10),
      inactive = new Date(Date.parse(params.today + 'T00:00:00Z') - 90 * 86400000)
        .toISOString()
        .slice(0, 10),
      terms = normalizePatientSearchQuery(params.q).split(/\s+/).filter(Boolean),
      mask = { all: 1, appointment: 2, recent: 4, inactive: 8 }[params.filter],
      indices = selection(params, terms, mask),
      counts = { ...state.counts },
      replacements = [],
      excluded = new Set();
    let matched = indices.length,
      total = base.ids.length;
    for (const [id, item] of overlay) {
      const old = item.position;
      if (old >= 0) {
        excluded.add(old);
        const flags = state.flags[old];
        counts.all--;
        total--;
        if (flags & 2) counts.appointment--;
        if (flags & 4) counts.recent--;
        if (flags & 8) counts.inactive--;
        if (flags & mask && terms.every((term) => base.texts[old].includes(term))) matched--;
      }
      const row = item.row;
      if (row) {
        const flags = flags196(row.dates, row.lastDate, params.today, recent, inactive);
        counts.all++;
        total++;
        if (flags & 2) counts.appointment++;
        if (flags & 4) counts.recent++;
        if (flags & 8) counts.inactive++;
        if (flags & mask && terms.every((term) => row.text.includes(term))) {
          matched++;
          replacements.push({ ...row, rank: item.rank, fullHash: item.fullHash });
        }
      }
    }
    replacements.sort((a, b) => compare(a, b, params.sort));
    let a = 0,
      b = 0,
      rank = 0,
      bytes = 0;
    const selected = [],
      selectedIds = [];
    while (rank < offset + params.limit && (a < indices.length || b < replacements.length)) {
      while (a < indices.length && excluded.has(indices[a])) a++;
      const old = a < indices.length ? rowAt(indices[a]) : null,
        replacement = b < replacements.length ? replacements[b] : null;
      if (!old && !replacement) break;
      let value,
        selectedId,
        selectedPosition = -1,
        selectedHash;
      if (!old || (replacement && compare(replacement, old, params.sort) < 0)) {
        value = replacement.json;
        selectedId = replacement.id;
        selectedHash = replacement.fullHash;
        b++;
      } else {
        value = old.json;
        selectedId = old.id;
        selectedPosition = indices[a];
        a++;
      }
      if (rank++ < offset) continue;
      if (proofOnly196) {
        selectedIds.push(selectedId);
        continue;
      }
      if (expectedSelected196) {
        const proof = expectedSelected196[selected.length];
        if (selectedPosition >= 0)
          selectedHash = base.hashes.toString(
            'hex',
            selectedPosition * 64 + 32,
            selectedPosition * 64 + 64,
          );
        if (!proof || proof.id !== selectedId || proof.fullHash !== selectedHash) return null;
      }
      bytes += Buffer.byteLength(value);
      if (bytes > MAX_BODY) return null;
      selected.push(value);
    }
    if (proofOnly196) return selectedIds;
    if (expectedSelected196 && selected.length !== expectedSelected196.length) return null;
    const next = offset + selected.length,
      nextCursor =
        next < matched
          ? cursorCrypto
              .encode({ scope, revision: freshRevision, offset: next })
              .toString('base64url')
          : null,
      header = JSON.stringify({
        revision: freshRevision,
        directory: null,
        total,
        matched,
        counts,
        nextCursor,
      }),
      serialized = header.replace(
        '"directory":null',
        () => '"directory":[' + selected.join(',') + ']',
      );
    return Buffer.byteLength(serialized) <= MAX_BODY ? serialized : null;
  }
  states.set(render, state);
  return render;
}
module.exports = { createDirectoryDeltaRender196 };
