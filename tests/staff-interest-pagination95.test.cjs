const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  createStaffNotificationInterest,
} = require('../src/server/modules/notifications/staff-notification-interest.cjs');
const { createStaffQueue } = require('../src/server/modules/notifications/staff-queue.cjs');
const {
  createStaffEventReplay,
} = require('../src/server/modules/notifications/staff-event-replay.cjs');
const SEEK = 'SELECT key FROM telegram_runtime WHERE key>=? AND key<? ORDER BY key LIMIT 1';

function fixture(t, channel, organizations) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const table = channel === 'max' ? 'staff_max_links' : 'staff_telegram_links';
  db.exec(`CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT,PRIMARY KEY(organization_id,account_id));
    CREATE INDEX admin_membership_account ON memberships(account_id,organization_id);
    CREATE TABLE ${table}(organization_id TEXT,account_id TEXT,chat_hash TEXT,value BLOB,PRIMARY KEY(organization_id,account_id));`);
  // The real queue also prepares its bounded idle/due probes. Use its actual
  // registered jobs table/index DDL instead of an incomplete links-only port.
  const jobsTable = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs';
  const canonical = canonicalSqliteSchema({ kind: 'platform', version: 19 });
  for (const type of ['table', 'index', 'trigger'])
    for (const object of canonical.objects)
      if (object.type === type && object.tbl_name === jobsTable && object.sql) db.exec(object.sql);
  const seal = (value) => Buffer.from(JSON.stringify(value));
  let opens = 0;
  for (const [index, entry] of organizations.entries()) {
    const item = typeof entry === 'string' ? { id: entry } : entry;
    db.prepare('INSERT INTO organizations VALUES(?,?)').run(item.id, item.status || 'active');
    for (let n = 0; n < (item.members ?? 2); n++) {
      const account = 'account-' + index + '-' + n;
      db.prepare('INSERT INTO accounts VALUES(?,?)').run(account, 'active');
      db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(
        item.id,
        account,
        n ? 'cosmetologist' : 'owner',
        'active',
      );
      if (item.linked !== false)
        db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(
          item.id,
          account,
          account,
          seal({ enabled: true, events: ['created'], bindingId: account }),
        );
    }
  }
  const state = { enabled: true, calls: [], preparations: [], afterSeek: null };
  const observed = new Proxy(db, {
    get(target, name) {
      if (name === 'prepare')
        return (sql) => {
          state.preparations.push(sql);
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(selected, method) {
              if (method === 'get' || method === 'all')
                return (...args) => {
                  const result = selected[method](...args);
                  state.calls.push({ sql, args, method, result });
                  if (sql === SEEK) state.afterSeek?.(result);
                  return result;
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
  const c = {
    db: observed,
    seal,
    open(value) {
      opens++;
      return JSON.parse(Buffer.from(value).toString('utf8'));
    },
    notificationChannels: { enabled: () => state.enabled },
    id: randomUUID,
    limitKey: (_kind, key) => key,
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
  };
  const interest = createStaffNotificationInterest(c, channel);
  const links = { interest, allowed: () => true };
  const queue = createStaffQueue(c, links, channel);
  const prefix = `staff-interest-v1:${channel}:appointment:`;
  state.calls.length = 0;
  opens = 0;
  const markerOrder = () => [
    ...new Set(
      db
        .prepare('SELECT key FROM telegram_runtime WHERE key>=? AND key<? ORDER BY key')
        .all(prefix, prefix + '\uffff')
        .map((row) => JSON.parse(row.key.slice(prefix.length))[0]),
    ),
  ];
  return {
    db,
    c,
    state,
    interest,
    queue,
    links,
    table,
    prefix,
    seal,
    markerOrder,
    opens: () => opens,
  };
}
const seeks = (f) => f.state.calls.filter((call) => call.sql === SEEK);
const probes = (f) =>
  f.state.calls.filter((call) => call.sql.startsWith('SELECT 1 FROM telegram_runtime r'));
function collect(f, limit) {
  const ids = [],
    cursors = [];
  let cursor = '';
  do {
    const beforeSeeks = seeks(f).length,
      beforeProbes = probes(f).length;
    const page = f.queue.organizationPage(cursor, limit);
    assert.ok(seeks(f).length - beforeSeeks <= limit);
    assert.ok(probes(f).length - beforeProbes <= limit);
    ids.push(...page.organizations);
    cursors.push(page.cursor);
    cursor = page.cursor;
    assert.ok(cursors.length < 100, 'bounded fixture must not repeat a cursor forever');
  } while (cursor);
  return { ids, cursors };
}

for (const channel of ['telegram', 'max']) {
  test(
    channel + ' marker pages advance first/middle/final, empty matches and exact EOF boundary',
    (t) => {
      const f = fixture(t, channel, [
        'a',
        { id: 'b', status: 'suspended' },
        { id: 'c', status: 'suspended' },
        'd',
      ]);
      assert.deepEqual(f.queue.organizationPage('', 1), { organizations: ['a'], cursor: 'a' });
      assert.deepEqual(f.queue.organizationPage('a', 2), { organizations: [], cursor: 'c' });
      assert.deepEqual(f.queue.organizationPage('c', 1), { organizations: ['d'], cursor: 'd' });
      assert.deepEqual(f.queue.organizationPage('d', 1), { organizations: [], cursor: '' });
      assert.deepEqual(collect(f, 2), { ids: ['a', 'd'], cursors: ['b', 'd', ''] });
      assert.deepEqual(f.interest.organizations('', 25), ['a', 'd']);
    },
  );

  test(
    channel + ' canonical Unicode/quote/slash/prefix groups have exact marker-order coverage',
    (t) => {
      const f = fixture(t, channel, [
        'a',
        'aa',
        'a"',
        'a/',
        'a\\',
        'a%',
        'a:',
        'a,',
        'a]',
        'a\n',
        'a\u0000',
        'é',
        'орг',
        '\uffff',
        '𐀀',
        '😀',
      ]);
      const result = collect(f, 3);
      assert.deepEqual(result.ids, f.markerOrder());
      assert.equal(new Set(result.ids).size, result.ids.length);
      assert.deepEqual(
        f.interest.organizations('', 25),
        f.db
          .prepare('SELECT id FROM organizations ORDER BY id')
          .all()
          .map((row) => row.id),
      );
      assert.equal(f.opens(), 0, 'derived planning must not decrypt links or open cabinets');
    },
  );

  test(
    channel +
      ' sparse marker groups skip all unrelated organizations and every account of the prior group',
    (t) => {
      const f = fixture(t, channel, [
        ...Array.from({ length: 70 }, (_, n) => ({
          id: 'unlinked-' + n,
          linked: false,
          members: 1,
        })),
        { id: 'a', members: 30, status: 'suspended' },
        { id: 'b', members: 25 },
        { id: 'z', members: 1 },
      ]);
      f.db.exec(`DELETE FROM ${f.table} WHERE organization_id='b'`); // Stale canonical hints remain.
      const result = collect(f, 2);
      assert.deepEqual(result, { ids: ['z'], cursors: ['b', ''] });
      assert.equal(
        seeks(f).length,
        4,
        'three group seeks plus EOF, not one per account/organization',
      );
      assert.equal(probes(f).length, 3);
      assert.ok(f.state.calls.every((call) => !/^SELECT id FROM organizations/.test(call.sql)));
      assert.equal(f.opens(), 0);
    },
  );

  test(
    channel +
      ' fresh org/account/member changes and channel off/on revoke and restore marker hints',
    (t) => {
      const f = fixture(t, channel, ['a']);
      const read = () => f.interest.organizationPage('', 2).organizations;
      for (const table of ['organizations', 'accounts', 'memberships']) {
        assert.deepEqual(read(), ['a']);
        f.db.exec(`UPDATE ${table} SET status='suspended'`);
        assert.deepEqual(read(), []);
        f.db.exec(`UPDATE ${table} SET status='active'`);
      }
      f.state.afterSeek = (row) => {
        if (row) f.db.exec("UPDATE memberships SET status='suspended'");
        f.state.afterSeek = null;
      };
      assert.deepEqual(read(), [], 'the canonical selected marker does not freeze ACL evidence');
      f.state.enabled = false;
      f.state.calls.length = 0;
      assert.deepEqual(f.queue.organizationPage(), { organizations: [], cursor: '' });
      assert.equal(f.state.calls.length, 0);
      f.db.exec("UPDATE memberships SET status='active'");
      f.state.enabled = true;
      assert.deepEqual(read(), ['a']);
      f.c.transaction(() => f.interest.update('a', 'account-0-0', null));
      f.c.transaction(() => f.interest.update('a', 'account-0-1', null));
      assert.deepEqual(read(), []);
      assert.equal(f.interest.hasEnabledRecipients(), false);
    },
  );

  test(
    channel +
      ' Boolean probes are fresh SELECT1 without sorting while rows and legacy lists keep shape',
    (t) => {
      const f = fixture(t, channel, ['a']);
      assert.equal(f.interest.hasEnabledRecipients(), true);
      assert.equal(f.interest.hasAppointments('a'), true);
      f.interest.hasAppointments('a');
      assert.equal(
        f.state.preparations.filter((sql) => sql.startsWith('SELECT 1 FROM telegram_runtime r'))
          .length,
        2,
      );
      for (const call of probes(f)) {
        assert.doesNotMatch(call.sql, /DISTINCT|ORDER BY/);
        assert.match(call.sql, /LIMIT 1/);
        const plans = f.db.prepare('EXPLAIN QUERY PLAN ' + call.sql).all(...call.args);
        assert.ok(plans.every((row) => !/TEMP|SORT/i.test(row.detail)));
      }
      const rows = f.interest.rows('a', null, 'created');
      assert.equal(rows.length, 2);
      assert.deepEqual(Object.keys(rows[0]).sort(), ['account_id', 'role', 'value']);
      assert.deepEqual(f.interest.organizations('', 1), ['a']);
      assert.ok(
        f.state.calls.some(
          (call) =>
            call.sql.startsWith('SELECT DISTINCT l.organization_id id') &&
            call.sql.includes('ORDER BY l.organization_id LIMIT ?'),
        ),
      );
      const plan = f.db.prepare('EXPLAIN QUERY PLAN ' + SEEK).all(f.prefix, f.prefix + '\uffff');
      assert.ok(
        plan.some((row) => /SEARCH telegram_runtime USING COVERING INDEX/.test(row.detail)),
      );
      assert.ok(plan.every((row) => !/TEMP|SORT/i.test(row.detail)));
    },
  );

  test(
    channel + ' malformed/noncanonical markers refuse boundedly instead of repeating a group',
    { timeout: 2000 },
    (t) => {
      const f = fixture(t, channel, ['a']);
      for (const suffix of [
        'bad-json',
        '[ "a","x"]',
        '["a", "x"]',
        '["\\u0061","x"]',
        '["a","x"] ',
        '["","x"]',
        '[null,"x"]',
        '["a",1]',
        '["a","x",1]',
        '{}',
      ]) {
        f.db
          .prepare('DELETE FROM telegram_runtime WHERE key>=? AND key<?')
          .run(f.prefix, f.prefix + '\uffff');
        f.db
          .prepare('INSERT INTO telegram_runtime VALUES(?,?)')
          .run(f.prefix + suffix, f.seal({ active: true }));
        f.state.calls.length = 0;
        const before = f.db.prepare('SELECT total_changes() n').get().n;
        for (let attempt = 0; attempt < 2; attempt++)
          assert.throws(() => f.queue.organizationPage('', 2), {
            message: 'Invalid staff notification interest marker.',
          });
        assert.equal(seeks(f).length, 2);
        assert.equal(probes(f).length, 0);
        assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
      }
    },
  );

  test(
    channel +
      ' real replay advances an empty marker page at250ms and reaches later eligible cabinet',
    (t) => {
      const f = fixture(t, channel, [
        ...Array.from({ length: 7 }, (_, n) => ({
          id: 'marked-' + n,
          status: n < 6 ? 'suspended' : 'active',
        })),
        ...Array.from({ length: 50 }, (_, n) => ({ id: 'unused-' + n, linked: false, members: 0 })),
      ]);
      const opened = [];
      let now = 1000;
      const replay = createStaffEventReplay({
        platform: {
          notificationChannels: f.c.notificationChannels,
          withWriteLock: (callback) => callback(),
        },
        store: f.queue,
        channel,
        clock: () => now,
        tenantStore(org) {
          opened.push(org);
          throw Error('Synthetic unavailable cabinet; journal retained');
        },
      });
      replay(undefined, () => true);
      assert.equal(seeks(f).length, 5);
      assert.deepEqual(opened, []);
      now += 249;
      replay(undefined, () => true);
      assert.equal(seeks(f).length, 5);
      now++;
      replay(undefined, () => true);
      assert.deepEqual(opened, ['marked-6']);
      assert.equal(seeks(f).length, 8);
      now += 14999;
      replay(undefined, () => true);
      assert.equal(seeks(f).length, 8);
      now++;
      replay({ aborted: true }, () => true);
      replay(undefined, () => false);
      assert.equal(seeks(f).length, 8);
      f.state.enabled = false;
      replay(undefined, () => true);
      assert.equal(seeks(f).length, 8);
    },
  );

  test(channel + ' page limits and legacy fake fallback preserve the queue contract', (t) => {
    const f = fixture(t, channel, ['a']);
    for (const limit of [0, 26, 1.5, NaN]) {
      assert.throws(() => f.queue.organizationPage('', limit), /Invalid/);
      assert.throws(() => f.interest.organizationPage('', limit), /Invalid/);
    }
    assert.throws(() => f.interest.organizationPage(null, 1), /Invalid/);
    const calls = [];
    const fake = createStaffQueue(
      f.c,
      {
        interest: {
          organizations(cursor, limit) {
            calls.push([cursor, limit]);
            return cursor ? [] : ['legacy'];
          },
        },
      },
      channel,
    );
    assert.deepEqual(fake.organizationPage('', 1), { organizations: ['legacy'], cursor: 'legacy' });
    assert.deepEqual(fake.organizationPage('legacy', 1), { organizations: [], cursor: '' });
    assert.deepEqual(calls, [
      ['', 1],
      ['legacy', 1],
    ]);
  });
}
