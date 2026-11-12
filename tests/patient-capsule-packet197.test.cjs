const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPatientHistoryReader,
} = require('../src/server/infrastructure/patient-history-read145.cjs');
const {
  catalog197,
  patientCapsuleSources197,
  sourceSQL197,
  bodySQL197,
} = require('../src/server/infrastructure/postgres/patient-capsule-plan197.cjs');
const {
  functionBody197,
  ARG_TYPES,
  RETURN_COLUMNS,
} = require('../src/server/infrastructure/postgres/patient-capsule-sql197.cjs');
const {
  parsePatientCapsule197,
  selection197,
} = require('../src/server/infrastructure/postgres/patient-capsule-query197.cjs');
const hash = 'a'.repeat(64),
  account = '00000000-0000-4000-8000-000000000001',
  org = '00000000-0000-4000-8000-000000000002',
  session = '00000000-0000-4000-8000-000000000003';
function fixture(kind = 'card') {
  const expected = {
    pVersion: 19,
    pHash: hash,
    cVersion: 2,
    cHash: hash,
    accountId: account,
    organizationId: org,
    sessionId: session,
    role: 'owner',
    generation: { epoch: session, digest: hash },
    selection: selection197({ kind, id: 'patient', appointmentId: 'appointment', audience: '*' }),
  };
  const authority = {
    fence_locked: true,
    id: session,
    account_id: account,
    organization_id: org,
    expires_at: '2000000000000',
    global_admin: 0,
    account_status: 'active',
    membership_role: 'owner',
    membership_status: 'active',
    organization_status: 'active',
  };
  const guard = {
    section197: 'guard197',
    payload197: {
      locked: true,
      released: true,
      snapshot: '100:101:',
      version: 19,
      catalog_hash: hash,
      catalog_matches: true,
      cabinetCatalog: { version: 2, hash, matches: true },
      componentEpoch: session,
      componentDigest: hash,
      reason: 'ready',
      patientPageEmpty165: true,
      provenanceBound: { rows: 0, bytes: 0 },
      authority,
    },
    cipher197: null,
    account197: Buffer.from('synthetic account'),
    session197: Buffer.from('synthetic session'),
  };
  const sourceCount = kind === 'appointment' ? 3 : 5;
  const sources = Array.from({ length: sourceCount }, (_, source) => ({
    section197: 'source197',
    payload197: { source, rows: 1, bytes: 128, witness: kind === 'appointment' ? null : hash },
    cipher197: null,
    account197: null,
    session197: null,
  }));
  const payload197 =
    kind === 'appointment'
      ? { bucket: 'profile', id: 'patient' }
      : {
          bucket: 'profile',
          id: 'patient',
          patient_id: null,
          kind: null,
          position: null,
          audience: null,
          stream: null,
          rank: null,
          source_hash: null,
          witness_kind: null,
          witness_id: null,
        };
  return {
    expected,
    rows: [
      guard,
      ...sources,
      {
        section197: 'body197',
        payload197,
        cipher197: Buffer.from('synthetic profile'),
        account197: null,
        session197: null,
      },
    ],
  };
}
test('197 source descriptors exactly preserve canonical history selections and bounded source SQL', () => {
  const scope = { kind: 'cabinet', storeId: org },
    operation = { scope, cabinetCatalog: catalog197 };
  for (const role of ['owner', 'cosmetologist'])
    for (const kind of ['card', 'history', 'upcoming']) {
      const current = { accountId: account, sessionId: session, organizationId: org, role };
      const reader = createPatientHistoryReader({
        db: { catalog: catalog197 },
        schemaVersion: 2,
        hash: () => hash,
        decode() {
          throw Error('no cursor supplied');
        },
      });
      const url = new URL(
        'http://localhost/api/cabinet/patient' +
          (kind === 'card' ? '?view=card' : '/' + kind + '?') +
          '&id=patient',
      );
      const parameters = reader.parameters(current, url);
      const selected = {
        kind,
        id: parameters.id,
        audience: role === 'owner' ? '*' : hash,
        cursor: parameters.cursor,
      };
      assert.deepEqual(
        patientCapsuleSources197({
          scope,
          cabinetCatalog: catalog197,
          current,
          selection: selected,
        }),
        reader.sources(operation, current, url),
      );
      assert.equal(/\$\d+/.test(sourceSQL197(kind)), false);
      assert.equal(/\$\d+/.test(bodySQL197(kind)), false);
      assert.match(bodySQL197(kind), /LIMIT 200/);
    }
  assert.match(bodySQL197('appointment'), /cabinet_patient_records/);
  assert.equal(/\$\d+/.test(bodySQL197('appointment')), false);
});
test('197 capsule owns fence handoff, unchanged RR and explicit pre-cipher admission', () => {
  assert.equal(ARG_TYPES.split(',').length, 23);
  assert.equal(RETURN_COLUMNS.split(',').length, 5);
  assert.match(functionBody197, /transaction_isolation'\)<>'repeatable read'/);
  const lock = functionBody197.indexOf('v_locked:=pg_try_advisory_xact_lock_shared'),
    unlock = functionBody197.indexOf('v_released:=pg_advisory_unlock_shared');
  assert.ok(
    lock > 0 && unlock > lock && functionBody197.indexOf('WITH comp AS MATERIALIZED') > unlock,
  );
  assert.ok(
    functionBody197.indexOf("IF v_reason<>'ready' THEN RETURN") <
      functionBody197.indexOf("IF p_kind='card' THEN"),
  );
  assert.match(functionBody197, /CASE WHEN EXISTS\(SELECT 1 FROM e197\) THEN NOT EXISTS/);
  assert.doesNotMatch(functionBody197, /read_scope_versions163|set_config\('cartoteca/);
  assert.match(functionBody197, /sb197.bytes>65536/);
});
test('197 valid history/point packets carry canonical bytes and both fresh catalog guards', () => {
  for (const kind of ['card', 'appointment']) {
    const f = fixture(kind),
      p = parsePatientCapsule197(f.rows, f.expected);
    assert.equal(p.supported, true);
    assert.deepEqual(p.locked, [true]);
    assert.deepEqual(p.released, [true]);
    assert.equal(p.authorityRaw[0].id, session);
    assert.equal(p.rows.length, 1);
    assert.equal(p.rows[0].value, f.rows.at(-1).cipher197);
    assert.deepEqual(p.cabinetCatalog, { version: 2, hash, matches: true });
  }
});
test('197 size/provenance decline transfers guard/source metadata and cannot smuggle a prefetched clinical body', () => {
  for (const reason of ['size', 'provenance']) {
    const f = fixture();
    f.rows[0].payload197.reason = reason;
    const p = parsePatientCapsule197(f.rows.slice(0, -1), f.expected);
    assert.equal(p.supported, false);
    assert.deepEqual(p.rows, []);
    assert.equal(p.sources.length, 5);
    assert.throws(
      () => parsePatientCapsule197(f.rows, f.expected),
      (e) => e.status === 503,
    );
  }
  const f = fixture();
  f.rows[0].payload197.reason = 'size';
  f.rows[1].payload197.rows = 4097;
  f.rows[1].payload197.bytes = 1000000;
  f.rows[1].payload197.witness = null;
  assert.equal(parsePatientCapsule197(f.rows.slice(0, -1), f.expected).sources[0].witness, null);
});
test('197 invalid AUTH/catalog/fence/component is never a compatibility fallback', () => {
  for (const change of [
    (h) => {
      h.reason = 'authority';
    },
    (h) => {
      h.locked = false;
    },
    (h) => {
      h.released = false;
    },
    (h) => {
      h.catalog_matches = false;
    },
    (h) => {
      h.cabinetCatalog.matches = false;
    },
    (h) => {
      h.componentDigest = 'b'.repeat(64);
    },
    (h) => {
      h.authority.membership_role = 'cosmetologist';
    },
  ]) {
    const f = fixture();
    change(f.rows[0].payload197);
    assert.throws(
      () => parsePatientCapsule197(f.rows, f.expected),
      (e) => [403, 503].includes(e.status),
    );
  }
});
test('197 malformed/duplicate/private/oversized source and row data fail closed', () => {
  for (const change of [
    (f) => {
      f.rows[1].payload197.source = 1;
    },
    (f) => {
      f.rows[1].payload197.bytes = 65537;
    },
    (f) => {
      f.rows[1].payload197.witness = 'wrong';
    },
    (f) => {
      f.rows[1].payload197.private = 'no';
    },
    (f) => {
      f.rows.at(-1).payload197.private = 'no';
    },
    (f) => {
      f.rows.at(-1).account197 = Buffer.from('forbidden');
    },
    (f) => {
      f.rows[0].account197 = Buffer.alloc(65537);
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(
      () => parsePatientCapsule197(f.rows, f.expected),
      (e) => e.status === 503,
    );
  }
  assert.throws(() => selection197({ kind: 'card', id: 'x'.repeat(121), audience: '*' }));
  assert.throws(() =>
    selection197({
      kind: 'card',
      id: 'patient',
      audience: '*',
      cursor: { visit: 0, outcome: 0, upcoming: Number.MAX_SAFE_INTEGER },
    }),
  );
});
