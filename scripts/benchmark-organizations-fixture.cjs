// Test-only encrypted multi-tenant dataset. Never accepts an existing unmarked directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {
  dateRange,
  organizationUsers,
  validateFixture,
} = require('./benchmark-organizations-profile.cjs');
const DATA = '/tmp/cartoteca-organizations-load';
const MARKER = 'cartoteca-organizations-synthetic-v1';
function safe(directory) {
  assert.equal(path.resolve(directory), DATA);
  assert.ok(!fs.lstatSync(directory).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(directory, 'SYNTHETIC-ONLY'), 'utf8'), MARKER);
}
async function grow(root, directory, count, cards = 200, firstDate = process.env.LOAD_FIRST_DATE) {
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 10000);
  assert.ok(Number.isInteger(cards) && cards >= 10 && cards <= 2000);
  const metadata = path.join(directory, 'actors.json');
  // Validate the path before initialization too: the marker is only created in this exact empty stand directory.
  assert.equal(path.resolve(directory), DATA);
  assert.ok(!fs.lstatSync(directory).isSymbolicLink());
  if (!fs.existsSync(metadata)) dateRange(firstDate);
  const { createPlatformStore } = require(path.join(root, 'platform-store.cjs'));
  const { createPlatformDatabase } = require(
    path.join(root, 'src/server/infrastructure/platform-database.cjs'),
  );
  const { createStorage } = require(path.join(root, 'storage.cjs'));
  let fixture;
  if (!fs.existsSync(metadata)) {
    assert.deepEqual(fs.readdirSync(directory), []);
    fs.writeFileSync(path.join(directory, 'SYNTHETIC-ONLY'), MARKER, { flag: 'wx' });
    const platform = createPlatformStore(path.join(directory, 'platform'));
    const owner = await platform.registerOwner({
      email: 'synthetic-owner@example.test',
      password: 'Synthetic-organizations-password-2026',
      displayName: 'Synthetic Owner',
      organizationName: 'Synthetic Org 0',
    });
    platform.verifyEmail(owner.verificationToken);
    platform.close();
    const database = createPlatformDatabase(path.join(directory, 'platform'));
    try {
      for (const [name, method] of [
        ['012-max-connections', 'migrateMaxConnections'],
        ['013-notification-queue', 'migrateNotificationQueue'],
        ['014-notification-channels', 'migrateNotificationChannels'],
        ['015-max-inbox', 'migrateMaxInbox'],
        ['016-staff-max', 'migrateStaffMax'],
        ['017-staff-push', 'migrateStaffPush'],
      ])
        require(path.join(root, 'src/server/migrations', name + '.cjs'))[method](
          database,
          path.join(directory, 'platform'),
        );
    } finally {
      database.db.close();
    }
    const first = dateRange(firstDate).first;
    fixture = {
      version: 2,
      schema: 17,
      owner: { accountId: owner.accountId, organizationId: owner.organizationId },
      first,
      actors: [],
      organizations: [],
      cards,
      visits: 10,
    };
    createStorage(directory).close();
  } else {
    safe(directory);
    fixture = JSON.parse(fs.readFileSync(metadata));
    assert.equal(fixture.cards, cards);
    validateFixture(fixture);
    if (firstDate) assert.equal(firstDate, fixture.first, 'Do not change an existing fixture date');
  }
  safe(directory);
  assert.ok(
    count > fixture.organizations.length,
    'Growth must be monotonic; never reseed live rows',
  );
  const database = createPlatformDatabase(path.join(directory, 'platform'), {
    notificationSchema: 17,
  });
  const template = database.open(
    database.db.prepare('SELECT value FROM accounts WHERE id=?').get(fixture.owner.accountId).value,
  );
  const dayAt = (offset) =>
    new Date(Date.parse(fixture.first + 'T00:00:00Z') + offset * 86400000)
      .toISOString()
      .slice(0, 10);
  try {
    for (let index = fixture.organizations.length; index < count; index++) {
      const { org, users } = organizationUsers(index, fixture.owner);
      for (const user of users)
        user.cookie = 'cartoteca_v2_session=' + crypto.randomBytes(32).toString('base64url');
      const providers = users.filter((u) => u.role !== 'salon_admin');
      const roomCount = Math.min(3, providers.length),
        rooms = Array.from({ length: roomCount }, (_, n) => ({
          id: 'r' + n,
          name: 'Synthetic workplace ' + n,
          active: true,
          preventOverlap: true,
          staffMode: 'multiple',
          staffIds: providers.filter((_, p) => p % roomCount === n).map((u) => u.id),
        }));
      const services = providers.flatMap((u) =>
        Array.from({ length: 6 }, (_, n) => ({
          id: u.id + '-s' + n,
          name: 'Synthetic service ' + n,
          staffId: u.id,
          duration: '30',
          price: 500 + n,
        })),
      );
      const now = Date.now();
      const profile = {
        name: 'Synthetic Org ' + index,
        timeZone: 'Europe/Moscow',
        workspace: {
          revision: 1,
          enabled: true,
          mode: 'separate',
          roomLayout: roomCount === 1 ? 'single' : 'multiple',
          rooms,
          staffRules: providers.map((u) => ({ staffId: u.id, preventOverlap: true })),
        },
        onlineBooking: {
          revision: 1,
          mode: 'any',
          bookingMode: 'classic',
          minimumLeadMinutes: 60,
          reservationMinutes: 30,
          showPrices: true,
          staff: {},
          services: {},
        },
        bookingPublication: { enabled: true, revision: 1 },
      };
      database.transaction(() => {
        if (index === 0)
          database.db
            .prepare('UPDATE organizations SET value=? WHERE id=?')
            .run(database.seal(profile), org);
        else
          database.db
            .prepare('INSERT INTO organizations(id,slug,value,created_at) VALUES(?,?,?,?)')
            .run(org, 'synthetic-org-' + index, database.seal(profile), now);
        database.db
          .prepare(
            'INSERT OR REPLACE INTO subscriptions(organization_id,plan,status,limits,changed_at) VALUES(?,?,?,?,?)',
          )
          .run(
            org,
            'paid',
            'active',
            database.seal({
              patients: 20000,
              photos: 10000,
              publicBooking: true,
              automaticNotifications: false,
            }),
            now,
          );
        for (const user of users) {
          if (!(index === 0 && user.role === 'owner')) {
            const email = user.id + '@example.test';
            database.db
              .prepare('INSERT INTO accounts(id,email_hash,value,created_at) VALUES(?,?,?,?)')
              .run(
                user.id,
                database.emailHash(email),
                database.seal({ ...template, email, displayName: user.id }),
                now,
              );
            database.db
              .prepare(
                'INSERT INTO memberships(organization_id,account_id,role,created_at) VALUES(?,?,?,?)',
              )
              .run(org, user.id, user.role, now);
          }
          database.db
            .prepare(
              'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)',
            )
            .run(
              database.tokenHash(user.cookie.split('=')[1]),
              crypto.randomUUID(),
              user.id,
              org,
              database.seal({ createdAt: now, userAgent: 'Synthetic benchmark' }),
              now + 86400000,
            );
          for (let day = 0; day < 35; day++)
            database.db
              .prepare(
                'INSERT INTO work_schedule_days(organization_id,staff_id,date,value) VALUES(?,?,?,?)',
              )
              .run(
                org,
                user.id,
                dayAt(day),
                database.seal({ status: 'working', intervals: [['09:00', '20:00']] }),
              );
        }
      });
      const patients = Array.from({ length: cards }, (_, n) => {
        const staff = providers[n % providers.length],
          id = `p-${index}-${n}`;
        return {
          id,
          firstName: 'Synthetic',
          lastName: 'Client' + n,
          name: 'Synthetic Client' + n,
          phone: '+7' + String(9000000000 + index * 2000 + n),
          createdBy: staff.id,
          visits: Array.from({ length: fixture.visits }, (_, v) => ({
            id: id + '-v' + v,
            date: '2024-01-01',
            staffId: staff.id,
            procedure: 'Synthetic history',
            notes: 'Synthetic history '.repeat(8),
            photos: [],
          })),
          appointments:
            n < 120
              ? [
                  {
                    id: id + '-a',
                    date: dayAt(Math.floor(n / 16)),
                    time:
                      String(9 + Math.floor((n % 16) / 2)).padStart(2, '0') +
                      ':' +
                      (n % 2 ? '30' : '00'),
                    duration: 30,
                    staffId: staff.id,
                    roomId: rooms.find((r) => r.staffIds.includes(staff.id)).id,
                    service: 'Synthetic service',
                    status: 'scheduled',
                  },
                ]
              : [],
        };
      });
      for (const user of users) {
        user.patient = (
          user.role === 'cosmetologist'
            ? patients.find((p) => p.createdBy === user.id)
            : patients[user.role === 'owner' ? 0 : 9]
        ).id;
        user.service = (user.role === 'cosmetologist' ? user.id : providers[0].id) + '-s0';
        user.provider = user.role === 'cosmetologist' ? user.id : providers[0].id;
      }
      const store = createStorage(path.join(directory, 'tenants', org));
      try {
        store.write({ revision: 0, patients, services });
      } finally {
        store.close();
      }
      fixture.organizations.push(org);
      fixture.actors.push(...users);
      if ((index + 1) % 100 === 0)
        console.log(
          JSON.stringify({ seededOrganizations: index + 1, users: fixture.actors.length }),
        );
    }
    assert.equal(database.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(database.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    database.db.close();
  }
  validateFixture(fixture);
  fs.writeFileSync(metadata, JSON.stringify(fixture), { mode: 0o600 });
  return {
    organizations: count,
    accounts: fixture.actors.length,
    cards: count * cards,
    visits: count * cards * fixture.visits,
  };
}
module.exports = { grow, safe, DATA };
if (require.main === module)
  grow('/app', DATA, Number(process.argv[2]), Number(process.argv[3] || 200))
    .then((r) => console.log(JSON.stringify({ seeded: true, ...r })))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
