const { digest } = require('./catalog-sqlite.cjs');
const { validateRuntimeProfile } = require('./runtime.cjs');
const { invalid199, validateCatalogImageAnchors199 } = require('./catalog-image-anchors199.cjs');
const {
  META,
  variants199,
  catalogImageBody199,
  catalogImageInputs199,
} = require('./catalog-image-sql199.cjs');
const { readCatalogImageSignature199 } = require('./catalog-image-read199.cjs');
const MAX_SIGNATURE_BYTES199 = 8 * 1024 * 1024;
const parentNames = {
  metadata169: 'hotMetadata169',
  directory196: 'directory196',
  patient197: 'patient197',
};
const parentTables = {
  metadata169: 'hot_read_component169',
  directory196: 'directory_state_component196',
  patient197: 'patient_read_component197',
};
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function normalizeParents199(parents) {
  if (
    !parents ||
    typeof parents !== 'object' ||
    Array.isArray(parents) ||
    Object.keys(parents).some((k) => !Object.values(parentNames).includes(k))
  )
    throw invalid199();
  const normalized = {},
    enabled = {};
  for (const [variant, name] of Object.entries(parentNames)) {
    const value = parents[name];
    if (value != null && (!uuid(value.epoch) || !hash(value.digest))) throw invalid199();
    normalized[name] = value == null ? null : { epoch: value.epoch, digest: value.digest };
    enabled[variant] = value != null;
  }
  if (!enabled.metadata169) throw invalid199();
  return { parents: normalized, enabled };
}
function protocol199({ anchors, marker, parents }) {
  validateRuntimeProfile(marker);
  validateCatalogImageAnchors199(anchors);
  const normalized = normalizeParents199(parents);
  // Existing parent SQL keeps its fresh marker/lineage checks. The global
  // catalog adjunct must not pin one platform marker and block later registrations.
  return { version: 1, anchors, ...normalized };
}
async function currentParents199(client, protocol) {
  for (const [variant, name] of Object.entries(parentNames)) {
    if (!protocol.enabled[variant]) continue;
    const rows = (
      await client.query(
        `SELECT epoch::text,digest FROM cartoteca_catalog.${parentTables[variant]} WHERE version=1`,
      )
    ).rows;
    if (
      rows.length !== 1 ||
      rows[0].epoch !== protocol.parents[name].epoch ||
      rows[0].digest !== protocol.parents[name].digest
    )
      throw invalid199();
  }
}
function assertCatalogImageSignature199(value, role) {
  const p = value.protocol,
    s = value.objects,
    keys = Object.keys(variants199).filter((k) => p.enabled[k]);
  if (
    s.definitions.length !== 1 ||
    s.functions.length !== keys.length ||
    s.appRole.length !== 1 ||
    s.appRole[0].rolsuper ||
    s.appRole[0].rolbypassrls ||
    s.appRole[0].schema_create
  )
    throw invalid199();
  const definition = s.definitions[0];
  let ownerName = null;
  for (const key of keys) {
    const v = variants199[key],
      names = catalogImageInputs199(key),
      returns = v.returnColumns.split(',').map((x) => x.trim().split(/\s+/));
    const found = s.functions.filter((f) => f.proname === v.functionName.split('.')[1]);
    if (found.length !== 1) throw invalid199();
    const fn = found[0];
    if (
      fn.prosrc !== catalogImageBody199(key, p.anchors) ||
      fn.pronargs !== names.length ||
      !fn.prosecdef ||
      fn.lanname !== 'plpgsql' ||
      fn.result !== 'record' ||
      !fn.proretset ||
      fn.provolatile !== 'v' ||
      fn.proparallel !== 'u' ||
      fn.proleakproof ||
      fn.proisstrict ||
      fn.member_owner ||
      !fn.app_execute ||
      fn.unexpected_acl ||
      (!fn.owner_super && !fn.owner_bypass) ||
      JSON.stringify(fn.proconfig) !== '["search_path=pg_catalog, pg_temp"]' ||
      fn.input_types.replaceAll(', ', ',') !== v.argTypes ||
      JSON.stringify(fn.proargnames) !== JSON.stringify([...names, ...returns.map((r) => r[0])]) ||
      JSON.stringify(fn.proargmodes) !==
        JSON.stringify([...names.map(() => 'i'), ...returns.map(() => 't')]) ||
      JSON.stringify(fn.all_types) !==
        JSON.stringify([...v.argTypes.split(','), ...returns.map((r) => r[1])]) ||
      (ownerName !== null && ownerName !== fn.owner)
    )
      throw invalid199();
    ownerName = fn.owner;
  }
  if (
    definition.relname !== META.split('.')[1] ||
    definition.relkind !== 'r' ||
    definition.relpersistence !== 'p' ||
    !definition.relrowsecurity ||
    !definition.relforcerowsecurity ||
    definition.owner !== ownerName ||
    definition.member_owner ||
    definition.unexpected_acl ||
    JSON.stringify(definition.privileges) !== '[true,false,false,false,false,false,false]' ||
    JSON.stringify(definition.column_privileges) !== '[true,false,false,false]'
  )
    throw invalid199();
  const structural = s.constraints.filter((c) => c.contype !== 'n');
  if (
    JSON.stringify(s.columns.map((c) => [c.attname, c.type])) !==
      '[["version","bigint"],["epoch","uuid"],["signature","jsonb"],["digest","text"]]' ||
    s.columns.some(
      (c) => !c.attnotnull || c.attidentity || c.attgenerated || c.default_value !== null,
    ) ||
    s.constraints.some((c) => !['p', 'c', 'n'].includes(c.contype)) ||
    structural.length !== 3 ||
    structural.filter((c) => c.contype === 'p').length !== 1 ||
    structural.filter((c) => c.contype === 'c').length !== 2 ||
    s.policies.length !== 2
  )
    throw invalid199();
  const reader = s.policies.find((x) => x.policyname === 'read_catalog_image199'),
    owner = s.policies.find((x) => x.policyname === 'owner_catalog_image199');
  if (
    !reader ||
    !owner ||
    JSON.stringify(reader.roles) !== JSON.stringify([role]) ||
    reader.cmd !== 'SELECT' ||
    reader.qual !== 'true' ||
    reader.with_check !== null ||
    JSON.stringify(owner.roles) !== JSON.stringify([ownerName]) ||
    owner.cmd !== 'ALL' ||
    owner.qual !== 'true' ||
    owner.with_check !== 'true'
  )
    throw invalid199();
}
async function signatureCatalogImage199(client, role, options) {
  const protocol = protocol199(options);
  await currentParents199(client, protocol);
  return { protocol, objects: await readCatalogImageSignature199(client, role) };
}
async function verifyCatalogImage199(client, role, { marker, parents } = {}) {
  const aliases = Object.values(variants199).map((v) => v.functionName.split('.')[1]);
  const present = (
    await client.query(
      `SELECT to_regclass($1)::text component,
    (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='cartoteca_catalog' AND p.proname=ANY($2::text[])) functions`,
      [META, aliases],
    )
  ).rows[0];
  if (!present?.component && present?.functions === 0) return null;
  if (
    !present?.component ||
    !Number.isInteger(present.functions) ||
    present.functions < 1 ||
    present.functions > 3
  )
    throw invalid199();
  const preview = (
    await client.query(
      `SELECT count(*)::integer rows,COALESCE(max(octet_length(signature::text)),0)::bigint bytes FROM ${META}`,
    )
  ).rows[0];
  if (
    preview.rows !== 1 ||
    Number(preview.bytes) < 1 ||
    Number(preview.bytes) > MAX_SIGNATURE_BYTES199
  )
    throw invalid199();
  const rows = (await client.query(`SELECT version,epoch::text,signature,digest FROM ${META}`))
    .rows;
  if (
    rows.length !== 1 ||
    Number(rows[0].version) !== 1 ||
    !uuid(rows[0].epoch) ||
    !hash(rows[0].digest) ||
    !rows[0].signature?.protocol ||
    digest(rows[0].signature) !== rows[0].digest
  )
    throw invalid199();
  const actual = await signatureCatalogImage199(client, role, {
    anchors: rows[0].signature.protocol.anchors,
    marker,
    parents,
  });
  assertCatalogImageSignature199(actual, role);
  if (digest(actual) !== rows[0].digest) throw invalid199();
  return Object.freeze({
    version: 1,
    epoch: rows[0].epoch,
    digest: rows[0].digest,
    variants: Object.freeze({ ...actual.protocol.enabled }),
  });
}
module.exports = {
  MAX_SIGNATURE_BYTES199,
  normalizeParents199,
  signatureCatalogImage199,
  assertCatalogImageSignature199,
  verifyCatalogImage199,
};
