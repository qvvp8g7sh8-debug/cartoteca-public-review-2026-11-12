const { META, HEAD, CHANGES } = require('./directory-state-sql196.cjs');
const { projectionKey } = require('../cabinet-directory-projection164.cjs');
const bad = () =>
  Object.assign(Error('Invalid directory state196'), {
    status: 503,
    code: 'POSTGRES_DIRECTORY_STATE196',
  });
const sequence = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v);
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
function head196(value) {
  if (
    !value ||
    !uuid(value.epoch) ||
    !sequence(value.seq) ||
    !sequence(value.floorSeq) ||
    !sequence(value.resetSeq) ||
    BigInt(value.floorSeq) > BigInt(value.seq) ||
    BigInt(value.resetSeq) > BigInt(value.seq)
  )
    throw bad();
  return Object.freeze({
    epoch: value.epoch,
    seq: value.seq,
    floorSeq: value.floorSeq,
    resetSeq: value.resetSeq,
  });
}
function canAdvance196(state, head) {
  return (
    !!state &&
    state.epoch === head.epoch &&
    sequence(state.seq) &&
    BigInt(state.seq) <= BigInt(head.seq) &&
    BigInt(state.seq) >= BigInt(head.floorSeq) &&
    BigInt(state.seq) >= BigInt(head.resetSeq)
  );
}
function validateSelection196(audience, ids) {
  if (
    !(audience === '*' || /^[a-f0-9]{64}$/.test(audience)) ||
    !Array.isArray(ids) ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !id || id.length > 120)
  )
    throw bad();
}
// Metadata belongs to one physical RR. No cache entry or clinical graph is held
// by this reader; the only state retained here is its immutable logical head.
function createDirectoryReadState196({ capability, scope, sql, selectScope, check }) {
  let captured;
  async function head() {
    check();
    if (!capability) return null;
    if (captured !== undefined) return captured;
    await selectScope(scope);
    const result = await sql(
      `SELECT m.epoch::text component_epoch,m.digest component_digest,
      h.epoch::text epoch,h.seq::text seq,h.floor_seq::text floor_seq,h.reset_seq::text reset_seq
      FROM ${META} m LEFT JOIN ${HEAD} h ON h.store_id=$1 AND h.kind='cabinet'`,
      [scope.storeId],
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0].component_epoch !== capability.epoch ||
      result.rows[0].component_digest !== capability.digest
    )
      throw bad();
    const row = result.rows[0];
    captured =
      row.epoch === null
        ? null
        : head196({
            epoch: row.epoch,
            seq: row.seq,
            floorSeq: row.floor_seq,
            resetSeq: row.reset_seq,
          });
    return captured;
  }
  return {
    directory196: !!capability,
    directoryHead196: head,
    async directoryChanges196(state, audience) {
      validateSelection196(audience, []);
      const current = await head();
      if (!current || !canAdvance196(state, current)) return null;
      if (state.seq === current.seq) return { head: current, identities: [] };
      await selectScope(scope);
      const result = await sql(
        `SELECT identity_digest,min(patient_id) patient_id,
        max(patient_id) patient_id_max,bool_or(summary_changed) summary_changed,
        bool_or(projection_changed) projection_changed FROM ${CHANGES}
        WHERE store_id=$1 AND seq>$2::bigint AND seq<=$3::bigint AND audience=$4
        GROUP BY identity_digest ORDER BY identity_digest COLLATE "C" LIMIT 33`,
        [scope.storeId, state.seq, current.seq, audience],
      );
      if (result.rows.length > 32) return null;
      const identities = result.rows.map((row) => {
        if (
          !/^[a-f0-9]{64}$/.test(row.identity_digest) ||
          row.patient_id !== row.patient_id_max ||
          (row.patient_id !== null &&
            (typeof row.patient_id !== 'string' ||
              !row.patient_id ||
              row.patient_id.length > 120)) ||
          typeof row.summary_changed !== 'boolean' ||
          typeof row.projection_changed !== 'boolean' ||
          !(row.summary_changed || row.projection_changed)
        )
          throw bad();
        return Object.freeze({
          identityDigest: row.identity_digest,
          patientId: row.patient_id,
          summaryChanged: row.summary_changed,
          projectionChanged: row.projection_changed,
        });
      });
      return { head: current, identities };
    },
  };
}
function directorySelectedSources196(operation, audience, ids) {
  validateSelection196(audience, ids);
  return [
    {
      scope: operation.scope,
      catalog: operation.cabinetCatalog,
      table: 'cabinet_summaries',
      where: 's.audience=$2 AND s.patient_id=ANY($3::text[])',
      values: [audience, ids],
    },
    {
      scope: operation.scope,
      catalog: operation.cabinetCatalog,
      table: 'meta',
      where: 's.key=ANY($2::text[])',
      values: [
        [
          ...ids.map((id) => projectionKey(id, audience)),
          'directory164-ready',
          'revision',
          'initialized',
        ],
      ],
    },
  ];
}
function directorySelectedQuery196(scope, audience, ids) {
  validateSelection196(audience, ids);
  return {
    text: `SELECT patient_id id,'summary'::text kind,value FROM cartoteca_cabinet.cabinet_summaries
    WHERE _store_id=$1 AND audience=$2 AND patient_id=ANY($3::text[])
    UNION ALL SELECT key,'meta',value FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key=ANY($4::text[])`,
    values: [
      scope.storeId,
      audience,
      ids,
      [
        ...ids.map((id) => projectionKey(id, audience)),
        'directory164-ready',
        'revision',
        'initialized',
      ],
    ],
    maximumRows: 2 * ids.length + 3,
  };
}
module.exports = {
  head196,
  canAdvance196,
  validateSelection196,
  createDirectoryReadState196,
  directorySelectedSources196,
  directorySelectedQuery196,
};
