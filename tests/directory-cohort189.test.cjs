const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  directoryQuery164,
  directorySources164,
  directoryCohortSources189,
  directoryCohortPreview189,
  directoryCohortBound189,
  directoryCohortQuery189,
  directoryCohortRows189,
} = require('../src/server/infrastructure/postgres/directory-queries164.cjs');
const { incremental185 } = require('./helpers/directory-incremental185-fixture.cjs');
const scope = { kind: 'cabinet', storeId: 'synthetic189' };
const catalog = {
  tables: {
    cabinet_summaries: {
      columns: [
        { name: 'patient_id', type: 'TEXT' },
        { name: 'audience', type: 'TEXT' },
        { name: 'value', type: 'BLOB' },
      ],
    },
    meta: {
      columns: [
        { name: 'key', type: 'TEXT' },
        { name: 'value', type: 'BLOB' },
      ],
    },
  },
};
const projectionKey = (id) =>
  'directory164:' + createHash('sha256').update(id).digest('hex') + ':*';
function numbers({
  summaries = 1500,
  projections = 1500,
  summaryBytes = 1100000,
  projectionBytes = 900000,
  summaryCipher = 700000,
  projectionCipher = 500000,
  ready = true,
} = {}) {
  return [
    {
      source: 0,
      rows: String(summaries),
      bytes: String(summaryBytes),
      cipher_bytes: String(summaryCipher),
      ready,
    },
    {
      source: 1,
      rows: String(projections),
      bytes: String(projectionBytes),
      cipher_bytes: String(projectionCipher),
      ready,
    },
  ];
}
test('189 numeric preview and complete cohort have no per-patient correlated lookup; old164 plans remain available', () => {
  const preview = directoryCohortPreview189(scope, catalog, '*');
  assert.deepEqual(preview.values, ['synthetic189', '*']);
  assert.match(preview.text, /sum\(octet_length\(s.value\)\)/);
  assert.match(preview.text, /AS ready/);
  assert.doesNotMatch(preview.text, /LATERAL|sha256|patient_id\s*=/);
  const cohort = directoryCohortQuery189(scope, '*');
  assert.equal(cohort.maximumRows, 4099);
  assert.equal(cohort.text.split('UNION ALL').length, 3);
  assert.doesNotMatch(cohort.text, /LATERAL|sha256|LIMIT/);
  assert.deepEqual(cohort.values, preview.values);
  const sources = directoryCohortSources189({ scope, cabinetCatalog: catalog }, '*');
  assert.equal(sources.length, 2);
  assert.ok(sources.every((source) => !/sha256|LIMIT|LATERAL/.test(source.where)));
  assert.match(directoryQuery164(scope, 'index', { audience: '*' }).text, /LEFT JOIN LATERAL/);
  assert.match(
    directorySources164({ scope, cabinetCatalog: catalog }, '*')[1].where,
    /LIMIT 1\) IS NULL/,
  );
  assert.throws(() => directoryCohortPreview189(scope, catalog, 'foreign'), { status: 503 });
});
test('189 readiness and independent row/cipher/decoded bounds reject before full-source admission', () => {
  const accepted = directoryCohortBound189(numbers());
  assert.equal(accepted.summary.rows, 1500);
  assert.equal(accepted.projection.rows, 1500);
  assert.equal(Object.isFrozen(accepted.summary), true);
  assert.equal(directoryCohortBound189(numbers({ ready: false })), null);
  assert.equal(directoryCohortBound189(numbers({ summaries: 2049 })), null);
  assert.equal(directoryCohortBound189(numbers({ projections: 2049 })), null);
  assert.equal(
    directoryCohortBound189(
      numbers({ summaryCipher: 1500000, projectionCipher: 900000, summaryBytes: 1600000 }),
    ),
    null,
  );
  assert.equal(directoryCohortBound189(numbers({ summaryBytes: 3000000 })), null);
  for (const mutate of [
    (rows) => {
      rows[0].rows = null;
    },
    (rows) => {
      rows[0].bytes = 'NaN';
    },
    (rows) => {
      rows[1].source = 0;
    },
    (rows) => {
      rows[0].ready = false;
    },
    (rows) => {
      rows[0].cipher_bytes = '999999999999999999999';
    },
  ]) {
    const rows = numbers();
    mutate(rows);
    assert.throws(() => directoryCohortBound189(rows), { status: 503 });
  }
});
test('189 raw-key pairing ignores bounded orphan ciphertext and preserves missing projection fallback', () => {
  const bound = directoryCohortBound189(numbers({ summaries: 2, projections: 2 }));
  const full = Buffer.from('full'),
    projected = Buffer.from('projection');
  const rows = [
    { kind: 'summary', id: 'a', audience: '*', value: full },
    { kind: 'summary', id: 'b', audience: '*', value: full },
    { kind: 'projection-key', id: projectionKey('a'), audience: null, value: projected },
    {
      kind: 'projection-key',
      id: 'directory164:orphan:*',
      audience: null,
      value: Buffer.from([255]),
    },
    { kind: 'meta', id: 'directory164-ready', audience: null, value: Buffer.from('ready') },
  ];
  const selected = directoryCohortRows189(rows, bound, '*');
  assert.equal(selected.rows.find((row) => row.id === 'a').value, projected);
  assert.equal(selected.rows.find((row) => row.id === 'b').kind, 'raw');
  assert.deepEqual(
    selected.full.map((row) => row.id),
    ['a', 'b'],
  );
  assert.throws(() => directoryCohortRows189([...rows, rows[0]], bound, '*'), { status: 503 });
  assert.throws(() => directoryCohortRows189(rows.slice(1), bound, '*'), { status: 503 });
  assert.throws(
    () =>
      directoryCohortRows189(
        rows.map((row, i) => (i ? row : { ...row, audience: 'foreign' })),
        bound,
        '*',
      ),
    { status: 503 },
  );
});
function enableCohort(b, { missing = false, orphan = false, eligibility = true } = {}) {
  const op = b.input.operation,
    owned = new WeakMap();
  let upgraded = false;
  const upgrade = op.requireDirectorySnapshotMemory180;
  op.requireDirectorySnapshotMemory180 = async () => {
    upgraded = true;
    return upgrade();
  };
  op.previewDirectoryCohort189 = async () => {
    b.trace.push('preview189');
    return eligibility ? {} : null;
  };
  op.selectDirectoryCohort189 = async () => {
    assert.equal(upgraded, true, '384 admission precedes all ciphertext');
    b.trace.push('cohort189');
    const raw = [],
      full = [];
    for (const [id, row] of b.records) {
      raw.push({ kind: 'summary', id, audience: '*', value: row.cipher });
      if (!missing || id !== b.f.rows[0].id)
        raw.push({
          kind: 'projection-key',
          id: projectionKey(id),
          audience: null,
          value: row.projection,
        });
      full.push({ bucket: 'summary', id, value: row.cipher });
    }
    if (orphan)
      raw.push({
        kind: 'projection-key',
        id: 'directory164:orphan:*',
        audience: null,
        value: Buffer.from([255]),
      });
    for (const [id, value] of [
      ['directory164-ready', { version: 1 }],
      ['revision', b.expected('limit=1').revision],
      ['initialized', true],
    ])
      raw.push({ kind: 'meta', id, audience: null, value: b.f.crypto.encode(value) });
    const selected = directoryCohortRows189(
      raw,
      {
        summary: { rows: b.records.size },
        projection: { rows: b.records.size - (missing ? 1 : 0) + (orphan ? 1 : 0) },
      },
      '*',
    );
    const token = { rows: selected.rows };
    owned.set(token, full);
    return token;
  };
  op.directoryCohortFull189 = (token) => {
    assert.ok(owned.has(token));
    return owned.get(token);
  };
}
test('189 accepted cold and incremental reads preserve page/HMAC/ACK behavior without a second full query', async () => {
  const b = incremental185();
  try {
    enableCohort(b, { orphan: true });
    b.input.operation.selectView = async () => assert.fail('duplicate full SELECT');
    b.input.operation.selectDirectory164 = async () =>
      assert.fail('old scalar or selected full SELECT');
    assert.deepEqual((await b.read()).body, b.expected());
    assert.equal(b.cache.stats().entries, 0, 'no publication before ACK');
    b.commit();
    const id = b.f.rows[0].id;
    b.change(id, { phone: '+79991890000' });
    b.reset();
    assert.deepEqual((await b.read()).body, b.expected());
    assert.equal(b.counts.full, 1);
    assert.equal(b.counts.projection, 1);
    assert.equal(b.trace.filter((step) => step === 'cohort189').length, 1);
    assert.ok(
      !b.trace.some((step) => ['all-probe', 'selected-probe', 'all-select'].includes(step)),
    );
    b.discard();
    assert.equal(b.cache.hasStamp180(b.f.key, b.input.operation.capturedVersions165()), false);
    b.corruptFull(id);
    b.reset();
    await assert.rejects(b.read(), { status: 503, code: 'CABINET_DIRECTORY_INDEX' });
    assert.equal(b.counts.full, 0);
  } finally {
    b.close();
  }
});
test('189 missing projection uses canonical raw fallback and fresh selected HMAC without another SQL/probe', async () => {
  const b = incremental185();
  try {
    enableCohort(b, { missing: true });
    b.input.operation.selectView = async () => assert.fail('duplicate full SELECT');
    b.input.operation.selectDirectory164 = async () => assert.fail('duplicate legacy SELECT');
    const reply = (await b.read('limit=1')).body,
      expected = b.expected('limit=1');
    assert.deepEqual({ ...reply, nextCursor: null }, { ...expected, nextCursor: null });
    const cursor = b.f.crypto.decode(Buffer.from(reply.nextCursor, 'base64url'));
    assert.equal(cursor.revision, reply.revision);
    assert.equal(cursor.offset, 1);
    assert.ok(!b.trace.some((step) => ['selected-probe', 'all-probe'].includes(step)));
    assert.ok(b.counts.full <= 2, 'unselected projected full rows stay undecoded');
    assert.ok(b.views.stats().entries > 0, 'existing legacy representation retained');
  } finally {
    b.close();
  }
});
test('189 unsupported preview and default/no snapshot keep the existing164 path', async () => {
  for (const snapshots of [false, true]) {
    const b = incremental185();
    try {
      enableCohort(b, { eligibility: false });
      if (!snapshots) b.input.snapshots180 = null;
      assert.equal((await b.read()).status, 200);
      assert.ok(b.trace.includes('index'));
      assert.equal(b.trace.includes('preview189'), snapshots);
      assert.equal(b.trace.includes('cohort189'), false);
    } finally {
      b.close();
    }
  }
});
test('189 picker and unsupported snapshot query never preview or fetch the complete full cohort', async () => {
  for (const query of ['picker=1', 'limit=100&padding189=' + 'x'.repeat(8192)]) {
    const b = incremental185();
    try {
      enableCohort(b);
      assert.equal((await b.read(query)).status, 200);
      assert.equal(b.trace.includes('preview189'), false);
      assert.equal(b.trace.includes('cohort189'), false);
      assert.equal(b.trace.includes('all-probe'), false);
      assert.equal(b.trace.includes('all-select'), false);
      if (query === 'picker=1') assert.equal(b.trace.includes('selected-select'), false);
    } finally {
      b.close();
    }
  }
});
