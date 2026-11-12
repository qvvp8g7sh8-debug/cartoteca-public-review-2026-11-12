const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createPushActivity } = require('../src/server/modules/notifications/push-activity.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const { createWorkdayPush } = require('../src/server/modules/notifications/push-workday.cjs');

function fixture(t, organizations) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  // Real SQL identities/indexes used by the interest reader; no clinical data/providers.
  db.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE memberships(organization_id TEXT NOT NULL,account_id TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(organization_id,account_id));
    CREATE INDEX admin_membership_account ON memberships(account_id,organization_id);
    CREATE TABLE staff_push_devices(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,account_id TEXT NOT NULL,value BLOB NOT NULL);
    CREATE INDEX staff_push_account ON staff_push_devices(organization_id,account_id);
    CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE staff_push_jobs(event_key TEXT,status TEXT,next_at INTEGER,lease_until INTEGER,expires_at INTEGER);`);
  const seal = (value) => Buffer.from(JSON.stringify(value));
  const open = (value) => JSON.parse(Buffer.from(value).toString('utf8'));
  for (const [index, entry] of organizations.entries()) {
    const value = typeof entry === 'string' ? { id: entry } : entry;
    db.prepare('INSERT INTO organizations VALUES(?,?)').run(value.id, value.status || 'active');
    for (let n = 0; n < (value.devices ?? 3); n++) {
      const account = 'account-' + index + '-' + n;
      db.prepare('INSERT INTO accounts VALUES(?,?)').run(account, value.accountStatus || 'active');
      db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(
        value.id,
        account,
        value.role || 'owner',
        value.membershipStatus || 'active',
      );
      db.prepare('INSERT INTO staff_push_devices VALUES(?,?,?,?)').run(
        'device-' + index + '-' + n,
        value.id,
        account,
        seal({ enabled: true, preferences: { events: ['reminder'], leadMinutes: 120 } }),
      );
    }
  }
  const calls = [],
    preparations = [];
  const observed = new Proxy(db, {
    get(target, name) {
      if (name === 'prepare')
        return (sql) => {
          preparations.push(sql);
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(selected, method) {
              if (method === 'all')
                return (...args) => {
                  const rows = selected.all(...args);
                  calls.push({ sql, args, rows });
                  return rows;
                };
              const value = Reflect.get(selected, method, selected);
              return typeof value === 'function' ? value.bind(selected) : value;
            },
          });
        };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const channel = { enabled: true };
  const activity = createPushActivity({
    db: observed,
    seal,
    open,
    transaction(callback) {
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    notificationChannels: { enabled: () => channel.enabled, version: () => 'synthetic-epoch' },
  });
  activity.hasEnabledEvents(); // Existing one-time marker bootstrap precedes bounded warm pages.
  calls.length = 0;
  const expected = () =>
    db
      .prepare("SELECT id FROM organizations WHERE status='active' ORDER BY id")
      .all()
      .map((r) => r.id);
  return { db, open, activity, calls, preparations, channel, expected };
}

const globalProbes = (f, category = 'reminder') =>
  f.calls.filter(
    (call) =>
      call.sql.includes('CROSS JOIN staff_push_devices') &&
      call.sql.includes('instr(') &&
      call.args.includes('push-interest-v1:' + category + ':'),
  );
function workday(f) {
  const enqueued = [];
  const store = {
    ...f.activity,
    hasPendingTests: () => false,
    allowed: () => true,
    recipients(org) {
      return f.db
        .prepare('SELECT * FROM staff_push_devices WHERE organization_id=?')
        .all(org)
        .map((row) => ({ ...row, decoded: f.open(row.value) }));
    },
    enqueue: (...args) => enqueued.push(args),
    claim: () => null,
    organizations() {
      assert.fail('Paged planner must not fall back to full enumeration');
    },
  };
  const platform = {
    staffPush: store,
    organizationTimeZone: () => 'UTC',
    withWriteLock: (callback) => callback(),
    workSchedules: {
      publicDays: (_org, _account, date) => ({
        days: { [date]: { status: 'working', intervals: [['10:00', '12:00']] } },
        closures: {},
      }),
    },
  };
  const clock = () => Date.parse('2030-01-02T08:00:00Z');
  return { enqueued, store, platform, clock, planner: createWorkdayPush(platform, store, clock) };
}

test('Push candidate pages advance through first/middle/final and empty intermediate matches', (t) => {
  const f = fixture(t, ['a', { id: 'b', status: 'suspended' }, { id: 'c', devices: 0 }, 'd', 'e']);
  assert.deepEqual(f.activity.reminderOrganizationPage('', 2), {
    organizations: ['a'],
    cursor: 'b',
  });
  assert.deepEqual(f.activity.reminderOrganizationPage('b', 1), { organizations: [], cursor: 'c' });
  assert.deepEqual(f.activity.reminderOrganizationPage('c', 1), {
    organizations: ['d'],
    cursor: 'd',
  });
  assert.deepEqual(f.activity.reminderOrganizationPage('d', 2), {
    organizations: ['e'],
    cursor: '',
  });
  assert.deepEqual(f.activity.reminderOrganizationPage('z', 2), { organizations: [], cursor: '' });
  assert.deepEqual(f.activity.reminderOrganizations(), ['a', 'd', 'e']);
});

test('an exact candidate limit boundary uses one extra empty EOF page without duplicate organizations', (t) => {
  const f = fixture(t, ['a', 'b', 'c', 'd']);
  const first = f.activity.reminderOrganizationPage('', 2);
  const second = f.activity.reminderOrganizationPage(first.cursor, 2);
  const eof = f.activity.reminderOrganizationPage(second.cursor, 2);
  assert.deepEqual(first, { organizations: ['a', 'b'], cursor: 'b' });
  assert.deepEqual(second, { organizations: ['c', 'd'], cursor: 'd' });
  assert.deepEqual(eof, { organizations: [], cursor: '' });
  assert.deepEqual(f.activity.reminderOrganizations(), ['a', 'b', 'c', 'd']);
});

test('SQL organization order preserves Unicode, percent and colon identities across multiple devices', (t) => {
  const f = fixture(t, ['орг', 'a:b', 'a%', 'a?', 'a b', 'é', '𐀀', 'a']);
  const seen = [];
  let cursor = '';
  do {
    const page = f.activity.reminderOrganizationPage(cursor, 3);
    seen.push(...page.organizations);
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(seen, f.expected());
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(f.activity.reminderOrganizations(), seen);
});

test('organization/member/account revocation, unsupported role and deleted devices reject stale markers freshly', (t) => {
  const f = fixture(t, ['a']);
  const read = () => f.activity.reminderOrganizationPage('', 10).organizations;
  assert.deepEqual(read(), ['a']);
  for (const [table, column, rejected] of [
    ['organizations', 'status', 'suspended'],
    ['memberships', 'status', 'suspended'],
    ['memberships', 'role', 'unsupported'],
    ['accounts', 'status', 'suspended'],
  ]) {
    f.db.prepare(`UPDATE ${table} SET ${column}=?`).run(rejected);
    assert.deepEqual(read(), []);
    f.db.prepare(`UPDATE ${table} SET ${column}=?`).run(column === 'role' ? 'owner' : 'active');
    assert.deepEqual(
      read(),
      ['a'],
      'regrant is not hidden behind a negative or positive ACL cache',
    );
  }
  f.db.exec('DELETE FROM staff_push_devices');
  assert.ok(
    f.db
      .prepare(
        "SELECT count(*) n FROM telegram_runtime WHERE key LIKE 'push-interest-v1:reminder:%'",
      )
      .get().n > 0,
  );
  assert.deepEqual(read(), []);
  assert.deepEqual(f.activity.reminderOrganizations(), []);
});

test('channel and runtime off skip candidate scans, and re-enable uses fresh member state', (t) => {
  const f = fixture(t, ['a']);
  f.channel.enabled = false;
  f.calls.length = 0;
  assert.deepEqual(f.activity.reminderOrganizationPage(), { organizations: [], cursor: '' });
  assert.deepEqual(f.activity.reminderOrganizations(), []);
  assert.equal(f.calls.length, 0);
  f.channel.enabled = true;
  assert.deepEqual(f.activity.reminderOrganizations(), ['a']);
  f.activity.setRuntimeAvailable(false);
  f.calls.length = 0;
  assert.deepEqual(f.activity.reminderOrganizationPage(), { organizations: [], cursor: '' });
  assert.equal(f.calls.length, 0);
  f.db.exec("UPDATE memberships SET status='suspended'");
  f.activity.setRuntimeAvailable(true);
  assert.deepEqual(f.activity.reminderOrganizations(), []);
  f.db.exec("UPDATE memberships SET status='active'");
  assert.deepEqual(f.activity.reminderOrganizations(), ['a']);
});

test('each warm page examines at most its candidate limit with prepared per-org probes and complete coverage', (t) => {
  const f = fixture(
    t,
    Array.from({ length: 23 }, (_, n) => ({
      id: 'org-' + String(n).padStart(2, '0'),
      status: n < 17 ? 'suspended' : 'active',
    })),
  );
  const seen = [];
  let cursor = '',
    pages = 0;
  do {
    f.calls.length = 0;
    const page = f.activity.reminderOrganizationPage(cursor, 4);
    const candidateReads = f.calls.filter(
      (r) => r.sql === 'SELECT id FROM organizations WHERE id>? ORDER BY id LIMIT ?',
    );
    const probes = f.calls.filter((r) => r.sql.includes('CROSS JOIN staff_push_devices'));
    assert.equal(candidateReads.length, 1);
    assert.ok(candidateReads[0].rows.length <= 4);
    assert.equal(probes.length, candidateReads[0].rows.length);
    assert.ok(probes.every((r) => !r.sql.includes('DISTINCT') && !r.sql.includes('instr(')));
    seen.push(...page.organizations);
    cursor = page.cursor;
    pages++;
    assert.ok(pages <= 7);
  } while (cursor);
  assert.deepEqual(seen, f.expected());
  const preparedOrgShapes = f.preparations.filter(
    (sql) => sql.includes('CROSS JOIN staff_push_devices') && !sql.includes('instr('),
  );
  assert.equal(preparedOrgShapes.length, 1, 'SQL shape reuse does not cache permission results');
  for (const limit of [0, 101, 1.5, NaN])
    assert.throws(() => f.activity.reminderOrganizationPage('', limit), /Invalid/);
  assert.throws(() => f.activity.reminderOrganizationPage(null, 1), /Invalid/);
});

test('the maximum100 candidate page advances past all-inactive matches to a later eligible organization', (t) => {
  const f = fixture(
    t,
    Array.from({ length: 101 }, (_, n) => ({
      id: 'org-' + String(n).padStart(3, '0'),
      devices: 1,
      status: n < 100 ? 'suspended' : 'active',
    })),
  );
  assert.deepEqual(f.activity.reminderOrganizationPage('', 100), {
    organizations: [],
    cursor: 'org-099',
  });
  assert.deepEqual(f.activity.reminderOrganizationPage('org-099', 100), {
    organizations: ['org-100'],
    cursor: '',
  });
  assert.deepEqual(f.activity.reminderOrganizations(), ['org-100']);
});

test('sparse workday batches use one global hint over empty pages and keep every later eligible organization', (t) => {
  const f = fixture(
    t,
    Array.from({ length: 24 }, (_, n) => ({
      id: 'org-' + String(n).padStart(2, '0'),
      status: n < 22 ? 'suspended' : 'active',
    })),
  );
  const w = workday(f),
    cursors = [];
  let cursor = '';
  do {
    cursor = w.planner.scheduleBatch(cursor, 5).cursor;
    cursors.push(cursor);
  } while (cursor);
  assert.deepEqual(cursors, ['org-04', 'org-09', 'org-14', 'org-19', '']);
  assert.deepEqual([...new Set(w.enqueued.map((args) => args[0]))], ['org-22', 'org-23']);
  assert.equal(w.enqueued.length, 6);
  assert.equal(globalProbes(f).length, 1, 'a global marker range must not be rescanned per page');
});

test('provided workday lists avoid the global hint but retain fresh per-org and allowed guards', (t) => {
  const f = fixture(t, ['a', 'b']);
  const w = workday(f);
  w.planner.schedule([]);
  assert.equal(f.calls.length, 0);
  w.store.allowed = (org) => org !== 'b';
  w.planner.schedule(['a', 'b']);
  assert.deepEqual(
    w.enqueued.map((args) => args[0]),
    ['a', 'a', 'a'],
  );
  assert.equal(globalProbes(f).length, 0);
  w.enqueued.length = 0;
  f.db.exec("UPDATE memberships SET status='suspended' WHERE organization_id='a'");
  w.planner.schedule(['a', 'b']);
  assert.equal(w.enqueued.length, 0, 'a supplied list is never permission evidence');
  f.db.exec("UPDATE memberships SET status='active'");
  w.store.allowed = () => true;
  f.calls.length = 0;
  w.planner.schedule();
  assert.equal(globalProbes(f).length, 1, 'the one-shot no-list API keeps its global hint');
  assert.deepEqual([...new Set(w.enqueued.map((args) => args[0]))], ['a', 'b']);
});

test('mid-scan revocation and channel off stop late scheduling without repeating the global hint', (t) => {
  const f = fixture(t, ['a', { id: 'b', status: 'suspended' }, 'c', 'd']);
  const w = workday(f);
  let cursor = w.planner.scheduleBatch('', 1).cursor;
  assert.equal(cursor, 'a');
  f.db.exec("UPDATE memberships SET status='suspended' WHERE organization_id='c'");
  cursor = w.planner.scheduleBatch(cursor, 2).cursor;
  assert.equal(cursor, 'c', 'an empty page still advances after fresh revocation');
  f.channel.enabled = false;
  assert.deepEqual(w.planner.scheduleBatch(cursor, 1), { cursor: '' });
  assert.deepEqual([...new Set(w.enqueued.map((args) => args[0]))], ['a']);
  assert.equal(globalProbes(f).length, 1);
  w.enqueued.length = 0;
  f.channel.enabled = true;
  f.db.exec("UPDATE memberships SET status='active'");
  cursor = '';
  do {
    cursor = w.planner.scheduleBatch(cursor, 2).cursor;
  } while (cursor);
  assert.deepEqual([...new Set(w.enqueued.map((args) => args[0]))], ['a', 'c', 'd']);
  assert.equal(globalProbes(f).length, 2, 'only a new sweep adds another global hint');
});

test('the real managed workday planner continues an empty candidate page and schedules every later organization', async (t) => {
  const f = fixture(
    t,
    Array.from({ length: 24 }, (_, n) => ({
      id: 'org-' + String(n).padStart(2, '0'),
      status: n < 12 ? 'suspended' : 'active',
    })),
  );
  const w = workday(f),
    expected = f.expected();
  let yields = 0;
  const runtime = createPushRuntime({
    platform: w.platform,
    tenantStore() {
      assert.fail('Workday planning must not read clinical data');
    },
    origin: 'https://synthetic.test',
    enabled: true,
    clock: w.clock,
    yieldTurn: async () => {
      yields++;
    },
    send() {
      assert.fail('No provider delivery in this planning scenario');
    },
  });
  runtime.start();
  try {
    await runtime.tick();
  } finally {
    runtime.stop();
  }
  assert.ok(yields >= 2);
  assert.deepEqual([...new Set(w.enqueued.map((args) => args[0]))], expected);
  assert.equal(w.enqueued.length, expected.length * 3);
  assert.equal(globalProbes(f).length, 2, 'runtime and initial batch retain their separate hints');
  assert.equal(globalProbes(f, 'all').length, 1);
});
