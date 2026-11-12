const test = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  validateCatalogImageAnchors199,
  readCatalogImageAnchors199,
} = require('../src/server/infrastructure/postgres/catalog-image-anchors199.cjs');
const {
  META,
  variants199,
  catalogImageInputs199,
  catalogImagePredicate199,
  catalogImageBody199,
  catalogImageDefinition199,
  createCatalogImageSQL199,
} = require('../src/server/infrastructure/postgres/catalog-image-sql199.cjs');
const hot = require('../src/server/infrastructure/postgres/hot-metadata-sql169.cjs');
const dir = require('../src/server/infrastructure/postgres/directory-state-hot-sql196.cjs');
const patient = require('../src/server/infrastructure/postgres/patient-capsule-sql197.cjs');
const anchor = (kind, version, metadata) => ({ kind, version, metadata, hash: digest(metadata) });
const anchors = {
  'platform:19': anchor('platform', 19, { test: "'\\ synthetic", n: 1 }),
  'cabinet:2': anchor('cabinet', 2, { test: 2 }),
};
const invalid = (e) =>
  e?.status === 503 && e.code === 'POSTGRES_CATALOG_IMAGE_COMPONENT_INVALID199';
test('199 anchor parser bounds, hashes and supported versions are mandatory', async () => {
  assert.equal(validateCatalogImageAnchors199(anchors), anchors);
  for (const value of [
    null,
    {},
    { ...anchors, private: {} },
    { 'platform:18': anchors['platform:19'] },
    { 'platform:19': { ...anchors['platform:19'], hash: '0'.repeat(64) } },
  ])
    assert.throws(() => validateCatalogImageAnchors199(value), invalid);
  const huge = anchor('platform', 19, { text: 'x'.repeat(262144) });
  assert.throws(() => validateCatalogImageAnchors199({ 'platform:19': huge }), invalid);
  let calls = 0;
  await assert.rejects(
    readCatalogImageAnchors199({
      async query() {
        calls++;
        return { rows: [{ kind: 'platform', version: '19', bytes: '262145' }] };
      },
    }),
    invalid,
  );
  assert.equal(calls, 1, 'oversize preview must not fetch JSONB');
});
test('199 aliases preserve old bodies except anchored comparisons, declarations and same-snapshot token gate', () => {
  const bodies = {
    metadata169: hot.functionBody169,
    directory196: dir.functionBody196,
    patient197: patient.functionBody197,
  };
  for (const [key, oldBody] of Object.entries(bodies)) {
    const body = catalogImageBody199(key, anchors);
    assert.equal((body.match(/s\.metadata=t\.metadata AS matches/g) || []).length, 0);
    assert.equal((body.match(/record_image_eq/g) || []).length, 4);
    assert.equal(
      (body.match(/SELECT 1 FROM cartoteca_catalog.catalog_image_component199/g) || []).length,
      1,
    );
    if (key !== 'patient197') assert.ok(body.includes("'dependency-invalid'"));
    let restored = body.replace(
      /DECLARE v_p_anchor199 jsonb:=[\s\S]*?\n v_c_anchor199 jsonb:=[\s\S]*?;\n /,
      'DECLARE ',
    );
    for (const kind of ['platform', 'cabinet'])
      restored = restored.replace(
        catalogImagePredicate199(kind) + ' AS matches',
        's.metadata=t.metadata AS matches',
      );
    restored = restored.replace(
      ` AND EXISTS(SELECT 1 FROM ${META} ci199\n WHERE ci199.version=1 AND ci199.epoch::text=p_catalog_epoch199 AND ci199.digest=p_catalog_digest199)`,
      '',
    );
    assert.equal(restored, oldBody, key + ' exact parent restoration');
    const ddl = catalogImageDefinition199(key, 'synthetic199', anchors),
      v = variants199[key];
    assert.ok(ddl.startsWith('CREATE FUNCTION ' + v.functionName + '('));
    assert.ok(
      ddl.includes('REVOKE ALL ON FUNCTION ' + v.functionName + '(' + v.argTypes + ') FROM PUBLIC'),
    );
    assert.ok(
      ddl.includes(
        'GRANT EXECUTE ON FUNCTION ' + v.functionName + '(' + v.argTypes + ') TO "synthetic199"',
      ),
    );
    assert.equal(catalogImageInputs199(key).length, v.argTypes.split(',').length);
    assert.deepEqual(catalogImageInputs199(key).slice(-2), [
      'p_catalog_epoch199',
      'p_catalog_digest199',
    ]);
    assert.equal(ddl.includes('CREATE TABLE'), false);
    assert.equal(ddl.includes('CREATE OR REPLACE'), false);
  }
});
test('199 production169-only variant creates no dependency on directory196 or patient197 functions', () => {
  const ddl = createCatalogImageSQL199('synthetic199', anchors, {
    metadata169: true,
    directory196: false,
    patient197: false,
  });
  assert.equal((ddl.match(/CREATE FUNCTION/g) || []).length, 1);
  assert.equal(ddl.includes('hot_directory_metadata199'), false);
  assert.equal(ddl.includes('patient_read_capsule199'), false);
  assert.throws(
    () =>
      createCatalogImageSQL199('synthetic199', anchors, {
        metadata169: false,
        directory196: false,
        patient197: false,
      }),
    invalid,
  );
  assert.throws(() => catalogImageBody199('untrusted', anchors), invalid);
});
