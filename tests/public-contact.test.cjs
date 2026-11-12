const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  publicContact,
  saveAdminContactPhone,
} = require('../src/server/modules/organizations/public-contact.cjs');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT,created_at INTEGER);`);
  const org = { phone: '8 (900) 000-00-99', staffContactPhones: {} };
  db.prepare('INSERT INTO organizations VALUES(?,?)').run('org', JSON.stringify(org));
  const context = { db, seal: JSON.stringify, open: JSON.parse };
  const member = (
    id,
    {
      organizationId = 'org',
      role = 'salon_admin',
      status = 'active',
      accountStatus = 'active',
      at = 1,
    } = {},
  ) => {
    db.prepare('INSERT INTO accounts VALUES(?,?)').run(id, accountStatus);
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?)').run(
      organizationId,
      id,
      role,
      status,
      at,
    );
    return { role, accountId: id, organizationId };
  };
  const read = () =>
    JSON.parse(db.prepare('SELECT value FROM organizations WHERE id=?').get('org').value);
  return { context, org, member, read };
}

test('public contact selects one active administrator in stable order, without requiring provider status', (t) => {
  const f = fixture(t);
  const later = f.member('later', { at: 2 }),
    first = f.member('first', { at: 1 });
  f.member('other', { organizationId: 'other-org', at: 0 });
  saveAdminContactPhone(f.context, later, '+79000000002', '');
  saveAdminContactPhone(f.context, first, '8 (900) 000-00-01', '');
  const org = f.read();
  org.staffContactPhones.other = '+79000000000';
  assert.deepEqual(publicContact(f.context, 'org', org), {
    phone: '+79000000001',
    phoneLabel: 'Телефон администратора',
  });
  f.context.db.prepare("UPDATE memberships SET status='suspended' WHERE account_id=?").run('first');
  assert.equal(publicContact(f.context, 'org', org).phone, '+79000000002');
  f.context.db.prepare("UPDATE accounts SET status='blocked' WHERE id=?").run('later');
  assert.deepEqual(publicContact(f.context, 'org', org), {
    phone: '+79000000099',
    phoneLabel: 'Телефон организации',
  });
});

test('administrator phone is scoped, validated, compare-and-swap protected and can be cleared', (t) => {
  const f = fixture(t),
    admin = f.member('admin'),
    employee = f.member('employee', { role: 'cosmetologist' });
  assert.throws(() => saveAdminContactPhone(f.context, employee, '+79000000001', ''), {
    status: 403,
  });
  assert.throws(() => saveAdminContactPhone(f.context, admin, 'javascript:1234567890', ''), {
    status: 400,
  });
  assert.throws(() => saveAdminContactPhone(f.context, admin, '123', ''), { status: 400 });
  assert.throws(() => saveAdminContactPhone(f.context, admin, '+79000000001', undefined), {
    status: 400,
  });
  saveAdminContactPhone(f.context, admin, '9000000001', '');
  assert.equal(f.read().staffContactPhones.admin, '+79000000001');
  assert.equal(f.read().phone, f.org.phone);
  assert.throws(() => saveAdminContactPhone(f.context, admin, '+79000000002', ''), { status: 409 });
  saveAdminContactPhone(f.context, admin, '', '+79000000001');
  assert.equal(f.read().staffContactPhones.admin, undefined);
  assert.equal(publicContact(f.context, 'org', f.read()).phone, '+79000000099');
  f.context.db
    .prepare("UPDATE memberships SET role='cosmetologist' WHERE account_id=?")
    .run('admin');
  assert.throws(() => saveAdminContactPhone(f.context, admin, '+79000000003', ''), { status: 403 });
});

test('malformed historical or missing phones never produce unsafe public links', (t) => {
  const f = fixture(t);
  f.member('admin');
  assert.equal(
    publicContact(f.context, 'org', { phone: '', staffContactPhones: { admin: 'not-a-phone' } })
      .phone,
    '',
  );
  assert.equal(publicContact(f.context, 'org', { phone: 'javascript:1234567890' }).phone, '');
  assert.equal(publicContact(f.context, 'org', { phone: '+374 91 123456' }).phone, '+37491123456');
});
