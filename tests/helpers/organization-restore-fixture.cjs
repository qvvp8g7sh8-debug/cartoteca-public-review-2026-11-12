const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createStorage } = require('../../storage.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const {
  createV2Backup,
  createBackupKey,
} = require('../../src/server/infrastructure/backup/service.cjs');

async function organizationRestoreFixture(t, version = 11) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-organization-restore-'));
  t.after(() => {
    if (
      path.dirname(directory) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith('cartoteca-organization-restore-')
    )
      fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source'),
    platformDir = path.join(source, 'platform');
  const platform = createPlatformStore(platformDir),
    owners = [];
  try {
    for (let i = 0; i < 3; i++) {
      const owner = await platform.registerOwner({
        email: `org${i}@example.test`,
        password: 'Synthetic-restore-password-2026',
        displayName: 'Synthetic owner',
        organizationName: 'Synthetic organization ' + i,
      });
      platform.verifyEmail(owner.verificationToken);
      owners.push(owner);
    }
    platform.telegram.saveSettings(owners[0].organizationId, owners[0].accountId, {
      enabled: true,
      leadMinutes: 120,
      timeZone: 'Europe/Moscow',
      showServices: true,
    });
    const token = platform.telegram.issueLink(owners[0].organizationId, 'p', owners[0].accountId);
    platform.telegram.consumeLink(token, 'synthetic-chat', () => true);
  } finally {
    platform.close();
  }
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#345678' } })
    .png()
    .toBuffer();
  for (const owner of owners) {
    const storage = createStorage(path.join(source, 'tenants', owner.organizationId));
    try {
      storage.write({
        revision: 0,
        services: [],
        patients: [
          {
            id: 'p',
            name: 'Synthetic patient',
            createdBy: owner.accountId,
            notes: 'OLD PRIVATE NOTE',
            visits: [
              {
                id: 'v',
                date: '2020-01-01',
                staffId: owner.accountId,
                procedure: 'Synthetic',
                photos: [{ data: 'data:image/png;base64,' + image.toString('base64') }],
              },
            ],
            appointments: [
              {
                id: 'a',
                date: '2035-01-01',
                time: '10:00',
                duration: 30,
                service: 'Synthetic',
                staffId: owner.accountId,
              },
            ],
          },
        ],
      });
    } finally {
      storage.close();
    }
  }
  const legacy = createStorage(source);
  legacy.write({ revision: 0, patients: [], services: [] });
  legacy.close();
  const db = createPlatformDatabase(platformDir);
  try {
    if (version >= 12)
      require('../../src/server/migrations/012-max-connections.cjs').migrateMaxConnections(
        db,
        platformDir,
      );
    if (version >= 13)
      require('../../src/server/migrations/013-notification-queue.cjs').migrateNotificationQueue(
        db,
        platformDir,
      );
    if (version >= 14)
      require('../../src/server/migrations/014-notification-channels.cjs').migrateNotificationChannels(
        db,
        platformDir,
      );
    if (version >= 15)
      require('../../src/server/migrations/015-max-inbox.cjs').migrateMaxInbox(db, platformDir);
    if (version >= 16)
      require('../../src/server/migrations/016-staff-max.cjs').migrateStaffMax(db, platformDir);
    if(version>=17)require('../../src/server/migrations/017-staff-push.cjs').migrateStaffPush(db,platformDir);
    if(version>=18)require('../../src/server/migrations/018-notification-schedule.cjs').migrateNotificationSchedule(db,platformDir);
    if(version>=19)require('../../src/server/migrations/019-paid-services.cjs').migratePaidServices(db,platformDir);
    if(version>=20)require('../../src/server/migrations/020-multi-service-billing.cjs').migrateMultiServiceBilling(db,platformDir,{offline:true});
    const org = owners[0].organizationId,
      staff = owners[0].accountId;
    db.db
      .prepare('INSERT INTO work_schedule_profiles VALUES(?,?,?)')
      .run(org, staff, db.seal({ revision: 1, allowSelfEdit: false }));
    db.db
      .prepare('INSERT INTO work_schedule_days VALUES(?,?,?,?)')
      .run(
        org,
        staff,
        '2035-01-01',
        db.seal({ status: 'working', intervals: [['09:00', '17:00']] }),
      );
    db.db
      .prepare('INSERT INTO booking_requests VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        'synthetic-request',
        org,
        staff,
        'synthetic-key',
        db.seal({ staffId: staff, kind: 'other-time' }),
        'pending',
        Date.now() + 60000,
        'synthetic-day',
        Date.now(),
        0,
      );
    if (version >= 12)
      for (const [index, owner] of owners.entries())
        db.db.prepare('INSERT INTO max_client_links VALUES(?,?,?,?)').run(
          owner.organizationId,
          'p',
          'recipient-' + index,
          db.seal({
            bindingId: 'synthetic-binding-' + index,
            botId: 'synthetic-bot',
            recipient: 'synthetic-recipient-' + index,
            restoredPaused: false,
          }),
        );
    if (version >= 13)
      for (const [index, owner] of owners.entries()) {
        db.db
          .prepare(
            'INSERT INTO notification_jobs(id,organization_id,patient_id,appointment_id,stamp,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            'synthetic-job-' + index,
            owner.organizationId,
            'p',
            'a',
            'synthetic-stamp',
            'synthetic-callback-' + index,
            db.seal({ channel: 'max', recipient: 'synthetic-recipient-' + index }),
            'pending',
            0,
            Date.now() + 60000,
          );
        db.db
          .prepare('INSERT INTO notification_confirmations VALUES(?,?,?,?,?)')
          .run(
            owner.organizationId,
            'p',
            'a',
            'synthetic-stamp',
            db.seal({ confirmedAt: 123, channel: 'max' }),
          );
      }
    if (version >= 16)
      for (const [index, owner] of owners.entries())
        db.db.prepare('INSERT INTO staff_max_links VALUES(?,?,?,?)').run(
          owner.organizationId,
          owner.accountId,
          'synthetic-chat-' + index,
          db.seal({
            bindingId: 'staff-binding-' + index,
            enabled: true,
            chatId: 'synthetic-staff-' + index,
          }),
        );
  } finally {
    db.db.close();
  }
  const keyFile = path.join(directory, 'keys', 'backup.key');
  createBackupKey(keyFile);
  const archive = (
    await createV2Backup({ source, directory: path.join(directory, 'archives'), keyFile })
  ).file;
  for (const owner of owners) {
    const storage = createStorage(path.join(source, 'tenants', owner.organizationId));
    try {
      const state = storage.read();
      state.patients[0].notes = 'CURRENT PRIVATE NOTE';
      storage.write(state);
    } finally {
      storage.close();
    }
  }
  fs.writeFileSync(
    path.join(source, 'platform', 'operator-note.txt'),
    'synthetic retained metadata',
  );
  fs.writeFileSync(
    path.join(source, 'tenants', owners[1].organizationId, 'photos', 'orphan.enc'),
    'synthetic unrelated orphan',
  );
  const jobDirectory = path.join(directory, 'job');
  return {
    directory,
    source,
    keyFile,
    archive,
    owners,
    version,
    jobDirectory,
    options: { source, archive, keyFile, jobDirectory, organizationId: owners[0].organizationId },
    openPlatform: () => createPlatformDatabase(platformDir, { notificationSchema: version }),
  };
}
module.exports = { organizationRestoreFixture };
