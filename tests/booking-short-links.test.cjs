const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { schema } = require('../src/server/infrastructure/booking-public-links-schema.cjs');
const { createBookingShortLinks } = require('../src/server/modules/booking/short-links.cjs');
const { createBookingPublication } = require('../src/server/modules/booking/publication.cjs');

const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '22222222-2222-4222-8222-222222222222';
const staff = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const outsider = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fixture(t, { prepared = true, randomInt } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE memberships(organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),role TEXT NOT NULL,status TEXT NOT NULL,
      PRIMARY KEY(organization_id,account_id));`);
  for (const id of [org, otherOrg])
    db.prepare("INSERT INTO organizations VALUES(?,'active')").run(id);
  for (const id of [staff, outsider]) db.prepare("INSERT INTO accounts VALUES(?,'active')").run(id);
  db.prepare("INSERT INTO memberships VALUES(?,?,'owner','active')").run(org, staff);
  db.prepare("INSERT INTO memberships VALUES(?,?,'cosmetologist','active')").run(
    otherOrg,
    outsider,
  );
  if (prepared) db.exec(schema);
  const profiles = new Map(
    [org, otherOrg].map((id) => [id, { name: 'Synthetic', onlineBooking: { staff: {} } }]),
  );
  let writes = 0;
  const context = {
    db,
    ...(randomInt ? { crypto: { randomInt } } : {}),
    transaction(callback) {
      writes++;
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
    organization: (id) => profiles.get(id),
    onlineBooking: {
      actor: (role) => ({ role, accountId: staff, organizationId: org }),
      settings: (id) => profiles.get(id).onlineBooking,
      providers: (id) =>
        db
          .prepare(
            `SELECT m.account_id AS accountId FROM memberships m JOIN accounts a ON a.id=m.account_id
         WHERE m.organization_id=? AND m.status='active' AND a.status='active'
         AND m.role IN ('owner','cosmetologist')`,
          )
          .all(id)
          .filter(
            (member) => profiles.get(id).onlineBooking.staff[member.accountId]?.enabled !== false,
          ),
    },
  };
  const links = createBookingShortLinks(context);
  context.bookingShortLinks = links;
  return { db, context, links, profiles, writes: () => writes };
}

test('unprepared data keeps legacy URLs and never creates component tables', (t) => {
  const f = fixture(t, { prepared: false });
  assert.equal(f.links.available, false);
  f.links.ensure(org, [staff]);
  assert.equal(f.links.path(org), '/booking.html?organization=' + org);
  assert.equal(f.links.path(org, staff), '/booking.html?organization=' + org + '&staff=' + staff);
  assert.throws(() => f.links.resolve('abcdefgh'), { status: 404 });
  assert.equal(
    f.db.prepare("SELECT name FROM sqlite_schema WHERE name='booking_public_links'").get(),
    undefined,
  );
  assert.equal(f.writes(), 0);
});

test('a partial component fails closed instead of falling back or repairing itself', (t) => {
  const f = fixture(t, { prepared: false });
  f.db.exec('CREATE TABLE booking_public_links_schema(id INTEGER PRIMARY KEY,version INTEGER)');
  assert.throws(() => createBookingShortLinks(f.context), /component schema mismatch/);
  assert.equal(f.writes(), 0);
});

test('organization and staff get separate stable opaque URLs; another instance sees them', (t) => {
  const f = fixture(t);
  f.links.ensure(org, [staff]);
  f.links.ensure(otherOrg, [outsider]);
  const organizationPath = f.links.path(org);
  const staffPath = f.links.path(org, staff);
  const paths = [
    organizationPath,
    staffPath,
    f.links.path(otherOrg),
    f.links.path(otherOrg, outsider),
  ];
  for (const path of paths) assert.match(path, /^\/b\/[a-z0-9]{8}$/);
  assert.equal(new Set(paths).size, 4);
  assert.deepEqual(f.links.resolve(organizationPath.slice(3)), {
    organizationId: org,
    staffId: '',
  });
  assert.deepEqual(f.links.resolve(staffPath.slice(3)), { organizationId: org, staffId: staff });
  f.profiles.get(org).name = 'Renamed synthetic organization';
  const reopened = createBookingShortLinks(f.context);
  assert.equal(reopened.path(org), organizationPath);
  assert.equal(reopened.path(org, staff), staffPath);
  assert.deepEqual(reopened.resolve(staffPath.slice(3)), { organizationId: org, staffId: staff });
});

test('repeated settings reads and resolution never rewrite existing links', (t) => {
  const f = fixture(t);
  f.links.ensure(org, [staff]);
  const changes = f.db.prepare('SELECT total_changes() AS count').get().count;
  const writes = f.writes();
  for (let attempt = 0; attempt < 3; attempt++) {
    f.links.ensure(org, [staff, staff]);
    f.links.resolve(f.links.path(org, staff).slice(3));
  }
  assert.equal(f.writes(), writes);
  assert.equal(f.db.prepare('SELECT total_changes() AS count').get().count, changes);
});

test('allocation joins caller transaction and rolls back all targets together', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.context.transaction(() => {
        f.links.ensure(org, [staff]);
        throw Error('Synthetic outer rollback');
      }),
    /Synthetic outer rollback/,
  );
  assert.equal(f.writes(), 1);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM booking_public_links').get().count, 0);
  assert.throws(() => f.links.ensure(org, [outsider]), { status: 404 });
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM booking_public_links').get().count, 0);
});

test('allocation rechecks the target after another writer fills the initial miss', (t) => {
  const f = fixture(t);
  const originalTransaction = f.context.transaction;
  const racing = createBookingShortLinks({
    ...f.context,
    transaction(callback) {
      f.links.ensure(org, [staff]);
      return originalTransaction(callback);
    },
  });
  racing.ensure(org, [staff]);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM booking_public_links').get().count, 2);
  assert.equal(racing.path(org, staff), f.links.path(org, staff));
});

test('collision retries are bounded and never retarget an existing address', (t) => {
  let samples = 0;
  const f = fixture(t, { randomInt: () => Math.floor(samples++ / 8) });
  f.db.prepare('INSERT INTO booking_public_links VALUES(?,?,?,?)').run('22222222', org, '', 1);
  f.links.ensure(otherOrg);
  assert.equal(f.links.path(org), '/b/22222222');
  assert.equal(f.links.path(otherOrg), '/b/33333333');
  const stuck = createBookingShortLinks({ ...f.context, crypto: { randomInt: () => 0 } });
  assert.throws(() => stuck.ensure(org, [staff]), { status: 503 });
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM booking_public_links').get().count, 2);
  assert.deepEqual(stuck.resolve('22222222'), { organizationId: org, staffId: '' });
});

test('resolve rechecks current organization, membership, account and online eligibility', (t) => {
  const f = fixture(t);
  f.links.ensure(org, [staff]);
  const code = f.links.path(org, staff).slice(3);
  const unavailable = () => assert.throws(() => f.links.resolve(code), { status: 404 });
  for (const table of ['organizations', 'accounts', 'memberships']) {
    f.db.exec(`UPDATE ${table} SET status='suspended'`);
    unavailable();
    f.db.exec(`UPDATE ${table} SET status='active'`);
  }
  f.db.exec("UPDATE memberships SET role='salon_admin'");
  unavailable();
  f.db.exec("UPDATE memberships SET role='owner'");
  f.profiles.get(org).onlineBooking.staff[staff] = { enabled: false };
  unavailable();
  f.profiles.get(org).onlineBooking.staff[staff].enabled = true;
  assert.deepEqual(f.links.resolve(code), { organizationId: org, staffId: staff });
  for (const value of ['00000000', '../other', code.slice(0, -1) + 'A', '', null])
    assert.throws(() => f.links.resolve(value), { status: 404 });
});

test('publication only issues codes after manager ACL; public state remains read-only', (t) => {
  const f = fixture(t);
  const publication = createBookingPublication(f.context);
  assert.match(publication.state(org).path, /^\/booking\.html\?/);
  assert.deepEqual(publication.view('cosmetologist'), { canManage: false });
  assert.equal(f.writes(), 0);
  const view = publication.view('owner');
  assert.match(view.path, /^\/b\/[a-z0-9]{8}$/);
  assert.equal(view.staffPaths[staff], f.links.path(org, staff));
  const writes = f.writes();
  assert.equal(publication.view('salon_admin').path, view.path);
  assert.equal(publication.state(org).path, view.path);
  assert.equal(f.writes(), writes);
});
