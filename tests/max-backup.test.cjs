const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');
const { migrateMaxInbox } = require('../src/server/migrations/015-max-inbox.cjs');
const { createMaxInbox } = require('../src/server/modules/notifications/max-inbox.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const {
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
  createBackupKey,
} = require('../src/server/infrastructure/backup/service.cjs');
const {
  prepareNotificationCopy,
  prepareNotificationUpgrade,
} = require('../src/server/migrations/prepare-notifications.cjs');
const { restoreDrill } = require('../src/server/infrastructure/backup/drill.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { rollbackEmptyMaxConnections } = require('../src/server/migrations/012-max-connections.cjs');

function locations(f) {
  const source = path.join(f.dataDir, 'source');
  // The synthetic fixture database is in its platform child; move no directories.
  const directory = path.join(f.dataDir, 'archives'),
    keyFile = path.join(f.dataDir, 'keys', 'backup.key');
  createBackupKey(keyFile);
  return { source, directory, keyFile };
}
function cabinet(dataDir) {
  const storage = createStorage(dataDir);
  storage.write({ revision: 0, services: [], patients: [] });
  storage.close();
}

test('schema 15 full backup validates new encrypted state; restore preserves receipt but pauses bindings, jobs and inbox', async (t) => {
  const f = maxFixture(t, { serverData: true });
  const directory = path.join(f.dataDir, 'archives'),
    keyFile = path.join(f.dataDir, 'keys', 'backup.key');
  // Archives/key must be independent of source, so use a separate synthetic source child.
  const source = path.join(f.dataDir, 'source');
  fs.mkdirSync(source);
  // SQLite snapshot below is committed and synthetic; never copy a live production database.
  f.database.db.exec(
    "VACUUM INTO '" + path.join(source, 'platform.sqlite').replace(/'/g, "''") + "'",
  );
  fs.mkdirSync(path.join(source, 'platform'));
  fs.renameSync(
    path.join(source, 'platform.sqlite'),
    path.join(source, 'platform', 'platform.sqlite'),
  );
  fs.copyFileSync(
    path.join(f.directory, 'platform.key'),
    path.join(source, 'platform', 'platform.key'),
  );
  const platformDir = path.join(source, 'platform');
  const database = createPlatformDatabase(platformDir, { notificationSchema: 12 });
  try {
    migrateNotificationQueue(database, platformDir);
    migrateNotificationChannels(database, platformDir);
    migrateMaxInbox(database, platformDir);
    const store = createNotificationStore(database),
      inbox = createMaxInbox(database);
    const job = store.enqueue(
      {
        org: 'org',
        patient: 'p',
        appointment: 'a',
        stamp: 'stamp',
        channel: 'max',
        recipient: { userId: '789', botId: '123' },
        expiresAt: f.now + 60000,
      },
      f.now,
    );
    const sending = store.claim(f.now);
    assert.equal(store.transition(sending, 'reserved', 'sending'), true);
    assert.equal(store.transition(sending, 'sending', 'sent'), true);
    assert.ok(store.callback(job.decoded.callback));
    const receipt = database.transaction(() => store.confirm(job, f.now));
    store.enqueue(
      {
        org: 'org',
        patient: 'p',
        appointment: 'b',
        stamp: 'other',
        channel: 'max',
        recipient: { userId: '789', botId: '123' },
        expiresAt: f.now + 60000,
      },
      f.now,
    );
    inbox.accept(
      '123',
      {
        update_type: 'bot_started',
        timestamp: f.now,
        user: { user_id: '789', is_bot: false },
        payload: 'x'.repeat(43),
      },
      f.now,
    );
    // Raw synthetic binding avoids using a separate database context.
    database.db.prepare('INSERT INTO max_client_links VALUES(?,?,?,?)').run(
      'org',
      'p',
      database.limitKey('max-client-recipient', JSON.stringify(['123', '789'])),
      database.seal({
        userId: '789',
        botId: '123',
        bindingId: 'synthetic',
        linkedAt: f.now,
        eventAt: f.now,
      }),
    );
    cabinet(source);
    createBackupKey(keyFile);
    const archive = await createV2Backup({ source, directory, keyFile });
    assert.equal(archive.verified, true);
    assert.equal((await verifyV2Backup(archive.file, keyFile)).accounts, 3);
    const restored = path.join(f.dataDir, 'restored');
    await restoreV2Backup(archive.file, keyFile, restored);
    const copy = createPlatformDatabase(path.join(restored, 'platform'), {
      notificationSchema: 15,
    });
    try {
      assert.equal(copy.db.prepare('PRAGMA user_version').get().user_version, 15);
      const restoredStore = createNotificationStore(copy);
      assert.equal(
        restoredStore.confirmed('org', 'p', 'a', 'stamp').notificationConfirmedAt,
        receipt.notificationConfirmedAt,
      );
      assert.equal(
        copy.open(copy.db.prepare('SELECT value FROM max_client_links').get().value).restoredPaused,
        true,
      );
      assert.equal(
        copy.db
          .prepare(
            "SELECT count(*) n FROM notification_channel_jobs WHERE status IN ('pending','reserved','sending')",
          )
          .get().n,
        0,
      );
      assert.equal(
        copy.db
          .prepare(
            "SELECT count(*) n FROM max_event_inbox WHERE status IN ('pending','processing')",
          )
          .get().n,
        0,
      );
      assert.equal(copy.db.prepare('SELECT count(*) n FROM max_client_tokens').get().n, 0);
      assert.equal(restoredStore.callback(job.decoded.callback), null);
    } finally {
      copy.db.close();
    }
    assert.equal(
      (await restoreDrill(archive.file, keyFile, path.join(f.dataDir, 'drills'))).started,
      true,
    );
    database.db.prepare('UPDATE max_event_inbox SET value=randomblob(80)').run();
    await assert.rejects(createV2Backup({ source, directory, keyFile }));
  } finally {
    database.db.close();
  }
});

test('offline upgrade preserves sessions, Telegram settings, delivered callback and all baseline ciphertexts', async (t) => {
  const f = maxFixture(t, { serverData: true });
  rollbackEmptyMaxConnections(f.database);
  const { db, seal, tokenHash } = f.database;
  db.prepare('INSERT INTO platform_sessions VALUES(?,?,?,?,?,?)').run(
    'synthetic-session-hash',
    'synthetic-session',
    'owner',
    'org',
    seal({ accountId: 'owner' }),
    f.now + 3600000,
  );
  db.prepare('INSERT INTO telegram_settings VALUES(?,?)').run(
    'org',
    seal({ enabled: true, leadMinutes: 1440 }),
  );
  db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?)').run(
    'org',
    'p',
    'synthetic-chat-hash',
    seal({ chatId: '789', linkedAt: f.now }),
  );
  db.prepare('INSERT INTO telegram_link_tokens VALUES(?,?,?,?,?,?)').run(
    'synthetic-link',
    'org',
    'p',
    'owner',
    f.now + 3600000,
    null,
  );
  const jobToken = 'synthetic_delivered_callback';
  db.prepare('INSERT INTO telegram_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    'synthetic-job',
    'org',
    'p',
    'synthetic-fingerprint',
    tokenHash(jobToken),
    seal({ callback: jobToken, chatId: '789' }),
    'sent',
    1,
    f.now,
    0,
    f.now + 3600000,
  );
  db.prepare('INSERT INTO telegram_runtime VALUES(?,?)').run('cursor', seal({ offset: 42 }));
  const tables = [
    'accounts',
    'platform_sessions',
    'telegram_settings',
    'telegram_links',
    'telegram_link_tokens',
    'telegram_jobs',
    'telegram_runtime',
  ];
  const before = Object.fromEntries(
    tables.map((table) => [table, db.prepare('SELECT * FROM ' + table).all()]),
  );
  const source = path.join(f.dataDir, 'upgrade-source'),
    platformDir = path.join(source, 'platform');
  fs.mkdirSync(platformDir, { recursive: true });
  db.exec("VACUUM INTO '" + path.join(platformDir, 'platform.sqlite').replace(/'/g, "''") + "'");
  fs.copyFileSync(path.join(f.directory, 'platform.key'), path.join(platformDir, 'platform.key'));
  cabinet(source);
  const { directory, keyFile } = locations(f);
  const destination = path.join(f.dataDir, 'normal-upgrade');
  const result = await prepareNotificationUpgrade({ source, destination, directory, keyFile });
  assert.equal(result.notificationsPaused, false);
  assert.equal(result.sessionsRevoked, false);
  assert.equal(result.requiresStoppedSourceBeforeSwitch, true);
  const copy = createPlatformDatabase(path.join(destination, 'platform'), {
    notificationSchema: 15,
  });
  const original = createPlatformDatabase(platformDir);
  try {
    for (const table of tables) {
      assert.deepEqual(copy.db.prepare('SELECT * FROM ' + table).all(), before[table], table);
      assert.deepEqual(original.db.prepare('SELECT * FROM ' + table).all(), before[table], table);
    }
    assert.equal(original.db.prepare('PRAGMA user_version').get().user_version, 11);
    // A later disaster restore of the upgraded archive STILL revokes credentials.
    const restored = path.join(f.dataDir, 'upgrade-disaster-restore');
    await restoreV2Backup(result.preparedArchive, keyFile, restored);
    const recovery = createPlatformDatabase(path.join(restored, 'platform'), {
      notificationSchema: 15,
    });
    try {
      assert.equal(recovery.db.prepare('SELECT count(*) n FROM platform_sessions').get().n, 0);
      assert.equal(
        recovery.open(recovery.db.prepare('SELECT value FROM telegram_settings').get().value)
          .enabled,
        false,
      );
    } finally {
      recovery.db.close();
    }
  } finally {
    copy.db.close();
    original.db.close();
  }
});

test('preparation upgrades only a separate recovered copy, baseline source and accounts stay unchanged', async (t) => {
  const f = maxFixture(t, { serverData: true });
  rollbackEmptyMaxConnections(f.database);
  const source = path.join(f.dataDir, 'source'),
    platformDir = path.join(source, 'platform');
  fs.mkdirSync(platformDir, { recursive: true });
  f.database.db.exec(
    "VACUUM INTO '" + path.join(platformDir, 'platform.sqlite').replace(/'/g, "''") + "'",
  );
  fs.copyFileSync(path.join(f.directory, 'platform.key'), path.join(platformDir, 'platform.key'));
  cabinet(source);
  const { directory, keyFile } = locations(f);
  const before = f.database.db.prepare('SELECT value FROM accounts WHERE id=?').get('owner').value;
  const destination = path.join(f.dataDir, 'prepared');
  const result = await prepareNotificationCopy({ source, destination, directory, keyFile });
  assert.equal(result.schema, 15);
  assert.equal(result.sourceUnchanged, true);
  const original = createPlatformDatabase(platformDir);
  const prepared = createPlatformDatabase(path.join(destination, 'platform'), {
    notificationSchema: 15,
  });
  try {
    assert.equal(original.db.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(prepared.db.prepare('PRAGMA user_version').get().user_version, 15);
    assert.deepEqual(
      original.db.prepare('SELECT value FROM accounts WHERE id=?').get('owner').value,
      before,
    );
    assert.deepEqual(
      prepared.db.prepare('SELECT value FROM accounts WHERE id=?').get('owner').value,
      before,
    );
    assert.equal(fs.existsSync(path.join(destination, '.restore-in-progress')), false);
    assert.ok(result.beforeArchive);
    assert.ok(result.preparedArchive);
  } finally {
    original.db.close();
    prepared.db.close();
  }
  await assert.rejects(
    prepareNotificationCopy({ source, destination, directory, keyFile }),
    /separate new destination/,
  );
});
