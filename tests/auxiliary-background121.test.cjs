const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createAdminEmailQueue,
  createAdminEmailRuntime,
} = require('../src/server/modules/admin/email-queue.cjs');
const { createSupportRuntime } = require('../src/server/modules/support/delivery.cjs');
const {
  createBookingPublicationRuntime,
} = require('../src/server/modules/booking/publication-runtime.cjs');

function deferredAdmission() {
  const pending = [];
  return {
    pending,
    run(callback, organizationId, active) {
      return new Promise((resolve, reject) =>
        pending.push({ callback, organizationId, active, resolve, reject }),
      );
    },
    next() {
      const item = pending.shift();
      assert.ok(item, 'work must wait for admission');
      try {
        item.resolve(item.callback());
      } catch (error) {
        item.reject(error);
      }
      return item;
    },
  };
}
const turn = () => new Promise(setImmediate);

test('admin email rechecks ownership and generation after delayed admission', async () => {
  for (const revoke of ['ownership', 'stop']) {
    let active = true,
      claims = 0,
      sends = 0;
    const gate = deferredAdmission();
    const runtime = createAdminEmailRuntime({
      queue: {
        claim: () => {
          claims++;
          return null;
        },
      },
      sendMail: () => {
        sends++;
      },
      canRun: () => active,
      runBackgroundWork: gate.run,
    });
    const tick = runtime.tick();
    assert.equal(gate.pending.length, 1);
    if (revoke === 'stop') runtime.stop();
    else active = false;
    assert.equal(gate.next().active(), false);
    await tick;
    assert.equal(claims, 0, 'revoked queued work must not lease a job');
    assert.equal(sends, 0, 'no provider request after revoke');
  }
});

test('admin email commits a known ACK immediately while the next claim awaits admission', async () => {
  const gate = deferredAdmission(),
    results = [];
  let claims = 0;
  const runtime = createAdminEmailRuntime({
    queue: {
      claim: () =>
        ++claims === 1 ? { payload: { email: 'synthetic@example.test' }, kind: 'test' } : null,
      allowed: () => true,
      finish: (_, result) => results.push(result),
    },
    sendMail: async () => {},
    runBackgroundWork: gate.run,
  });
  const tick = runtime.tick();
  gate.next();
  await turn();
  assert.deepEqual(results, ['sent']);
  assert.equal(gate.pending.length, 1, 'the next claim, not ACK settlement, is queued');
  gate.next();
  await tick;
});

test('support lease cannot start after ownership expires while queued', async () => {
  let active = true,
    claims = 0,
    sends = 0;
  const gate = deferredAdmission();
  const runtime = createSupportRuntime({
    store: {
      claim: () => {
        claims++;
        return null;
      },
    },
    telegram: {
      initialize: async () => {},
      send: () => {
        sends++;
      },
    },
    clock: () => 100000,
    canRun: () => active,
    runBackgroundWork: gate.run,
  });
  const tick = runtime.tick();
  await turn();
  active = false;
  gate.next();
  await tick;
  assert.equal(claims, 0);
  assert.equal(sends, 0);
});

test('admin email settles a confirmed ACK after stop without claiming another job', async (t) => {
  const gate = deferredAdmission(),
    results = [];
  let claims = 0,
    sends = 0,
    complete;
  const provider = new Promise((resolve) => {
    complete = resolve;
  });
  const runtime = createAdminEmailRuntime({
    queue: {
      claim: () => {
        claims++;
        return { payload: { email: 'synthetic@example.test' }, kind: 'test' };
      },
      allowed: () => true,
      finish: (_, result) => results.push(result),
    },
    sendMail: () => {
      sends++;
      return provider;
    },
    runBackgroundWork: gate.run,
  });
  t.after(() => runtime.stop());
  const tick = runtime.tick();
  gate.next();
  await turn();
  assert.equal(sends, 1);
  runtime.stop();
  complete();
  await tick;
  assert.deepEqual(results, ['sent']);
  assert.equal(claims, 1);
  assert.equal(gate.pending.length, 0);
});

test('support settles a known provider ACK after its start controller is stopped', async (t) => {
  const gate = deferredAdmission(),
    results = [];
  let claims = 0,
    sends = 0,
    complete;
  const provider = new Promise((resolve) => {
    complete = resolve;
  });
  const runtime = createSupportRuntime({
    store: {
      claim: () => {
        claims++;
        return {
          request_id: 'synthetic-support',
          channel: 'telegram',
          attempts: 1,
          payload: {
            displayName: 'Synthetic',
            email: 'synthetic@example.test',
            description: 'Synthetic',
          },
        };
      },
      finish: (_, result) => results.push(result),
    },
    telegram: {
      initialize: async () => {},
      send: () => {
        sends++;
        return provider;
      },
    },
    clock: () => 100000,
    runBackgroundWork: gate.run,
  });
  t.after(() => runtime.stop());
  runtime.start();
  await turn();
  gate.next();
  await turn();
  assert.equal(sends, 1);
  runtime.stop();
  complete();
  await turn();
  assert.deepEqual(results, ['sent']);
  assert.equal(claims, 1);
  assert.equal(gate.pending.length, 0);
});

test('support manual queued tick cannot claim after stop even without a controller', async () => {
  const gate = deferredAdmission();
  let claims = 0,
    sends = 0;
  const runtime = createSupportRuntime({
    store: {
      claim: () => {
        claims++;
        return null;
      },
    },
    telegram: {
      initialize: async () => {},
      send: () => {
        sends++;
      },
    },
    clock: () => 100000,
    runBackgroundWork: gate.run,
  });
  const tick = runtime.tick();
  await turn();
  runtime.stop();
  assert.equal(gate.next().active(), false);
  await tick;
  assert.equal(claims, 0);
  assert.equal(sends, 0);
});

test('a confirmed provider ACK with a failed success write is never turned into an explicit retry', async () => {
  for (const kind of ['admin', 'support']) {
    const results = [],
      job = {
        request_id: 'synthetic-support',
        channel: 'telegram',
        kind: 'test',
        attempts: 1,
        payload: {
          displayName: 'Synthetic',
          email: 'synthetic@example.test',
          description: 'Synthetic',
        },
      };
    let claims = 0,
      sends = 0;
    const queue = {
      claim: () => {
        claims++;
        return job;
      },
      allowed: () => true,
      finish: (_, status) => {
        results.push(status);
        throw Error('synthetic database write failure after known ACK');
      },
    };
    const send = async () => {
      sends++;
    };
    const runtime =
      kind === 'admin'
        ? createAdminEmailRuntime({ queue, sendMail: send })
        : createSupportRuntime({
            store: queue,
            telegram: { initialize: async () => {}, send },
            clock: () => 100000,
          });
    try {
      await runtime.tick();
      assert.equal(sends, 1, kind);
      assert.equal(claims, 1, kind);
      assert.deepEqual(
        results,
        ['sent'],
        kind + ': a persistence failure is not a provider rejection',
      );
    } finally {
      runtime.stop();
    }
  }
});

test('publication admits each organization separately and retains manual tick compatibility', async () => {
  const gate = deferredAdmission(),
    visits = [];
  const runtime = createBookingPublicationRuntime({
    publication: {
      reconcileBatch(cursor, limit) {
        visits.push({ cursor, limit });
        return { cursor: cursor ? '' : 'next' };
      },
    },
    runBackgroundWork: gate.run,
  });
  const tick = runtime.tickManaged();
  assert.deepEqual(visits, []);
  gate.next();
  await turn();
  assert.deepEqual(visits, [{ cursor: '', limit: 1 }]);
  gate.next();
  await tick;
  assert.deepEqual(visits, [
    { cursor: '', limit: 1 },
    { cursor: 'next', limit: 1 },
  ]);
  runtime.tick();
  assert.deepEqual(visits.at(-1), { cursor: '', limit: 10 });
  runtime.stop();
});

test('publication does not advance cursor or write after revoke or failed admission', async () => {
  let active = true;
  const gate = deferredAdmission(),
    cursors = [];
  const runtime = createBookingPublicationRuntime({
    publication: {
      reconcileBatch(cursor) {
        cursors.push(cursor);
        return { cursor: 'next' };
      },
    },
    canRun: () => active,
    runBackgroundWork: gate.run,
  });
  const stale = runtime.tickManaged();
  active = false;
  gate.next();
  await stale;
  assert.deepEqual(cursors, []);
  active = true;
  const refused = runtime.tickManaged();
  gate.pending.shift().reject(Object.assign(Error('synthetic queue full'), { status: 503 }));
  await assert.rejects(refused, { status: 503 });
  assert.deepEqual(cursors, []);
  const resumed = runtime.tickManaged();
  active = false;
  gate.next();
  await resumed;
  assert.deepEqual(cursors, []);
});

test('publication stop cancels a pending manual managed step and a new explicit tick can resume', async () => {
  const gate = deferredAdmission(),
    visits = [];
  const runtime = createBookingPublicationRuntime({
    publication: {
      reconcileBatch(cursor, limit) {
        visits.push({ cursor, limit });
        return { cursor: '' };
      },
    },
    runBackgroundWork: gate.run,
  });
  const stopped = runtime.tickManaged();
  runtime.stop();
  assert.equal(gate.next().active(), false);
  await stopped;
  assert.deepEqual(visits, []);
  const resumed = runtime.tickManaged();
  gate.next();
  await resumed;
  assert.deepEqual(visits, [{ cursor: '', limit: 1 }]);
  runtime.stop();
});

test('admin email maintenance bounds expired writes while excluding all expired jobs from delivery', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE admin_email_jobs (
    id TEXT PRIMARY KEY, operation_id TEXT, kind TEXT, value TEXT, status TEXT,
    next_at INTEGER, expires_at INTEGER, lease_id TEXT, lease_until INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0, UNIQUE(operation_id,kind)
  )`);
  const insert = db.prepare(
    'INSERT INTO admin_email_jobs(id,operation_id,kind,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,?)',
  );
  for (let i = 0; i < 130; i++)
    insert.run(String(i).padStart(4, '0'), 'expired-' + i, 'test', '{}', 'pending', 0, 1);
  insert.run('live', 'live', 'test', '{}', 'pending', 0, 1000000);
  const queue = createAdminEmailQueue({
    db,
    id: () => 'lease',
    open: JSON.parse,
    seal: JSON.stringify,
    transaction(callback) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  });
  assert.equal(queue.claim(1000).id, 'live');
  const count = () =>
    db.prepare("SELECT count(*) n FROM admin_email_jobs WHERE status='cancelled'").get().n;
  assert.equal(count(), 64);
  assert.equal(queue.claim(1000), null);
  assert.equal(count(), 128);
  assert.equal(queue.claim(1000), null);
  assert.equal(count(), 130);
  assert.equal(
    db.prepare("SELECT status FROM admin_email_jobs WHERE id='live'").get().status,
    'sending',
  );
});
