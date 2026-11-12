const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes, createCipheriv } = require('node:crypto');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../storage.cjs');
const {
  createV2Backup,
  restoreV2Backup,
  createBackupKey,
} = require('../src/server/infrastructure/backup/service.cjs');
const {
  prepareOrganizationRestore,
} = require('../src/server/infrastructure/backup/organization-restore.cjs');
const password = 'Synthetic-personal-backup-password';
async function fixture(t, withHistorical = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-personal-backup-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, 'source'),
    platform = createPlatformStore(path.join(source, 'platform'));
  const owners = [],
    tokens = [];
  try {
    for (let i = 0; i < 2; i++) {
      const owner = await platform.registerOwner({
        email: 'personal-backup-' + i + '@example.test',
        password,
        displayName: 'Synthetic owner ' + i,
        organizationName: 'Synthetic organization ' + i,
      });
      platform.verifyEmail(owner.verificationToken);
      owners.push(owner);
      tokens.push((await platform.login('personal-backup-' + i + '@example.test', password)).token);
      const storage = createStorage(path.join(source, 'tenants', owner.organizationId));
      try {
        storage.write({ revision: 0, patients: [], services: [] });
      } finally {
        storage.close();
      }
    }
    const invitation = platform.createInvitation({
      organizationId: owners[0].organizationId,
      invitedBy: owners[0].accountId,
      role: 'cosmetologist',
    });
    const unaffectedStaff = await platform.acceptInvitation({
      token: invitation.token,
      email: 'unaffected-staff@example.test',
      password,
      displayName: 'Unaffected synthetic staff',
    });
    const event = {
      id: randomUUID(),
      date: '2090-02-01',
      time: '23:30',
      duration: 60,
      staffId: owners[0].accountId,
      notes: 'HISTORICAL PERSONAL NOTE',
    };
    if (withHistorical) {
      const storage = createStorage(path.join(source, 'tenants', owners[0].organizationId));
      try {
        await platform.personalEvents.save(
          tokens[0],
          { revision: 0, event },
          storage,
          owners[0].organizationId,
        );
      } finally {
        storage.close();
      }
    }
    return { dir, source, owners, tokens, event, unaffectedStaff };
  } finally {
    platform.close();
  }
}
const readProfile = (raw, org) =>
  raw.open(raw.db.prepare('SELECT value FROM organizations WHERE id=?').get(org).value);
const writeProfile = (raw, org, value) =>
  raw.db.prepare('UPDATE organizations SET value=? WHERE id=?').run(raw.seal(value), org);
test('full encrypted backup restores personal events with the organization and no patient/service surrogate', async (t) => {
  const f = await fixture(t),
    keyFile = path.join(f.dir, 'backup.key');
  createBackupKey(keyFile);
  const backup = await createV2Backup({
    source: f.source,
    directory: path.join(f.dir, 'archives'),
    keyFile,
  });
  assert.doesNotMatch(fs.readFileSync(backup.file).toString('utf8'), /HISTORICAL PERSONAL NOTE/);
  const destination = path.join(f.dir, 'restored');
  await restoreV2Backup(backup.file, keyFile, destination);
  const platform = createPlatformStore(path.join(destination, 'platform'));
  try {
    const token = (await platform.login('personal-backup-0@example.test', password)).token;
    assert.deepEqual(platform.personalEvents.view(platform.session(token)).personalEvents, [
      f.event,
    ]);
    const cabinet = createStorage(path.join(destination, 'tenants', f.owners[0].organizationId));
    try {
      assert.equal(cabinet.read().patients.length, 0);
      assert.equal(cabinet.read().services.length, 0);
    } finally {
      cabinet.close();
    }
  } finally {
    platform.close();
  }
});
for (const withHistorical of [true, false])
  test(`organization restore preserves current identity/other organizations and ${withHistorical ? 'restores historical' : 'clears post-backup'} personal events`, async (t) => {
    const f = await fixture(t, withHistorical),
      keyFile = path.join(f.dir, 'backup.key');
    createBackupKey(keyFile);
    const archive = (
      await createV2Backup({ source: f.source, directory: path.join(f.dir, 'archives'), keyFile })
    ).file;
    const raw = createPlatformDatabase(path.join(f.source, 'platform'));
    const currentEvent = {
      ...f.event,
      id: randomUUID(),
      time: '08:00',
      notes: 'CURRENT PERSONAL NOTE',
    };
    const currentVersions = {
      [f.owners[0].accountId]: randomUUID(),
      [f.unaffectedStaff.accountId]: randomUUID(),
    };
    let unrelated, unrelatedCiphertext, currentProfile;
    try {
      const profile = readProfile(raw, f.owners[0].organizationId);
      currentProfile = {
        ...profile,
        city: 'CURRENT CITY',
        serviceGroups: { revision: 9, groups: [{ id: 'other', title: 'Другое' }] },
        personalEvents: { version: 1, revision: 7, events: [currentEvent] },
        calendarPersonalVersions: currentVersions,
      };
      writeProfile(raw, f.owners[0].organizationId, currentProfile);
      const other = readProfile(raw, f.owners[1].organizationId);
      unrelated = {
        ...other,
        calendarPersonalVersions: { [f.owners[1].accountId]: randomUUID() },
        personalEvents: {
          version: 1,
          revision: 3,
          events: [{ ...currentEvent, staffId: f.owners[1].accountId }],
        },
      };
      writeProfile(raw, f.owners[1].organizationId, unrelated);
      unrelatedCiphertext = Buffer.from(
        raw.db.prepare('SELECT value FROM organizations WHERE id=?').get(f.owners[1].organizationId)
          .value,
      );
    } finally {
      raw.db.close();
    }
    const jobDirectory = path.join(f.dir, 'job');
    await prepareOrganizationRestore({
      source: f.source,
      archive,
      keyFile,
      jobDirectory,
      organizationId: f.owners[0].organizationId,
    });
    const candidate = createPlatformDatabase(path.join(jobDirectory, 'candidate', 'platform'));
    try {
      const recovered = readProfile(candidate, f.owners[0].organizationId);
      assert.equal(recovered.city, 'CURRENT CITY');
      assert.equal(recovered.serviceGroups.revision, 9);
      assert.equal(recovered.personalEvents.revision, 8);
      assert.deepEqual(recovered.personalEvents.events, withHistorical ? [f.event] : []);
      assert.notEqual(
        recovered.calendarPersonalVersions[f.owners[0].accountId],
        currentVersions[f.owners[0].accountId],
      );
      assert.match(
        recovered.calendarPersonalVersions[f.owners[0].accountId],
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(
        recovered.calendarPersonalVersions[f.unaffectedStaff.accountId],
        currentVersions[f.unaffectedStaff.accountId],
      );
      const protectedProfile = (value) =>
        Object.fromEntries(
          Object.entries(value).filter(
            ([name]) => !['personalEvents', 'calendarPersonalVersions'].includes(name),
          ),
        );
      assert.deepEqual(protectedProfile(recovered), protectedProfile(currentProfile));
      assert.deepEqual(readProfile(candidate, f.owners[1].organizationId), unrelated);
      assert.deepEqual(
        Buffer.from(
          candidate.db
            .prepare('SELECT value FROM organizations WHERE id=?')
            .get(f.owners[1].organizationId).value,
        ),
        unrelatedCiphertext,
      );
    } finally {
      candidate.db.close();
    }
    const live = createPlatformDatabase(path.join(f.source, 'platform'));
    try {
      assert.deepEqual(
        readProfile(live, f.owners[0].organizationId).calendarPersonalVersions,
        currentVersions,
      );
      assert.deepEqual(readProfile(live, f.owners[0].organizationId).personalEvents.events, [
        currentEvent,
      ]);
    } finally {
      live.db.close();
    }
  });

const {
  assertOrganizationsPreserved,
} = require('../src/server/infrastructure/backup/organization-personal-calendar.cjs');
function guardFixture({ versions = true } = {}) {
  const key = randomBytes(32);
  const seal = (profile) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(profile)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  };
  const before = {
    name: 'CURRENT ORGANIZATION',
    timeZone: 'Europe/Moscow',
    workspace: { enabled: true, rooms: [{ id: 'main', staffIds: ['a', 'b'] }] },
    serviceGroups: { revision: 9, groups: [] },
    calendarPersonalVersions: { a: randomUUID(), b: randomUUID(), c: randomUUID() },
    personalEvents: {
      version: 1,
      revision: 7,
      events: [
        {
          id: randomUUID(),
          date: '2090-02-01',
          time: '10:00',
          duration: 60,
          staffId: 'a',
          notes: '',
        },
        {
          id: randomUUID(),
          date: '2090-02-01',
          time: '14:00',
          duration: 60,
          staffId: 'b',
          notes: '',
        },
      ],
    },
  };
  if (!versions) delete before.calendarPersonalVersions;
  const original = [
    { id: 'target', status: 'active', value: seal(before) },
    {
      id: 'other',
      status: 'active',
      value: seal({ name: 'OTHER', calendarPersonalVersions: { other: randomUUID() } }),
    },
  ];
  const after = structuredClone(before);
  after.personalEvents.events[0].time = '11:00';
  after.personalEvents.revision++;
  after.calendarPersonalVersions ||= {};
  after.calendarPersonalVersions.a = randomUUID();
  return {
    before,
    after,
    verify(profile = after, row = {}, changeOther = false) {
      const actual = [{ ...original[0], ...row, value: seal(profile) }, original[1]];
      if (changeOther) actual[1] = { ...original[1], value: seal({ name: 'CHANGED OTHER' }) };
      return assertOrganizationsPreserved(original, actual, 'target', key);
    },
  };
}
test('restore guard accepts only affected occupancy invalidations and keeps unaffected versions exact', () => {
  const f = guardFixture();
  assert.doesNotThrow(() => f.verify());
  const reassigned = structuredClone(f.before);
  reassigned.personalEvents.events[0].staffId = 'b';
  reassigned.calendarPersonalVersions.a = randomUUID();
  reassigned.calendarPersonalVersions.b = randomUUID();
  assert.doesNotThrow(() => f.verify(reassigned));
  const missingPreviousOwner = structuredClone(reassigned);
  missingPreviousOwner.calendarPersonalVersions.a = f.before.calendarPersonalVersions.a;
  assert.throws(
    () => f.verify(missingPreviousOwner),
    /Current identity, access or subscription changed/,
  );
  const firstVersion = guardFixture({ versions: false });
  assert.doesNotThrow(() => firstVersion.verify());
  const unrelatedVersion = structuredClone(firstVersion.after);
  unrelatedVersion.calendarPersonalVersions.b = randomUUID();
  assert.throws(
    () => firstVersion.verify(unrelatedVersion),
    /Current identity, access or subscription changed/,
  );
});
for (const [name, change] of [
  [
    'organization name',
    (next) => {
      next.name = 'HISTORICAL ORGANIZATION';
    },
  ],
  [
    'time zone',
    (next) => {
      next.timeZone = 'UTC';
    },
  ],
  [
    'room access',
    (next) => {
      next.workspace.rooms[0].staffIds = [];
    },
  ],
  [
    'service groups',
    (next) => {
      next.serviceGroups.revision++;
    },
  ],
  [
    'unaffected staff version',
    (next) => {
      next.calendarPersonalVersions.b = randomUUID();
    },
  ],
  [
    'unrelated version key',
    (next) => {
      next.calendarPersonalVersions.outsider = randomUUID();
    },
  ],
  [
    'missing unaffected version',
    (next) => {
      delete next.calendarPersonalVersions.c;
    },
  ],
  [
    'missing affected version',
    (next) => {
      delete next.calendarPersonalVersions.a;
    },
  ],
  [
    'malformed affected version',
    (next) => {
      next.calendarPersonalVersions.a = 'changed';
    },
  ],
  [
    'stale affected version',
    (next, before) => {
      next.calendarPersonalVersions.a = before.calendarPersonalVersions.a;
    },
  ],
  [
    'notes-only version change',
    (next, before) => {
      next.personalEvents.events[0].time = before.personalEvents.events[0].time;
      next.personalEvents.events[0].notes = 'NOTE CHANGE DOES NOT INVALIDATE ICS';
    },
  ],
])
  test('restore guard rejects changes to ' + name, () => {
    const f = guardFixture(),
      next = structuredClone(f.after);
    change(next, f.before);
    assert.throws(() => f.verify(next), /Current identity, access or subscription changed/);
  });
test('restore guard retains relational organization status and every other organization ciphertext', () => {
  const f = guardFixture();
  assert.throws(
    () => f.verify(f.after, { status: 'suspended' }),
    /Current identity, access or subscription changed/,
  );
  assert.throws(
    () => f.verify(f.after, {}, true),
    /Current identity, access or subscription changed/,
  );
});
