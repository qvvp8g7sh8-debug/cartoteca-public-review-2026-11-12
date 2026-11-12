const { createHash } = require('node:crypto');
const { createHotMetadataQuery169 } = require('./hot-metadata-query169.cjs');
const { uuid169, hash169 } = require('./hot-metadata-component169.cjs');
const { FUNCTION, MAX_SOURCE_BYTES197, MAX_BODY_ROWS197 } = require('./patient-capsule-sql197.cjs');
const { patientCapsuleSources197, modes } = require('./patient-capsule-plan197.cjs');
const invalid197 = () =>
  Object.assign(Error('Invalid patient capsule197.'), {
    status: 503,
    code: 'POSTGRES_PATIENT_CAPSULE_INVALID',
  });
const id197 = (x) =>
  typeof x === 'string' && x.length >= 1 && x.length <= 120 && Buffer.byteLength(x) <= 360;
function integer197(x) {
  if (!(typeof x === 'number' || (typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x))))
    throw invalid197();
  const n = Number(x);
  if (!Number.isSafeInteger(n) || n < 0) throw invalid197();
  return n;
}
const keys197 = (x, keys) =>
  x &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  JSON.stringify(Object.keys(x).sort()) === JSON.stringify([...keys].sort());
function selection197(value) {
  if (
    !value ||
    !modes.includes(value.kind) ||
    !id197(value.id) ||
    !(value.audience === '*' || hash169(value.audience))
  )
    throw invalid197();
  if (value.kind === 'appointment' && !id197(value.appointmentId)) throw invalid197();
  const cursor = value.cursor || { visit: 0, outcome: 0, upcoming: 0 };
  if (
    !keys197(cursor, ['visit', 'outcome', 'upcoming']) ||
    Object.values(cursor).some(
      (x) => !Number.isSafeInteger(x) || x < 0 || x > Number.MAX_SAFE_INTEGER - 51,
    )
  )
    throw invalid197();
  return Object.freeze({
    kind: value.kind,
    id: value.id,
    appointmentId: value.kind === 'appointment' ? value.appointmentId : null,
    audience: value.audience,
    cursor: Object.freeze({ ...cursor }),
  });
}
function createPatientCapsuleQuery197({ marker, capability, platformTemplate }) {
  if (
    !capability ||
    capability.version !== 1 ||
    !uuid169(capability.epoch) ||
    !hash169(capability.digest) ||
    !capability.hotMetadata169
  )
    throw invalid197();
  const template = platformTemplate?.metadata
    ? { version: platformTemplate.metadata.version, hash: platformTemplate.hash }
    : platformTemplate;
  const metadataQuery = createHotMetadataQuery169({
    marker,
    capability: capability.hotMetadata169,
    platformTemplate: template,
  });
  const generation = Object.freeze({ epoch: capability.epoch, digest: capability.digest });
  return function query({ scope, current, token, selection }) {
    if (
      !current ||
      current.globalAdmin !== false ||
      !uuid169(current.accountId) ||
      !uuid169(current.organizationId) ||
      !uuid169(current.sessionId) ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(current.role) ||
      typeof token !== 'string' ||
      token.length > 4096
    )
      throw invalid197();
    const chosen = selection197(selection);
    if ((current.role === 'cosmetologist') !== (chosen.audience !== '*')) throw invalid197();
    const base = metadataQuery({
      claimedAccountId: current.accountId,
      claimedOrganizationId: current.organizationId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
    });
    if (base.unsupported || base.expected.cVersion !== 2)
      return { unsupported: 'patient-capsule-binding' };
    if (
      scope?.kind !== 'cabinet' ||
      scope.storeId !== base.expected.cabinetStoreId ||
      scope.organizationId !== current.organizationId
    )
      throw invalid197();
    return {
      text: `SELECT * FROM ${FUNCTION}(${Array.from({ length: 23 }, (_, i) => '$' + (i + 1)).join(',')})`,
      values: [
        ...base.values,
        current.sessionId,
        current.role,
        chosen.kind,
        chosen.id,
        chosen.appointmentId,
        chosen.audience,
        ['visit', 'outcome', 'upcoming'].map((k) => chosen.cursor[k]),
        generation.epoch,
        generation.digest,
      ],
      expected: Object.freeze({
        ...base.expected,
        generation,
        sessionId: current.sessionId,
        role: current.role,
        selection: chosen,
      }),
    };
  };
}
const historyFields197 = [
  'bucket',
  'id',
  'patient_id',
  'kind',
  'position',
  'audience',
  'stream',
  'rank',
  'source_hash',
  'witness_kind',
  'witness_id',
];
const authorityFields197 = [
  'fence_locked',
  'id',
  'account_id',
  'organization_id',
  'expires_at',
  'global_admin',
  'account_status',
  'membership_role',
  'membership_status',
  'organization_status',
];
function parsePatientCapsule197(rows, expected) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_BODY_ROWS197 + 6 || !expected)
    throw invalid197();
  const fields = ['section197', 'payload197', 'cipher197', 'account197', 'session197'];
  if (rows.some((row) => !keys197(row, fields))) throw invalid197();
  const first = rows[0],
    h = first.payload197;
  if (
    first.section197 !== 'guard197' ||
    first.cipher197 !== null ||
    !keys197(h, [
      'locked',
      'released',
      'snapshot',
      'version',
      'catalog_hash',
      'catalog_matches',
      'cabinetCatalog',
      'componentEpoch',
      'componentDigest',
      'reason',
      'patientPageEmpty165',
      'provenanceBound',
      'authority',
    ])
  )
    throw invalid197();
  if (
    h.locked !== true ||
    h.released !== true ||
    typeof h.snapshot !== 'string' ||
    !h.snapshot ||
    h.snapshot.length >= 65536 ||
    integer197(h.version) !== expected.pVersion ||
    h.catalog_hash !== expected.pHash ||
    h.catalog_matches !== true ||
    !keys197(h.cabinetCatalog, ['version', 'hash', 'matches']) ||
    integer197(h.cabinetCatalog.version) !== expected.cVersion ||
    h.cabinetCatalog.hash !== expected.cHash ||
    h.cabinetCatalog.matches !== true ||
    h.componentEpoch !== expected.generation.epoch ||
    h.componentDigest !== expected.generation.digest
  )
    throw invalid197();
  if (h.reason === 'authority')
    throw Object.assign(Error('Patient authority changed.'), {
      status: 403,
      code: 'POSTGRES_PATIENT_AUTHORITY197',
    });
  if (
    !['ready', 'size', 'provenance'].includes(h.reason) ||
    typeof h.patientPageEmpty165 !== 'boolean' ||
    !keys197(h.provenanceBound, ['rows', 'bytes']) ||
    !keys197(h.authority, authorityFields197)
  )
    throw invalid197();
  const authority = h.authority;
  if (
    authority.fence_locked !== true ||
    authority.id !== expected.sessionId ||
    authority.account_id !== expected.accountId ||
    authority.organization_id !== expected.organizationId ||
    integer197(authority.global_admin) !== 0 ||
    authority.membership_role !== expected.role ||
    [authority.account_status, authority.membership_status, authority.organization_status].some(
      (x) => x !== 'active',
    ) ||
    integer197(authority.expires_at) < 1 ||
    !Buffer.isBuffer(first.account197) ||
    !Buffer.isBuffer(first.session197) ||
    first.account197.length + first.session197.length > 65536
  )
    throw invalid197();
  const packet = {
    locked: [true],
    released: [true],
    snapshot: h.snapshot,
    version: expected.pVersion,
    catalog_hash: expected.pHash,
    catalog_matches: true,
    cabinetCatalog: { version: expected.cVersion, hash: expected.cHash, matches: true },
    authorityRaw: [
      { ...authority, account_value: first.account197, session_value: first.session197 },
    ],
    supported: h.reason === 'ready',
    reason: h.reason,
    sources: [],
    rows: [],
    patientPageEmpty165: h.patientPageEmpty165,
    provenanceBound: {
      rows: integer197(h.provenanceBound.rows),
      bytes: integer197(h.provenanceBound.bytes),
    },
  };
  const count = expected.selection.kind === 'appointment' ? 3 : 5;
  for (const row of rows.slice(1)) {
    if (row.account197 !== null || row.session197 !== null) throw invalid197();
    if (row.section197 === 'source197') {
      const p = row.payload197;
      if (
        packet.rows.length ||
        row.cipher197 !== null ||
        !keys197(p, ['source', 'rows', 'bytes', 'witness']) ||
        integer197(p.source) !== packet.sources.length ||
        p.source >= count ||
        !(expected.selection.kind === 'appointment'
          ? p.witness === null
          : hash169(p.witness) || (p.witness === null && integer197(p.rows) > 4096))
      )
        throw invalid197();
      packet.sources.push({
        source: p.source,
        rows: integer197(p.rows),
        bytes: integer197(p.bytes),
        witness: p.witness,
      });
    } else if (row.section197 === 'body197') {
      const p = row.payload197;
      if (
        !packet.supported ||
        packet.sources.length !== count ||
        !Buffer.isBuffer(row.cipher197) ||
        !keys197(p, expected.selection.kind === 'appointment' ? ['bucket', 'id'] : historyFields197)
      )
        throw invalid197();
      if (!['profile', 'meta', 'manifest', 'witness', 'entry', 'appointment'].includes(p.bucket))
        throw invalid197();
      const value = { ...p, value: row.cipher197 };
      for (const k of ['position', 'rank'])
        if (value[k] !== null && value[k] !== undefined) value[k] = integer197(value[k]);
      packet.rows.push(value);
    } else throw invalid197();
  }
  const bytes = packet.sources.reduce((s, row) => s + row.bytes, 0),
    n = packet.sources.reduce((s, row) => s + row.rows, 0);
  if (
    packet.sources.length !== count ||
    !Number.isSafeInteger(bytes) ||
    !Number.isSafeInteger(n) ||
    (packet.supported && (bytes > MAX_SOURCE_BYTES197 || n > 1024)) ||
    packet.rows.length > (count === 3 ? 3 : MAX_BODY_ROWS197) ||
    packet.rows.reduce((s, row) => s + row.value.length, 0) > MAX_SOURCE_BYTES197 * 2
  )
    throw invalid197();
  return packet;
}
module.exports = {
  createPatientCapsuleQuery197,
  parsePatientCapsule197,
  patientCapsuleSources197,
  selection197,
  invalid197,
};
