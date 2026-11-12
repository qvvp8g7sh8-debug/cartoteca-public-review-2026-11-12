const { RETURN_COLUMNS } = require('./hot-metadata-sql169.cjs');
const {
  FUNCTION196,
  RETURN_COLUMNS196,
  MAX_SELECTED_BYTES196,
} = require('./directory-state-hot-sql196.cjs');
const { createHotMetadataQuery169, parseHotMetadata169 } = require('./hot-metadata-query169.cjs');
const { head196, validateSelection196 } = require('./directory-read-state196.cjs');
const fields = (text) => text.split(',').map((v) => v.trim().split(/\s+/)[0]);
const legacyFields = fields(RETURN_COLUMNS),
  allFields = fields(RETURN_COLUMNS196).sort();
const bad = () =>
  Object.assign(Error('Invalid hot directory196 proof'), {
    status: 503,
    code: 'POSTGRES_DIRECTORY_STATE196',
  });
function createHotDirectoryQuery196(options) {
  const base = createHotMetadataQuery169(options),
    state = options.directoryState196;
  if (
    state?.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(state.epoch) ||
    !/^[a-f0-9]{64}$/.test(state.digest)
  )
    throw bad();
  return (input) => {
    validateSelection196(input.audience, input.selectedIds);
    const plan = base(input);
    if (plan.unsupported) return plan;
    return {
      text: `SELECT * FROM ${FUNCTION196}(${Array.from({ length: 18 }, (_, i) => '$' + (i + 1)).join(',')})`,
      values: [...plan.values, state.epoch, state.digest, input.selectedIds, input.audience],
      expected: {
        ...plan.expected,
        stateEpoch196: state.epoch,
        stateDigest196: state.digest,
        selectedIds196: [...input.selectedIds],
        audience196: input.audience,
      },
    };
  };
}
function parseHotDirectory196(rows, expected) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    JSON.stringify(Object.keys(rows[0]).sort()) !== JSON.stringify(allFields)
  )
    throw bad();
  const row = rows[0],
    result = parseHotMetadata169(
      [Object.fromEntries(legacyFields.map((k) => [k, row[k]]))],
      expected,
    );
  if (!result.eligible) return { ...result, directory196: null };
  if (row.directory_eligibility196 === 'state-generation') throw bad();
  const reasons = [
    'ready',
    'state-unprepared',
    'audience',
    'revision-size-or-missing',
    'selected-missing',
    'selected-size',
  ];
  if (!reasons.includes(row.directory_eligibility196)) throw bad();
  if (row.directory_eligibility196 !== 'ready') return { ...result, directory196: null };
  if (
    row.directory_component_epoch196 !== expected.stateEpoch196 ||
    row.directory_component_digest196 !== expected.stateDigest196 ||
    row.selected_complete196 !== true ||
    !Buffer.isBuffer(row.cabinet_revision196) ||
    row.cabinet_revision196.length > 65536 ||
    !Array.isArray(row.selected_ids196) ||
    !Array.isArray(row.selected_ciphers196) ||
    row.selected_ids196.length !== expected.selectedIds196.length ||
    row.selected_ciphers196.length !== row.selected_ids196.length
  )
    throw bad();
  const wanted = new Set(expected.selectedIds196),
    selected = [];
  let bytes = 0;
  row.selected_ids196.forEach((id, i) => {
    const value = row.selected_ciphers196[i];
    if (!wanted.delete(id) || !Buffer.isBuffer(value)) throw bad();
    bytes += value.byteLength;
    selected.push({ id, value });
  });
  if (
    wanted.size ||
    bytes > MAX_SELECTED_BYTES196 ||
    String(bytes) !== String(row.selected_bytes196)
  )
    throw bad();
  const head = head196({
    epoch: row.directory_head_epoch196,
    seq: row.directory_seq196,
    floorSeq: row.directory_floor196,
    resetSeq: row.directory_reset196,
  });
  return {
    ...result,
    directory196: { head, revisionCipher: row.cabinet_revision196, selected },
  };
}
module.exports = { createHotDirectoryQuery196, parseHotDirectory196 };
