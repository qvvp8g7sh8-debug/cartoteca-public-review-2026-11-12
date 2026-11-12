const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  createDirectoryProjectionWriter164,
  encodeProjection,
  projectionKey,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { createIndexReplacement } = require('../src/server/infrastructure/cabinet-index-delta.cjs');
test('196 SQL variant composition preserves dollar-regex literals and a single post-fence query', () => {
  const base = require('../src/server/infrastructure/postgres/hot-metadata-sql169.cjs');
  const before = base.functionBody169;
  const next = require('../src/server/infrastructure/postgres/directory-state-hot-sql196.cjs');
  assert.equal(base.functionBody169, before);
  assert.equal(next.functionBody196.split(' RETURN QUERY\n').length - 1, 1);
  assert.equal(next.ARG_TYPES196.split(',').length, 18);
  assert.ok(next.functionBody196.includes("p_state_digest!~'^[a-f0-9]{64}$'"));
  assert.ok(
    next.functionBody196.indexOf('RETURN QUERY') > next.functionBody196.indexOf('fence_locked:='),
  );
  assert.ok(
    next.functionBody196.indexOf('FROM cartoteca_catalog.hot_read_component169') >
      next.functionBody196.indexOf('RETURN QUERY'),
  );
});
function fixture(t, capability = true) {
  const db = new DatabaseSync(':memory:'),
    key = crypto.randomBytes(32);
  t.after(() => {
    db.close();
    key.fill(0);
  });
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value BLOB NOT NULL)');
  function encode(value) {
    const iv = crypto.randomBytes(12),
      c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]);
  }
  function decode(value) {
    const b = Buffer.from(value),
      c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]).toString('utf8'));
  }
  const hash = (value) => crypto.createHmac('sha256', key).update(value).digest('hex');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('directory164-ready', encode({ version: 1 }));
  const summary = {
    id: 'synthetic196',
    name: 'Synthetic',
    phone: '',
    visitCount: 1,
    lastVisit: { date: '2025-01-01', procedure: 'Synthetic' },
    appointments: [
      { id: 'a', date: '2035-01-01', time: '10:00', service: 'Synthetic', duration: 30 },
    ],
  };
  const cipher = encode(summary),
    pkey = projectionKey(summary.id, '*');
  const put = (value) =>
    db
      .prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(pkey, value);
  put(encodeProjection(summary, '*', cipher, { encode, hash }));
  let reads = 0;
  const prepare = (sql) => {
    reads++;
    const s = db.prepare(sql);
    return {
      get: (...v) => {
        const r = s.get(...v);
        return r?.value ? { ...r, value: Buffer.from(r.value) } : r;
      },
    };
  };
  const writer = createDirectoryProjectionWriter164({
    prepare,
    encode,
    decode,
    hash,
    logicalState196: capability
      ? { version: 1, epoch: '11111111-1111-4111-8111-111111111111', digest: 'a'.repeat(64) }
      : null,
  });
  return { db, writer, summary, cipher, pkey, put, encode, decode, hash, reads: () => reads };
}
test('196 notes-only derived equality authenticates the current pair and retains exact bytes', (t) => {
  const f = fixture(t),
    before = Buffer.from(f.db.prepare('SELECT value FROM meta WHERE key=?').get(f.pkey).value);
  assert.equal(f.writer.logical196, true);
  assert.equal(f.writer.unchanged196(structuredClone(f.summary), '*', f.cipher), true);
  assert.deepEqual(
    Buffer.from(f.db.prepare('SELECT value FROM meta WHERE key=?').get(f.pkey).value),
    before,
  );
  assert.equal(f.writer.unchanged196({ ...f.summary, phone: 'changed' }, '*', f.cipher), false);
});
test('196 missing or stale valid sidecar cannot be preserved as a no-op', (t) => {
  const f = fixture(t);
  f.db.prepare('DELETE FROM meta WHERE key=?').run(f.pkey);
  assert.equal(f.writer.unchanged196(f.summary, '*', f.cipher), false);
  f.put(
    f.encode({
      version: 1,
      id: f.summary.id,
      audience: '*',
      sourceHash: '0'.repeat(64),
      row: { id: f.summary.id },
    }),
  );
  assert.equal(f.writer.unchanged196(f.summary, '*', f.cipher), false);
  const repaired = f.writer.statement(f.summary, '*', f.cipher);
  f.db.prepare(repaired.sql).run(...repaired.args);
  assert.equal(f.writer.unchanged196(f.summary, '*', f.cipher), true);
});
test('196 malformed AES on a candidate equal pair fails closed', (t) => {
  const f = fixture(t),
    row = Buffer.from(f.db.prepare('SELECT value FROM meta WHERE key=?').get(f.pkey).value);
  row[row.length - 1] ^= 1;
  f.put(row);
  assert.throws(
    () => f.writer.unchanged196(f.summary, '*', f.cipher),
    (error) => error.status === 503,
  );
  const bad = Buffer.from(f.cipher);
  bad[bad.length - 1] ^= 1;
  assert.throws(
    () => f.writer.unchanged196(f.summary, '*', bad),
    (error) => error.status === 503,
  );
});
test('196 absent native capability keeps legacy write behavior without extra pair reads', (t) => {
  const f = fixture(t, false),
    n = f.reads();
  assert.equal(f.writer.logical196, false);
  assert.equal(f.writer.unchanged196(f.summary, '*', f.cipher), false);
  assert.equal(f.reads(), n);
  assert.ok(f.writer.statement(f.summary, '*', f.cipher));
});
test('196 general delta preserves verified summaries while still writing changed appointments', () => {
  const calls = [],
    before = { id: 'p', name: 'Synthetic', visits: [], appointments: [{ id: 'a', notes: 'old' }] },
    after = { ...before, appointments: [{ id: 'a', notes: 'new' }] };
  const replace = createIndexReplacement({
    prepare: (sql) => ({ run: (...args) => calls.push(['sql', sql, args]) }),
    remove: () => calls.push(['remove']),
    put: () => calls.push(['put']),
    putSummaries: () => calls.push(['summaries']),
    putAppointments: (p, rows) => calls.push(['appointments', rows]),
    preserveSummaries196: (p) => p.id === 'p',
  });
  replace([after], ['p'], new Map([['p', before]]));
  assert.equal(
    calls.some(
      (row) => row[0] === 'summaries' || (row[0] === 'sql' && row[1].includes('cabinet_summaries')),
    ),
    false,
  );
  assert.deepEqual(calls.find((row) => row[0] === 'appointments')[1], after.appointments);
  const legacy = [];
  createIndexReplacement({
    prepare: () => ({ run: () => legacy.push('delete') }),
    remove: () => {},
    put: () => {},
    putSummaries: () => legacy.push('summary'),
    putAppointments: () => {},
  })([after], ['p'], new Map([['p', before]]));
  assert.ok(legacy.includes('summary'));
});
