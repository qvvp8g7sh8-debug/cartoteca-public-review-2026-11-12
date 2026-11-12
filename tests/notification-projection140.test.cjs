const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProjectionSnapshot,
} = require('../src/server/infrastructure/native-projection-snapshot140.cjs');
const {
  createNotificationPolicy,
} = require('../src/server/modules/notifications/notification-policy.cjs');
const {
  createBatchQuery,
} = require('../src/server/modules/notifications/appointment-state-batch.cjs');
function fixture({ bounded = false } = {}) {
  let canonicalReads = 0,
    receiptReads = 0,
    manualReads = 0,
    staffActive = true;
  const db = {
    readIdentity: Object.freeze({}),
    readSnapshotIdentity() {
      this.snapshotVersion();
      return this.readIdentity;
    },
    isOpen: true,
    isTransaction: false,
    transactionIntent: null,
    snapshotVersion: () => 'snapshot',
  };
  const snapshot = createProjectionSnapshot(
    {
      db,
      readOnlySnapshot(work) {
        db.isTransaction = true;
        db.transactionIntent = 'READONLY';
        try {
          return work();
        } finally {
          db.isTransaction = false;
          db.transactionIntent = null;
        }
      },
    },
    true,
  );
  const appointment = {
    id: 'appointment',
    date: '2099-01-01',
    time: '11:00',
    duration: 30,
    service: 'Synthetic',
    staffId: 'staff',
  };
  const source = [{ id: 'patient', appointments: [appointment] }];
  const identity = (a) => ({
    stamp: a.id + ':' + a.time,
    fingerprint: a.time,
    services: 'Synthetic',
  });
  const settings = { timeZone: 'UTC', enabled: true };
  const platform = {
    organization: () => ({ status: 'active' }),
    subscription: () => ({ status: 'active', limits: { automaticNotifications: true } }),
    isProjectionSnapshot: snapshot.contains,
    telegram: {
      settings: () => settings,
      linksMany: () => new Map(),
      confirmedMany: () => new Map(),
    },
    appointmentConfirmations: {
      identity,
      readMany: () => {
        manualReads++;
        return new Map();
      },
    },
  };
  const policy = createNotificationPolicy({
    platform,
    tenantStore: () => ({
      ...(bounded
        ? {
            readAppointment(patientId, appointmentId) {
              canonicalReads++;
              return (
                source
                  .find((p) => p.id === patientId)
                  ?.appointments.find((a) => a.id === appointmentId) || null
              );
            },
          }
        : {}),
      readSelectedAppointments(ids) {
        assert.equal(bounded, false, 'paged canonical checks never hydrate full history');
        canonicalReads++;
        return source.filter((p) => ids.includes(p.id));
      },
    }),
    store: {
      readMany: () => {
        receiptReads++;
        return { receipts: new Map() };
      },
    },
    links: {
      linksMany: () => new Map(),
      membersMany: () =>
        staffActive ? new Map([['staff', { role: 'cosmetologist' }]]) : new Map(),
    },
    providers: {},
    clock: Date.now,
  });
  const response = (patients, proof) => {
    const entries = patients.flatMap((p) =>
      p.appointments.map((a) => ({
        patient: p.id,
        appointment: a.id,
        ...identity(a),
        active: true,
      })),
    );
    return {
      organizationId: 'org',
      zone: 'UTC',
      settings,
      entries,
      receiptEntries: entries,
      sourcePatients: patients,
      readSnapshot: proof,
      manual: new Map(),
      legacy: new Map(),
      receipts: new Map(),
    };
  };
  return {
    snapshot,
    source,
    policy,
    response,
    counts: () => ({ canonicalReads, receiptReads, manualReads }),
    revokeStaff: () => {
      staffActive = false;
    },
  };
}
test('current canonical calendar rows reuse only their owning opaque snapshot', () => {
  const f = fixture();
  let oldProof;
  f.snapshot.run('org', () => {
    oldProof = f.snapshot.proof();
    const read = f.policy.readContext('org', f.source, f.response(f.source, oldProof));
    assert.equal(read.appointments.get('["patient","appointment"]').time, '11:00');
    assert.deepEqual(f.counts(), { canonicalReads: 0, receiptReads: 0, manualReads: 0 });
  });
  f.policy.readContext('org', f.source, f.response(f.source, oldProof));
  assert.equal(f.counts().canonicalReads, 1, 'proof expires before another response');
});
test('historical receipt, forged object, foreign organization and prior root reread canonical rows', () => {
  for (const kind of ['receipt', 'forged', 'foreign', 'prior']) {
    const f = fixture();
    const stale = structuredClone(f.source);
    stale[0].appointments[0].time = '10:00';
    let prior;
    if (kind === 'prior')
      f.snapshot.run('org', () => {
        prior = f.snapshot.proof();
      });
    f.snapshot.run('org', () => {
      const proof =
        kind === 'receipt'
          ? null
          : kind === 'forged'
            ? { organizationId: 'org' }
            : kind === 'prior'
              ? prior
              : f.snapshot.proof();
      const response = f.response(stale, proof);
      if (kind === 'foreign') response.organizationId = 'other';
      const read = f.policy.readContext('org', stale, response);
      assert.equal(read.appointments.get('["patient","appointment"]').time, '11:00');
      assert.equal(f.counts().canonicalReads, 1, kind);
    });
  }
});
test('same-snapshot source rows still require exact receipt stamps and fresh recipient membership', () => {
  const f = fixture();
  f.snapshot.run('org', () => {
    const response = f.response(f.source, f.snapshot.proof());
    response.receiptEntries = response.receiptEntries.map((e) => ({ ...e, stamp: 'stale' }));
    const read = f.policy.readContext('org', f.source, response);
    assert.deepEqual(f.counts(), { canonicalReads: 0, receiptReads: 1, manualReads: 1 });
    assert.ok(f.policy.current('org', 'patient', 'appointment', read));
  });
  f.revokeStaff();
  f.snapshot.run('org', () => {
    const read = f.policy.readContext('org', f.source, f.response(f.source, f.snapshot.proof()));
    assert.equal(f.policy.current('org', 'patient', 'appointment', read), null);
  });
});
test('chunked read descriptors borrow the exact prepared SQL and bound parameters', () => {
  const calls = [],
    reads = [];
  const db = {
    canPrefetchReads: true,
    prepare(sql) {
      return {
        readRequest(method, args) {
          const token = { method, args, sql };
          reads.push(token);
          return token;
        },
        all(...args) {
          calls.push({ sql, args });
          return [{ chunk: JSON.parse(args[1]).length }];
        },
      };
    },
  };
  const query = createBatchQuery(db, 'SELECT value FROM synthetic');
  const entries = Array.from({ length: 401 }, (_, i) => ({ appointment: 'a' + i }));
  assert.equal(query.readRequests('org', entries).length, 3);
  assert.deepEqual(query('org', entries), [{ chunk: 200 }, { chunk: 200 }, { chunk: 1 }]);
  assert.deepEqual(
    reads.map(({ sql, args }) => ({ sql, args })),
    calls,
  );
  db.canPrefetchReads = false;
  assert.deepEqual(query.readRequests('other', entries), []);
  assert.equal(reads.length, 3);
});

test('bounded page canonical validation rereads exact pairs even with forged or stale source rows', () => {
  const f = fixture({ bounded: true }),
    stale = structuredClone(f.source);
  stale[0].appointments[0].time = '10:00';
  const response = { ...f.response(stale, {}), boundedCanonical: true };
  const read = f.policy.readContext('org', stale, response);
  assert.equal(read.appointments.get('["patient","appointment"]').time, '11:00');
  assert.equal(f.counts().canonicalReads, 1);
  const missing = [
    { id: 'patient', appointments: [{ ...stale[0].appointments[0], id: 'missing' }] },
  ];
  assert.equal(
    f.policy.readContext('org', missing, { ...f.response(missing, {}), boundedCanonical: true })
      .appointments.size,
    0,
  );
  assert.equal(f.counts().canonicalReads, 2);
});
