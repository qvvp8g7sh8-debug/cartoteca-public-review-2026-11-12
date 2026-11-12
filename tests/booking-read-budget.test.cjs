const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const budgetStore = require('../src/server/infrastructure/booking-read-budget-store.cjs');
const { createBookingPublicLimits } = require('../src/server/modules/booking/public-limits.cjs');
const { migrateBookingReadBudget } = require('../src/server/migrations/001-booking-read-budget.cjs');
const { configuration } = require('../src/server/config.cjs');
const NOW = 1900000000000;
const busy = (e) => e.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(e.errcode & 255);

function fixture(t, { prepare = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-read-budget-'));
  const platformDir = path.join(directory, 'platform'), closers = [];
  const marker = path.join(directory, '.restore-in-progress');
  function track(value, close = () => value.close()) {
    let closed = false;
    const end = () => { if (!closed) { closed = true; close(); } };
    closers.push(end);
    return { value, close: end };
  }
  function migrate(rollback = false) {
    fs.writeFileSync(marker, 'booking-read-budget-preparation-v1');
    try { return migrateBookingReadBudget(platformDir, { rollback }); }
    finally { fs.unlinkSync(marker); }
  }
  function platform(options = {}) { return track(createPlatformStore(platformDir, options)); }
  function context({ enabled = true, shared = false, clock = () => NOW } = {}) {
    const db = createPlatformDatabase(platformDir, { isolatedReadBudgets: enabled, sharedCabinetWrites: shared });
    let readBudget;
    try { readBudget = budgetStore.openBookingReadBudget(db.db, platformDir, enabled); }
    catch (error) { db.closeWriter(); db.db.close(); throw error; }
    const limits = createBookingPublicLimits(db, { readBudget, clock });
    return { ...track({ db, readBudget, limits }, () => { readBudget?.close(); db.closeWriter(); db.db.close(); }) };
  }
  t.after(() => {
    for (const close of closers.reverse()) close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cartoteca-read-budget-/);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  platform().close();
  if (prepare) migrate();
  return { directory, platformDir, marker, platform, context, migrate, track };
}
function rows(db) {
  return db.prepare('SELECT key,failures,window_started,blocked_until FROM login_limits ORDER BY key').all();
}
function count(db, context, scope, value) {
  return db.prepare('SELECT failures FROM login_limits WHERE key=?').get(context.limitKey('booking-budget:' + scope, value))?.failures;
}
function child(source) {
  const process = fork('-e', [source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exit = once(process, 'exit');
  return { process, exit, async stop() { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await exit; } };
}
function nextMessage(worker) {
  return Promise.race([
    once(worker.process, 'message').then(([message]) => message),
    worker.exit.then(() => { throw Error('Synthetic budget worker exited before acknowledgement'); }),
  ]);
}
function imports(platformDir) {
  return `const {createPlatformDatabase}=require(${JSON.stringify(require.resolve('../src/server/infrastructure/platform-database.cjs'))});
    const budgetStore=require(${JSON.stringify(require.resolve('../src/server/infrastructure/booking-read-budget-store.cjs'))});
    const {createBookingPublicLimits}=require(${JSON.stringify(require.resolve('../src/server/modules/booking/public-limits.cjs'))});
    const directory=${JSON.stringify(platformDir)};`;
}

test('isolated read counters leave authority readVersion unchanged; submit still uses authority counters', async (t) => {
  const f = fixture(t), first = f.platform({ isolatedReadBudgets: true }).value;
  const second = f.platform({ isolatedReadBudgets: true }).value;
  const version = first.readVersion();
  await first.bookingPublicLimits.consumeReadAsync('synthetic-address');
  await second.bookingPublicLimits.consumeReadAsync('synthetic-address');
  assert.deepEqual(first.readVersion(), version);
  first.bookingPublicLimits.consume('submit', 'organization', 'synthetic-address', '+79990000000', NOW);
  assert.notDeepEqual(first.readVersion(), version);
  const db = f.track(new DatabaseSync(path.join(f.platformDir, 'platform.sqlite'))).value;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM login_limits WHERE key LIKE 'booking-budget:read-address:%' OR key LIKE 'booking-budget:site-read:%'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM login_limits WHERE key LIKE 'booking-budget:site-write:%'").get().n, 1);
});

test('isolated budget commits while another connection owns the authority writer', async (t) => {
  const f = fixture(t), { db, readBudget, limits } = f.context().value;
  const blocker = f.track(new DatabaseSync(path.join(f.platformDir, 'platform.sqlite'))).value;
  blocker.exec('BEGIN IMMEDIATE');
  try {
    await limits.consumeReadAsync('independent-address');
    assert.equal(count(readBudget.db, db, 'read-address', 'independent-address'), 1);
    assert.equal(blocker.isTransaction, true);
    db.db.exec('PRAGMA busy_timeout=0');
    assert.throws(() => limits.consume('submit', 'organization', 'address', '+79990000000', NOW), busy);
  } finally { blocker.exec('ROLLBACK'); }
});

test('another process shared permission fence does not block read budgets or weaken permission writer guard', { timeout: 15000 }, async (t) => {
  const f = fixture(t), { db, readBudget, limits } = f.context({ shared: true }).value;
  db.db.exec('PRAGMA busy_timeout=0');
  const worker = child(imports(f.platformDir) + `
    const db=createPlatformDatabase(directory,{isolatedReadBudgets:true,sharedCabinetWrites:true});
    db.sharedCabinetCommit(()=>{process.send({held:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);})
      .then(()=>{db.closeWriter();db.db.close();process.exit(0);});`);
  try {
    assert.deepEqual(await nextMessage(worker), { held: true });
    await limits.consumeReadAsync('under-shared-fence');
    assert.equal(count(readBudget.db, db, 'read-address', 'under-shared-fence'), 1);
    assert.throws(() => db.db.prepare("INSERT INTO login_limits VALUES('guard-probe',1,0,0)").run(), busy);
    assert.equal(worker.process.exitCode, null);
  } finally { await worker.stop(); }
  db.db.prepare("INSERT INTO login_limits VALUES('guard-probe',1,0,0)").run();
});

test('real worker processes compete atomically for the final address and site token', { timeout: 15000 }, async (t) => {
  const f = fixture(t), { db, readBudget, limits } = f.context().value;
  limits.consume('read', '', 'shared-address', '', NOW);
  readBudget.db.prepare('UPDATE login_limits SET failures=? WHERE key=?').run(239, db.limitKey('booking-budget:read-address', 'shared-address'));
  readBudget.db.prepare('UPDATE login_limits SET failures=? WHERE key=?').run(19999, db.limitKey('booking-budget:site-read', 'all'));
  const workers = Array.from({ length: 6 }, () => child(imports(f.platformDir) + `
    const db=createPlatformDatabase(directory,{isolatedReadBudgets:true});
    const budget=budgetStore.openBookingReadBudget(db.db,directory,true);
    const limits=createBookingPublicLimits(db,{readBudget:budget,clock:()=>${NOW}});
    process.on('message',async()=>{
      let status=200;try{await limits.consumeReadAsync('shared-address');}catch(error){status=error.status||500;}
      budget.close();db.closeWriter();db.db.close();process.send({status},()=>process.exit(0));
    });process.send({ready:true});`));
  try {
    assert.ok((await Promise.all(workers.map(nextMessage))).every((message) => message.ready));
    const replies = workers.map(nextMessage);
    workers.forEach((worker) => worker.process.send({ run: true }));
    const statuses = (await Promise.all(replies)).map((message) => message.status).sort();
    assert.deepEqual(statuses, [200, 429, 429, 429, 429, 429]);
    assert.equal(count(readBudget.db, db, 'read-address', 'shared-address'), 240);
    assert.equal(count(readBudget.db, db, 'site-read', 'all'), 20000);
  } finally { await Promise.all(workers.map((worker) => worker.stop())); }
});

test('either exhausted budget denies without consuming the other budget or modifying cleanup', async (t) => {
  const f = fixture(t), { db, readBudget, limits } = f.context().value;
  limits.consume('read', '', 'full-address', '', NOW);
  readBudget.db.prepare('UPDATE login_limits SET failures=240 WHERE key=?').run(db.limitKey('booking-budget:read-address', 'full-address'));
  const before = rows(readBudget.db), marker = readBudget.cleanup.last();
  await assert.rejects(limits.consumeReadAsync('full-address'), { status: 429 });
  assert.deepEqual(rows(readBudget.db), before); assert.equal(readBudget.cleanup.last(), marker);
  readBudget.db.prepare('UPDATE login_limits SET failures=20000 WHERE key=?').run(db.limitKey('booking-budget:site-read', 'all'));
  const full = rows(readBudget.db);
  await assert.rejects(limits.consumeReadAsync('new-address'), { status: 429 });
  assert.deepEqual(rows(readBudget.db), full);
});

test('queued requests use admission-time clock; committed cleanup is shared and runs once per interval', async (t) => {
  const f = fixture(t); let now = NOW;
  const { db, readBudget, limits } = f.context({ clock: () => now }).value;
  limits.consume('read', '', 'clock-address', '', now);
  readBudget.db.prepare('UPDATE login_limits SET failures=240 WHERE key=?').run(db.limitKey('booking-budget:read-address', 'clock-address'));
  const insert = readBudget.db.prepare('INSERT INTO login_limits VALUES(?,1,?,?)');
  readBudget.transaction(() => {
    for (let i = 0; i < 800; i++) insert.run('booking-budget:read-address:!expired-' + i, NOW - 100000, NOW - 1);
  });
  const remaining = () => readBudget.db.prepare("SELECT COUNT(*) AS n FROM login_limits WHERE key LIKE 'booking-budget:read-address:!expired-%'").get().n;
  const blocker = f.track(new DatabaseSync(path.join(f.platformDir, budgetStore.filename))).value;
  blocker.exec('BEGIN IMMEDIATE');
  const pending = Array.from({ length: 12 }, () => limits.consumeReadAsync('clock-address'));
  assert.ok(readBudget.stats().busyAttempts > 0);
  now += 60001; blocker.exec('ROLLBACK');
  await Promise.all(pending);
  assert.equal(count(readBudget.db, db, 'read-address', 'clock-address'), 12);
  assert.equal(count(readBudget.db, db, 'site-read', 'all'), 12);
  assert.equal(readBudget.cleanup.last(), now); assert.equal(remaining(), 300);
  const second = f.context({ clock: () => now }).value;
  await second.limits.consumeReadAsync('second-worker'); assert.equal(remaining(), 300);
  now += 1000;
  await second.limits.consumeReadAsync('second-worker'); assert.equal(remaining(), 0);
});

test('restart preserves active windows, and unprepared or mismatched modes fail closed', async (t) => {
  const f = fixture(t, { prepare: false });
  assert.throws(() => createPlatformStore(f.platformDir, { isolatedReadBudgets: true }), /mode differs/);
  assert.throws(() => migrateBookingReadBudget(f.platformDir));
  fs.writeFileSync(f.marker, 'wrong-purpose');
  assert.throws(() => migrateBookingReadBudget(f.platformDir), /offline preparation/); fs.unlinkSync(f.marker);
  f.migrate();
  assert.throws(() => createPlatformStore(f.platformDir), /mode differs/);
  const first = f.context(); await first.value.limits.consumeReadAsync('restart-address'); first.close();
  const second = f.context(); await second.value.limits.consumeReadAsync('restart-address');
  assert.equal(count(second.value.readBudget.db, second.value.db, 'read-address', 'restart-address'), 2); second.close();
  const file = path.join(f.platformDir, budgetStore.filename), moved = file + '.held';
  fs.renameSync(file, moved);
  assert.throws(() => createPlatformStore(f.platformDir, { isolatedReadBudgets: true }), /file missing/);
  assert.equal(fs.existsSync(file), false); fs.renameSync(moved, file);
  const direct = new DatabaseSync(file); direct.prepare('UPDATE budget_meta SET store_id=?').run('00000000-0000-0000-0000-000000000000'); direct.close();
  assert.throws(() => createPlatformStore(f.platformDir, { isolatedReadBudgets: true }), /identity mismatch/);
});

test('old-client INSERT and UPDATE cannot write read budgets, while submit and auth counters remain usable', (t) => {
  const f = fixture(t), direct = f.track(new DatabaseSync(path.join(f.platformDir, 'platform.sqlite'))).value;
  const insert = direct.prepare('INSERT INTO login_limits VALUES(?,1,?,?)');
  for (const scope of ['read-address', 'site-read']) {
    assert.throws(() => insert.run('booking-budget:' + scope + ':legacy', NOW, NOW + 60000), /Legacy booking read-budget/);
  }
  for (const key of ['booking-budget:address:submit', 'booking-budget:site-write:submit', 'login-address:auth']) {
    insert.run(key, NOW, NOW + 60000);
    assert.equal(direct.prepare('UPDATE login_limits SET failures=failures+1 WHERE key=?').run(key).changes, 1);
  }
  for (const scope of ['read-address', 'site-read']) {
    assert.throws(() => direct.prepare("UPDATE login_limits SET key=? WHERE key='login-address:auth'").run('booking-budget:' + scope + ':legacy'), /Legacy booking read-budget/);
  }
  assert.equal(direct.prepare('SELECT COUNT(*) AS n FROM login_limits WHERE ' + budgetStore.readWhere).get().n, 0);
});

test('missing or substituted legacy-write trigger prevents startup before counters can be used', (t) => {
  const f = fixture(t), direct = f.track(new DatabaseSync(path.join(f.platformDir, 'platform.sqlite'))).value;
  for (const guard of budgetStore.legacyGuards) {
    direct.exec('DROP TRIGGER ' + guard.name);
    assert.throws(() => createPlatformStore(f.platformDir, { isolatedReadBudgets: true }), /legacy write guard mismatch/);
    direct.exec(`CREATE TRIGGER ${guard.name} BEFORE INSERT ON login_limits BEGIN SELECT 1; END`);
    assert.throws(() => createPlatformStore(f.platformDir, { isolatedReadBudgets: true }), /legacy write guard mismatch/);
    direct.exec('DROP TRIGGER ' + guard.name); direct.exec(guard.sql);
  }
  f.platform({ isolatedReadBudgets: true }).close();
});

test('production and release-gate isolation require explicit component approval and shared writes', () => {
  assert.equal(configuration({}, {}).isolatedReadBudgets, false);
  assert.equal(configuration({}, {}).readBudgetVersion, 0);
  assert.equal(configuration({ isolatedReadBudgets: true }, {}).isolatedReadBudgets, true);
  for (const options of [{ production: true }, { releaseGate: true }])
    assert.throws(() => configuration({ ...options, isolatedReadBudgets: true }, {}), /require approved version 1/);
  for (const environment of [{ NODE_ENV: 'production' }, { CARTOTECA_RELEASE_GATE: '1' }])
    assert.throws(() => configuration({}, { ...environment, CARTOTECA_ISOLATED_READ_BUDGETS: '1', CARTOTECA_SHARED_CABINET_WRITES: '1' }), /require approved version 1/);
  for (const environment of [{ NODE_ENV: 'production' }, { CARTOTECA_RELEASE_GATE: '1' }]) {
    const selected = configuration({}, {
      ...environment, APP_ORIGIN: 'https://synthetic.invalid',
      CARTOTECA_ISOLATED_READ_BUDGETS: '1', CARTOTECA_SHARED_CABINET_WRITES: '1',
      CARTOTECA_READ_BUDGET_VERSION: '1',
    });
    assert.equal(selected.readBudgetVersion, 1);
    assert.equal(selected.isolatedReadBudgets, true);
    assert.equal(selected.sharedCabinetWrites, true);
  }
  const options = { releaseGate: true, readBudgetVersion: 1, isolatedReadBudgets: true, sharedCabinetWrites: true };
  assert.equal(configuration(options, {}).readBudgetVersion, 1);
  for (const field of ['isolatedReadBudgets', 'sharedCabinetWrites'])
    for (const value of [false, undefined, '1', 1])
      assert.throws(() => configuration({ ...options, [field]: value }, {}), /version 1 requires/);
});

test('unknown read-budget versions fail closed without changing synthetic defaults', () => {
  for (const version of ['', '01', '1.0', ' 1', '2', '-1', 'yes', true, 2, NaN]) {
    assert.throws(() => configuration({ readBudgetVersion: version }, {}), /Invalid read-budget version/);
    assert.throws(() => configuration({}, { CARTOTECA_READ_BUDGET_VERSION: version }), /Invalid read-budget version/);
  }
  assert.equal(configuration({ isolatedReadBudgets: true, sharedCabinetWrites: true }, {}).readBudgetVersion, 0);
  assert.equal(configuration({}, { CARTOTECA_READ_BUDGET_VERSION: '0' }).isolatedReadBudgets, false);
});

test('version approval cannot bypass missing, mismatched or damaged registered read-budget storage', (t) => {
  const f = fixture(t, { prepare: false });
  const config = configuration({ releaseGate: true, readBudgetVersion: 1, isolatedReadBudgets: true, sharedCabinetWrites: true }, {});
  assert.throws(() => createPlatformStore(f.platformDir, config), /mode differs/);
  f.migrate();
  f.platform(config).close();
  const file = path.join(f.platformDir, budgetStore.filename), moved = file + '.held';
  fs.renameSync(file, moved);
  assert.throws(() => createPlatformStore(f.platformDir, config), /file missing/);
  assert.equal(fs.existsSync(file), false); fs.renameSync(moved, file);
  const direct = new DatabaseSync(file);
  direct.exec('PRAGMA user_version=2'); direct.close();
  assert.throws(() => createPlatformStore(f.platformDir, config), /identity mismatch/);
});

test('offline migration and rollback preserve active counters and leave submit limits in authority storage', async (t) => {
  const f = fixture(t, { prepare: false }), legacy = f.context({ enabled: false });
  for (let i = 0; i < 5; i++) legacy.value.limits.consume('read', '', 'preserved-address', '', NOW);
  legacy.value.limits.consume('submit', 'organization', 'submit-address', '+79990000000', NOW);
  legacy.close();
  assert.equal(f.migrate().countersPreserved, 2);
  const isolated = f.context();
  for (let i = 0; i < 4; i++) await isolated.value.limits.consumeReadAsync('preserved-address');
  const active = rows(isolated.value.readBudget.db);
  assert.equal(count(isolated.value.readBudget.db, isolated.value.db, 'read-address', 'preserved-address'), 9);
  const submit = rows(isolated.value.db.db); assert.equal(submit.length, 4); isolated.close();
  assert.equal(f.migrate(true).countersPreserved, 2);
  assert.throws(() => createPlatformStore(f.platformDir, { isolatedReadBudgets: true }), /mode differs/);
  const restored = f.context({ enabled: false });
  assert.equal(restored.value.db.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'booking_read_budget_legacy_%'").get().n, 0);
  assert.deepEqual(rows(restored.value.db.db), [...active, ...submit].sort((a, b) => a.key.localeCompare(b.key)));
  restored.value.limits.consume('read', '', 'preserved-address', '', NOW);
  assert.equal(count(restored.value.db.db, restored.value.db, 'read-address', 'preserved-address'), 10);
  restored.value.db.db.prepare('UPDATE login_limits SET failures=failures+1 WHERE key=?').run(restored.value.db.limitKey('booking-budget:read-address', 'preserved-address'));
  assert.equal(count(restored.value.db.db, restored.value.db, 'read-address', 'preserved-address'), 11);
});
