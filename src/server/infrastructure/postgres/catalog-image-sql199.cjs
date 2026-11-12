const { identifier } = require('./catalog-sqlite.cjs');
const { createHash } = require('node:crypto');
const hot = require('./hot-metadata-sql169.cjs');
const directory = require('./directory-state-hot-sql196.cjs');
const patient = require('./patient-capsule-sql197.cjs');
const { validateCatalogImageAnchors199, invalid199 } = require('./catalog-image-anchors199.cjs');
const META = 'cartoteca_catalog.catalog_image_component199';
const variants199 = Object.freeze({
  metadata169: Object.freeze({
    oldFunction: hot.FUNCTION,
    functionName: 'cartoteca_catalog.hot_read_metadata199',
    argTypes: hot.ARG_TYPES + ',text,text',
    returnColumns: hot.RETURN_COLUMNS,
  }),
  directory196: Object.freeze({
    oldFunction: directory.FUNCTION196,
    functionName: 'cartoteca_catalog.hot_directory_metadata199',
    argTypes: directory.ARG_TYPES196 + ',text,text',
    returnColumns: directory.RETURN_COLUMNS196,
  }),
  patient197: Object.freeze({
    oldFunction: patient.FUNCTION,
    functionName: 'cartoteca_catalog.patient_read_capsule199',
    argTypes: patient.ARG_TYPES + ',text,text',
    returnColumns: patient.RETURN_COLUMNS,
  }),
});
const parents = { metadata169: hot, directory196: directory, patient197: patient };
const literal199 = (value) =>
  "E'" + JSON.stringify(value).replaceAll('\\', '\\\\').replaceAll("'", "''") + "'::jsonb";
function replaceOnce199(text, before, after) {
  if (text.split(before).length !== 2) throw invalid199();
  return text.replace(before, () => after);
}
function catalogImageAnchor199(kind, anchors) {
  validateCatalogImageAnchors199(anchors);
  const cases = Object.values(anchors)
    .filter((a) => a.kind === kind)
    .sort((a, b) => a.version - b.version)
    .map(
      (a) =>
        `WHEN p_${kind === 'platform' ? 'p' : 'c'}_version=${a.version} AND p_${kind === 'platform' ? 'p' : 'c'}_hash='${a.hash}' THEN ${literal199(a.metadata)}`,
    );
  return cases.length ? `(CASE ${cases.join(' ')} ELSE NULL::jsonb END)` : 'NULL::jsonb';
}
function catalogImagePredicate199(kind) {
  if (!['platform', 'cabinet'].includes(kind)) throw invalid199();
  const anchor = kind === 'platform' ? 'v_p_anchor199' : 'v_c_anchor199';
  // Both CURRENT payloads must equal a JSON-parsed, known-valid anchor. In
  // particular, two identically malformed payloads cannot bypass jsonb_eq's
  // original error. Different valid numeric representations retain its fallback.
  return `CASE WHEN s.metadata IS NULL OR t.metadata IS NULL THEN s.metadata=t.metadata
 WHEN pg_catalog.record_image_eq(ROW(s.metadata),ROW(${anchor})) AND
 pg_catalog.record_image_eq(ROW(t.metadata),ROW(${anchor})) THEN true ELSE s.metadata=t.metadata END`;
}
function catalogImageBody199(variant, anchors) {
  if (!Object.hasOwn(variants199, variant)) throw invalid199();
  validateCatalogImageAnchors199(anchors);
  let body =
    variant === 'metadata169'
      ? hot.functionBody169
      : variant === 'directory196'
        ? directory.functionBody196
        : patient.functionBody197;
  body = replaceOnce199(
    body,
    'DECLARE ',
    `DECLARE v_p_anchor199 jsonb:=${catalogImageAnchor199('platform', anchors)};
 v_c_anchor199 jsonb:=${catalogImageAnchor199('cabinet', anchors)};
 `,
  );
  const comparison = 's.metadata=t.metadata AS matches';
  if (body.split(comparison).length !== 3) throw invalid199();
  body = body.replace(comparison, () => catalogImagePredicate199('platform') + ' AS matches');
  body = body.replace(comparison, () => catalogImagePredicate199('cabinet') + ' AS matches');
  return replaceOnce199(
    body,
    `FROM ${hot.META} m WHERE m.version=1)`,
    `FROM ${hot.META} m WHERE m.version=1 AND EXISTS(SELECT 1 FROM ${META} ci199
 WHERE ci199.version=1 AND ci199.epoch::text=p_catalog_epoch199 AND ci199.digest=p_catalog_digest199))`,
  );
}
function catalogImageDefinition199(variant, role, anchors) {
  const v = variants199[variant];
  if (!v) throw invalid199();
  identifier(role);
  const parent = parents[variant];
  let ddl =
    variant === 'metadata169'
      ? parent.createHotMetadataSQL169(role)
      : variant === 'directory196'
        ? parent.createDirectoryHotSQL196(role)
        : parent.createPatientCapsuleSQL197(role);
  const start = ddl.indexOf(`CREATE FUNCTION ${v.oldFunction}(`);
  if (start < 0) throw invalid199();
  ddl = ddl.slice(start);
  const body =
    variant === 'metadata169'
      ? hot.functionBody169
      : variant === 'directory196'
        ? directory.functionBody196
        : patient.functionBody197;
  const newBody = catalogImageBody199(variant, anchors);
  const tag = '$ct_image199_' + createHash('sha256').update(newBody).digest('hex') + '$';
  if (newBody.includes(tag)) throw invalid199();
  ddl = replaceOnce199(ddl, `AS $body$${body}$body$`, `AS ${tag}${newBody}${tag}`);
  const argumentsEnd = ddl.indexOf(')\n RETURNS TABLE');
  if (argumentsEnd < 0) throw invalid199();
  ddl =
    ddl.slice(0, argumentsEnd) +
    ',p_catalog_epoch199 text,p_catalog_digest199 text' +
    ddl.slice(argumentsEnd);
  ddl = ddl.replaceAll(v.oldFunction, v.functionName);
  const oldTypes = v.argTypes.slice(0, -10);
  // CREATE arguments use names, whereas REVOKE/GRANT use only input types.
  ddl = ddl.replaceAll(`(${oldTypes})`, `(${v.argTypes})`);
  return ddl;
}
function createCatalogImageSQL199(role, anchors, enabled) {
  if (
    !enabled ||
    typeof enabled !== 'object' ||
    Array.isArray(enabled) ||
    Object.keys(enabled).sort().join(',') !== Object.keys(variants199).sort().join(',') ||
    Object.values(enabled).some((v) => typeof v !== 'boolean') ||
    !enabled.metadata169
  )
    throw invalid199();
  return Object.keys(variants199)
    .filter((k) => enabled[k])
    .map((k) => catalogImageDefinition199(k, role, anchors))
    .join('\n');
}
function catalogImageInputs199(variant) {
  if (!Object.hasOwn(variants199, variant)) throw invalid199();
  const v = variants199[variant],
    p = parents[variant];
  const ddl =
    variant === 'metadata169'
      ? p.createHotMetadataSQL169('ct_catalog199_shape')
      : variant === 'directory196'
        ? p.createDirectoryHotSQL196('ct_catalog199_shape')
        : p.createPatientCapsuleSQL197('ct_catalog199_shape');
  const start =
    ddl.indexOf(`CREATE FUNCTION ${v.oldFunction}(`) + `CREATE FUNCTION ${v.oldFunction}(`.length;
  const end = ddl.indexOf(')\n RETURNS TABLE', start);
  if (end < start) throw invalid199();
  return [
    ...ddl
      .slice(start, end)
      .split(',')
      .map((a) => a.trim().split(/\s+/)[0]),
    'p_catalog_epoch199',
    'p_catalog_digest199',
  ];
}
module.exports = {
  META,
  variants199,
  catalogImageInputs199,
  catalogImagePredicate199,
  catalogImageBody199,
  catalogImageDefinition199,
  createCatalogImageSQL199,
};
