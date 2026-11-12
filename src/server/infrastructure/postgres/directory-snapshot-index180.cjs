const { patientNameParts, patientSearchText } = require('../../../shared/patient-names.cjs');
const {
  createDirectorySnapshotRender192,
  directorySnapshotRenderCharge192,
} = require('./directory-snapshot-render192.cjs');
const {
  createDirectoryBase196,
  patchDirectorySnapshot196,
  resolveDirectorySnapshot196,
  directorySnapshotInfo196,
  peekDirectorySnapshot196,
} = require('./directory-snapshot-delta196.cjs');
const indexes = new WeakMap();
const reuse185 = new WeakMap(),
  construction185 = new WeakMap();
const FORMAT185 = 1;
const MAX_ROWS = 2048;
const summaryKeys = new Set([
  'id',
  'name',
  'firstName',
  'lastName',
  'middleName',
  'designation',
  'phone',
  'visitCount',
  'lastVisit',
  'appointments',
]);
const appointmentKeys = new Set(['id', 'date', 'time', 'service', 'duration', 'status']);
const collator = new Intl.Collator('ru', { sensitivity: 'base' });
function plain(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).every(
    (key) =>
      typeof key === 'string' && allowed.has(key) && Object.hasOwn(descriptors[key], 'value'),
  );
}
function date(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
function string(value, maximum = 4096) {
  return typeof value === 'string' && value.length <= maximum;
}
function supported(summary) {
  if (
    !plain(summary, summaryKeys) ||
    !string(summary.id, 120) ||
    !summary.id ||
    !Number.isSafeInteger(summary.visitCount) ||
    summary.visitCount < 0 ||
    !Array.isArray(summary.appointments) ||
    summary.appointments.length > 2048
  )
    return false;
  for (const name of ['name', 'firstName', 'lastName', 'middleName', 'designation', 'phone'])
    if (summary[name] !== undefined && !string(summary[name])) return false;
  if (
    summary.lastVisit !== null &&
    (!plain(summary.lastVisit, new Set(['date', 'procedure'])) ||
      !date(summary.lastVisit.date) ||
      (summary.lastVisit.procedure !== undefined && !string(summary.lastVisit.procedure)))
  )
    return false;
  return summary.appointments.every(
    (row) =>
      plain(row, appointmentKeys) &&
      string(row.id, 120) &&
      row.id &&
      date(row.date) &&
      string(row.time, 5) &&
      string(row.service) &&
      Number.isSafeInteger(row.duration) &&
      row.duration > 0 &&
      row.duration <= 1440 &&
      (row.status === undefined || row.status === 'scheduled'),
  );
}
function createDirectorySnapshotIndex180(summaries, { revision, timeZone }) {
  if (
    !Array.isArray(summaries) ||
    summaries.length > MAX_ROWS ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !string(timeZone, 80) ||
    !timeZone
  )
    return null;
  let incremental185 = construction185.get(summaries) || null;
  let prior185 = incremental185?.prior || null;
  const appointmentCounts185 = incremental185 ? new Uint32Array(summaries.length) : null;
  const jsonLengths185 = incremental185 ? new Uint32Array(summaries.length) : null;
  const first = [],
    last = [],
    full = [],
    texts = [],
    lastDates = [],
    dates = [],
    ids = [],
    json = [],
    idSet = new Set(),
    strings = new Map();
  let charge = 2048,
    appointments = 0,
    jsonBytes = 0;
  const keep = (value) => {
    const previous = strings.get(value);
    if (previous !== undefined) return previous;
    strings.set(value, value);
    return value;
  };
  // Shared frozen date arrays cannot be repointed. Seed their backing strings
  // first so changed rows intern equal dates to the already retained strings.
  if (prior185)
    for (const old185 of incremental185.positions)
      if (old185 >= 0) for (const day185 of prior185.dates[old185]) keep(day185);
  for (let position185 = 0; position185 < summaries.length; position185++) {
    const summary = summaries[position185];
    const previous185 = incremental185?.positions[position185] ?? -1;
    if (previous185 >= 0) {
      const id = prior185.ids[previous185];
      if (idSet.has(id)) return null;
      idSet.add(id);
      appointments += prior185.appointmentCounts[previous185];
      jsonBytes += prior185.jsonLengths[previous185];
      if (appointments > 8192 || jsonBytes > 2 * 1024 * 1024) return null;
      ids.push(keep(id));
      first.push(keep(prior185.first[previous185]));
      last.push(keep(prior185.last[previous185]));
      full.push(keep(prior185.full[previous185]));
      texts.push(keep(prior185.texts[previous185]));
      lastDates.push(keep(prior185.lastDates[previous185]));
      dates.push(prior185.dates[previous185]);
      for (const day185 of dates.at(-1)) keep(day185);
      json.push(keep(prior185.json[previous185]));
      appointmentCounts185[position185] = prior185.appointmentCounts[previous185];
      jsonLengths185[position185] = prior185.jsonLengths[previous185];
      charge += 64 + dates.at(-1).length * 16;
      continue;
    }
    if (!supported(summary) || idSet.has(summary.id)) return null;
    idSet.add(summary.id);
    appointments += summary.appointments.length;
    if (appointments > 8192) return null;
    const name = patientNameParts(summary),
      serialized = JSON.stringify(summary);
    const serializedBytes185 = Buffer.byteLength(serialized);
    jsonBytes += serializedBytes185;
    if (incremental185) {
      appointmentCounts185[position185] = summary.appointments.length;
      jsonLengths185[position185] = serializedBytes185;
    }
    if (jsonBytes > 2 * 1024 * 1024) return null;
    ids.push(keep(summary.id));
    first.push(keep(name.first));
    last.push(keep(name.last));
    full.push(keep(name.full));
    texts.push(keep(patientSearchText(summary)));
    lastDates.push(keep(summary.lastVisit?.date || ''));
    const uniqueDates = [...new Set(summary.appointments.map((row) => keep(row.date)))].sort();
    dates.push(Object.freeze(uniqueDates));
    json.push(keep(serialized));
    charge += 64 + uniqueDates.length * 16;
  }
  // JS strings are charged as two-byte storage plus headers, regardless of ASCII
  // compaction; arrays, references, orders and closure metadata are charged too.
  for (const value of strings.values()) charge += 48 + value.length * 2;
  strings.clear();
  idSet.clear();
  charge += 8 * (64 + summaries.length * 16) + 2 * (64 + summaries.length * 4);
  if (incremental185)
    charge +=
      incremental185.hashes.byteLength +
      appointmentCounts185.byteLength +
      jsonLengths185.byteLength +
      512;
  const compare = (sort) => (ai, bi) => {
    if (sort === 'last' && Boolean(last[ai]) !== Boolean(last[bi])) return last[ai] ? -1 : 1;
    return (
      (sort === 'last'
        ? collator.compare(last[ai], last[bi])
        : collator.compare(first[ai], first[bi])) ||
      (sort === 'last'
        ? collator.compare(first[ai], first[bi])
        : collator.compare(last[ai], last[bi])) ||
      collator.compare(full[ai], full[bi]) ||
      collator.compare(ids[ai], ids[bi])
    );
  };
  const order = {};
  let sameOrder185 = Boolean(prior185 && prior185.ids.length === ids.length),
    sameView192 = sameOrder185;
  let oldToNew185 = sameOrder185 ? new Int32Array(ids.length).fill(-1) : null;
  if (sameOrder185) {
    for (let i = 0; i < ids.length; i++) {
      const previous = incremental185.oldPositions[i];
      if (
        previous < 0 ||
        first[i] !== prior185.first[previous] ||
        last[i] !== prior185.last[previous] ||
        full[i] !== prior185.full[previous]
      ) {
        sameOrder185 = false;
        break;
      }
      oldToNew185[previous] = i;
      if (
        texts[i] !== prior185.texts[previous] ||
        lastDates[i] !== prior185.lastDates[previous] ||
        dates[i].length !== prior185.dates[previous].length ||
        dates[i].some((day, n) => day !== prior185.dates[previous][n])
      )
        sameView192 = false;
    }
  }
  for (const sort of ['first', 'last'])
    order[sort] = sameOrder185
      ? Uint32Array.from(prior185.order[sort], (old) => oldToNew185[old])
      : Uint32Array.from(Array.from({ length: summaries.length }, (_, n) => n).sort(compare(sort)));
  for (const values of [first, last, full, texts, lastDates, dates, ids, json])
    Object.freeze(values);
  const total = summaries.length;
  // The owning RR has already proved every current cipher. Derived selections
  // survive a notes/JSON-only change only if complete membership and every
  // search/date/sort input remain equal, with SQL row-order remapping.
  const render = createDirectorySnapshotRender192({
    revision,
    timeZone,
    texts,
    lastDates,
    dates,
    order,
    json,
    previous: sameOrder185 && sameView192 ? prior185.render192 : null,
    oldToNew: sameOrder185 && sameView192 ? oldToNew185 : null,
  });
  charge += directorySnapshotRenderCharge192(total);
  oldToNew185 = null;
  // No decoded full summary graph is retained.
  summaries = null;
  const result = Object.freeze({});
  indexes.set(result, Object.freeze({ rows: total, charge, render, jsonBytes }));
  if (incremental185)
    reuse185.set(result, {
      format: FORMAT185,
      render192: render,
      timeZone,
      ids,
      first,
      last,
      full,
      texts,
      lastDates,
      dates,
      json,
      order,
      hashes: incremental185.hashes,
      appointmentCounts: appointmentCounts185,
      jsonLengths: jsonLengths185,
    });
  incremental185 = prior185 = null;
  return result;
}
function directorySnapshotIndexInfo180(value) {
  return indexes.get(value) || directorySnapshotInfo196(value);
}
function compileRow196(summary) {
  if (!supported(summary)) return null;
  const name = patientNameParts(summary),
    json = JSON.stringify(summary),
    dates = Object.freeze([...new Set(summary.appointments.map((row) => row.date))].sort()),
    row = {
      id: summary.id,
      first: name.first,
      last: name.last,
      full: name.full,
      text: patientSearchText(summary),
      lastDate: summary.lastVisit?.date || '',
      dates,
      json,
      jsonBytes: Buffer.byteLength(json),
      appointments: summary.appointments.length,
    };
  let charge = 1024 + dates.length * 32;
  for (const value of [
    row.id,
    row.first,
    row.last,
    row.full,
    row.text,
    row.lastDate,
    row.json,
    ...dates,
  ])
    charge += 48 + value.length * 2;
  return Object.freeze({ ...row, charge });
}
function createDirectorySnapshotIndex196(index, changes, options) {
  if (!Array.isArray(changes) || !options) return null;
  if (directorySnapshotInfo196(index))
    return patchDirectorySnapshot196(index, changes, { ...options, compile: compileRow196 });
  const data = reuse185.get(index),
    info = indexes.get(index);
  if (!data || !info || data.timeZone !== options.timeZone || changes.length) return null;
  return createDirectoryBase196(data, { ...options, charge: info.charge });
}
function renderDirectorySnapshotProven196(index, input, expected) {
  if (!Array.isArray(expected) || expected.length > 100) return null;
  const info = directorySnapshotInfo196(index);
  return info ? info.render({ ...input, expectedSelected196: expected }) : null;
}
function packedHash185(bytes, position, part) {
  return bytes.toString('hex', position * 64 + part * 32, position * 64 + part * 32 + 32);
}
function directorySnapshotProofs185(index, timeZone) {
  const data = reuse185.get(index);
  if (!data || data.format !== FORMAT185 || data.timeZone !== timeZone) return null;
  return { ids: [...data.ids], hashes: Buffer.from(data.hashes) };
}
// Trusted synchronous producer only. Actual fresh full-cipher HMAC/coverage has
// already been proved in the owning RR; this API never authorizes a cached page.
function createDirectorySnapshotIndex185(
  previousIndex,
  rows,
  { pairs, revision, timeZone, decode },
) {
  if (
    !Array.isArray(rows) ||
    rows.length > MAX_ROWS ||
    !(pairs instanceof Map) ||
    pairs.size !== rows.length ||
    typeof decode !== 'function'
  )
    return null;
  let prior = reuse185.get(previousIndex);
  if (!prior || prior.format !== FORMAT185 || prior.timeZone !== timeZone) prior = null;
  const positions = new Int32Array(rows.length).fill(-1),
    oldPositions = new Int32Array(rows.length).fill(-1);
  const hashes = Buffer.alloc(rows.length * 64),
    input = new Array(rows.length),
    seen = new Set();
  const lookup = new Map(prior ? prior.ids.map((id, i) => [id, i]) : []);
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        pair = pairs.get(row.id);
      if (
        !string(row.id, 120) ||
        !row.id ||
        seen.has(row.id) ||
        !pair ||
        !/^[a-f0-9]{64}$/.test(pair.projection) ||
        !/^[a-f0-9]{64}$/.test(pair.full)
      )
        return null;
      seen.add(row.id);
      Buffer.from(pair.projection, 'hex').copy(hashes, i * 64);
      Buffer.from(pair.full, 'hex').copy(hashes, i * 64 + 32);
      const old = lookup.get(row.id) ?? -1;
      oldPositions[i] = old;
      if (
        old >= 0 &&
        packedHash185(prior.hashes, old, 0) === pair.projection &&
        packedHash185(prior.hashes, old, 1) === pair.full
      )
        positions[i] = old;
      else input[i] = decode(row);
    }
    // A fresh internal array is branded, never raw SQL/cache-owned rows.
    construction185.set(input, { prior, positions, oldPositions, hashes });
    return createDirectorySnapshotIndex180(input, { revision, timeZone });
  } finally {
    construction185.delete(input);
    lookup.clear();
    seen.clear();
    prior = previousIndex = rows = pairs = decode = null;
  }
}
module.exports = {
  createDirectorySnapshotIndex180,
  directorySnapshotIndexInfo180,
  directorySnapshotProofs185,
  createDirectorySnapshotIndex185,
  createDirectorySnapshotIndex196,
  resolveDirectorySnapshot196,
  peekDirectorySnapshot196,
  renderDirectorySnapshotProven196,
};
