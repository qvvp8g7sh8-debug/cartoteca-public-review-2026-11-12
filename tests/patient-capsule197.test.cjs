const test = require('node:test');
const assert = require('node:assert/strict');
const { patientCapsuleFixture197 } = require('./helpers/patient-capsule197-fixture.cjs');
const {
  preparePatientCapsule197,
  patientCapsule197,
  projectPatientCapsule197,
} = require('../src/server/infrastructure/postgres/read-patient-capsule197.cjs');
const {
  readPatientPage164,
} = require('../src/server/infrastructure/postgres/read-patient-page164.cjs');

const selection = (f, url = f.url(), current = f.current) =>
  preparePatientCapsule197({
    url,
    current,
    crypto: f,
    catalog: f.catalog,
  });
function canonical(value, f) {
  if (Array.isArray(value)) return value.map((v) => canonical(v, f));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      key === 'nextCursor' && v ? f.decode(Buffer.from(v, 'base64url')) : canonical(v, f),
    ]),
  );
}

test('197 pure preparation uses canonical identity/cursor rules and declines unsupported routes before a packet', (t) => {
  const f = patientCapsuleFixture197(t);
  f.reset();
  assert.deepEqual(selection(f), {
    kind: 'card',
    id: 'patient',
    appointmentId: null,
    audience: '*',
    cursor: { visit: 0, outcome: 0, upcoming: 0 },
  });
  assert.equal(
    f.decoded(),
    0,
    'no clinical value is decrypted while preparing the closed selection',
  );
  const edit = f.url(undefined, { view: 'appointment', appointmentId: 'a-3' });
  assert.equal(selection(f, edit).appointmentId, 'a-3');
  edit.searchParams.set('details', '1');
  assert.equal(selection(f, edit), null);
  assert.equal(selection(f, new URL('/api/cabinet/patient?id=patient', 'http://local.test')), null);
  assert.equal(
    preparePatientCapsule197({
      url: f.url(),
      current: f.current,
      crypto: f,
      catalog: { version: 1 },
    }),
    null,
  );
  assert.throws(() => selection(f, f.url(undefined, { cursor: 'bad-token' })), { status: 400 });
  assert.equal(f.decoded() > 0, true);
});

test('197 admitted packets retain canonical first-page DTO, bounded history/upcoming and all role filtering', (t) => {
  const f = patientCapsuleFixture197(t);
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    const current = { ...f.current, role };
    for (const path of [
      '/api/cabinet/patient',
      '/api/cabinet/patient/history',
      '/api/cabinet/patient/upcoming',
    ]) {
      const url = f.url(path);
      const expected = f.reader.read(current, url);
      f.reset();
      const packet = f.packet(selection(f, url, current));
      const actual = projectPatientCapsule197(packet, f.reader, current, url);
      assert.ok(packet.rows.length <= 199);
      assert.ok(f.decoded() <= 165, 'bounded page proof/decode, not whole history hydration');
      assert.deepEqual(canonical(actual, f), canonical(expected, f));
    }
  }
});

test('197 continuation preserves exact current revision and account/session/mode-bound cursors', (t) => {
  const f = patientCapsuleFixture197(t);
  const first = projectPatientCapsule197(f.packet(selection(f)), f.reader, f.current, f.url());
  const next = f.url('/api/cabinet/patient/history', { cursor: first.history.nextCursor });
  assert.deepEqual(
    canonical(projectPatientCapsule197(f.packet(selection(f, next)), f.reader, f.current, next), f),
    canonical(f.reader.read(f.current, next), f),
  );
  for (const override of [
    { accountId: 'other' },
    { sessionId: 'other' },
    { organizationId: 'other' },
    { role: 'cosmetologist' },
  ]) {
    assert.throws(() => selection(f, next, { ...f.current, ...override }), { status: 400 });
  }
  f.save({ ...f.patient, notes: 'Synthetic changed notes' });
  assert.throws(
    () => projectPatientCapsule197(f.packet(selection(f, next)), f.reader, f.current, next),
    { status: 409 },
  );
});

test('197 packet never bypasses current canonical ciphertext, manifest or staff-witness validation', (t) => {
  const f = patientCapsuleFixture197(t);
  const packet = f.packet(selection(f));
  packet.rows.find((row) => row.bucket === 'entry').source_hash = '0'.repeat(64);
  assert.throws(() => projectPatientCapsule197(packet, f.reader, f.current, f.url()), {
    code: 'CABINET_HISTORY_INDEX',
  });
  const staff = { ...f.current, role: 'cosmetologist' };
  const staffPacket = f.packet(selection(f, f.url(), staff));
  staffPacket.rows = staffPacket.rows.filter((row) => row.bucket !== 'witness');
  assert.throws(() => projectPatientCapsule197(staffPacket, f.reader, staff, f.url()), {
    code: 'CABINET_HISTORY_INDEX',
  });
  const damaged = f.packet(selection(f));
  const profile = damaged.rows.find((row) => row.bucket === 'profile');
  profile.value = Buffer.from(profile.value);
  profile.value[profile.value.length - 1] ^= 1;
  assert.throws(() => projectPatientCapsule197(damaged, f.reader, f.current, f.url()));
});

test('197 private getter accepts only synchronous admitted packets and preserves explicit pre-cipher decline', (t) => {
  const f = patientCapsuleFixture197(t),
    s = selection(f);
  assert.equal(patientCapsule197({}, s), null);
  assert.equal(patientCapsule197({ patientCapsule197: () => null }, s), null);
  for (const value of [undefined, {}, { rows: [] }, Promise.resolve({ rows: [], bound: {} })]) {
    assert.throws(() => patientCapsule197({ patientCapsule197: () => value }, s), {
      code: 'POSTGRES_PATIENT_CAPSULE',
    });
  }
  const packet = f.packet(s);
  assert.equal(patientCapsule197({ patientCapsule197: () => packet }, s), packet);
});

function pageContext(f, packet) {
  const commits = [],
    puts = [],
    calls = [];
  const operation = {
    cabinetCatalog: f.catalog,
    scope: { kind: 'cabinet', storeId: 'synthetic-store' },
    platform: { kind: 'platform', storeId: 'synthetic-platform' },
    platformCatalog: { tables: {} },
    assertActive() {
      calls.push('active');
    },
    patientCapsule197() {
      calls.push('packet');
      return packet;
    },
    afterCommit165(callback) {
      commits.push(callback);
    },
    async probe() {
      calls.push('probe');
      throw Error('unexpected probe');
    },
    async selectView() {
      throw Error('unexpected body SQL');
    },
  };
  const prepared = { ...f, cabinetDb: f.db };
  Object.defineProperty(prepared, 'platform', {
    get() {
      calls.push('platform');
      throw Error('notification branch reached');
    },
  });
  const args = {
    operation,
    prepared,
    current: f.current,
    url: f.url(),
    config: {},
    nativeViews: true,
    cacheKey: 'synthetic-current',
    views: { get: () => null, put: (...values) => puts.push(values) },
    context: { res: {}, json: (_res, status, body) => ({ status, body }) },
  };
  return { args, operation, calls, commits, puts };
}

test('197 empty first-open needs no cache or extra body/probe SQL and publishes only after acknowledged commit', async (t) => {
  const f = patientCapsuleFixture197(t, { upcoming: false });
  const p = pageContext(f, f.packet(selection(f)));
  const reply = await readPatientPage164(p.args);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.patient.notes, f.patient.notes);
  assert.equal(reply.body.upcoming.entries.length, 0);
  assert.equal(p.calls.filter((v) => v === 'packet').length, 1);
  assert.ok(!p.calls.includes('probe') && !p.calls.includes('platform'));
  assert.equal(
    p.puts.length,
    0,
    'a failed/lost COMMIT acknowledgement cannot prime the body cache',
  );
  assert.equal(p.commits.length, 1);
  p.commits[0]();
  assert.equal(p.puts.length, 1);
});

test('197 nonempty cards still require platform/provenance bounds and the existing notification branch', async (t) => {
  const f = patientCapsuleFixture197(t),
    p = pageContext(f, f.packet(selection(f)));
  let decodedBeforeBounds;
  f.reset();
  p.operation.probe = async (sources) => {
    decodedBeforeBounds = f.decoded();
    assert.ok(
      sources.some(
        (source) => source.table === 'meta' && source.where === "s.key LIKE 'booking-accepted:%'",
      ),
    );
    return { sourceBounds: new Map() };
  };
  await assert.rejects(() => readPatientPage164(p.args), /notification branch reached/);
  assert.equal(
    decodedBeforeBounds,
    0,
    'canonical body decrypt follows the unchanged platform compatibility decision',
  );
  assert.ok(f.decoded() > 0);
  assert.ok(p.calls.includes('platform'));
});
