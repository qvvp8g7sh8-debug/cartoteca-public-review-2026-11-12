const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { openValue, readKey } = require('./snapshot.cjs');
const { digest, validName } = require('./archive.cjs');
const { notificationBlobs, pauseRestoredNotifications } = require('./notification-state.cjs');
const { createPatientRecords } = require('../cabinet-records.cjs');
const readBudget = require('../booking-read-budget-store.cjs');
const publicLinks = require('../booking-public-links-schema.cjs');
const notificationMaintenance = require('../notification-maintenance-schema.cjs');
const {
  assistantContext,
  validateAssistantSnapshot,
  resetRestoredAssistantRows,
} = require('./assistant-state.cjs');
const { billingBlobs, validatePaidSchema } = require('../../modules/billing/prepared-schema.cjs');
const {
  stateName,
  readStateBytes,
  resetRestoredAssistant,
} = require('../../modules/assistant/access/store.cjs');
const { personalCollection } = require('../../../shared/personal-calendar.cjs');
const platformBlobs = {
  accounts: 'value',
  organizations: 'value',
  subscriptions: 'limits',
  platform_sessions: 'value',
  telegram_settings: 'value',
  telegram_links: 'value',
  telegram_jobs: 'value',
  telegram_runtime: 'value',
};
const cabinetBlobs = {
  meta: 'value',
  patients: 'value',
  services: 'value',
  sessions: 'value',
  cabinet_summaries: 'value',
  cabinet_appointments: 'value',
};
function seal(key, value) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}
function validateDatabase(filename, key, blobs, version) {
  const platformSchema = blobs === platformBlobs;
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Backup database integrity check failed.');
    const actualVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (!(Array.isArray(version) ? version : [version]).includes(actualVersion))
      throw Error('Unsupported backup schema version.');
    if (blobs === cabinetBlobs && actualVersion === 2)
      blobs = { ...blobs, cabinet_patient_records: 'value' };
    if (platformSchema && actualVersion >= 4)
      blobs = { ...blobs, appointment_manual_confirmations: 'value' };
    if (platformSchema && actualVersion >= 5) blobs = { ...blobs, support_requests: 'value' };
    if (platformSchema && actualVersion >= 7)
      blobs = { ...blobs, work_schedule_profiles: 'value', work_schedule_days: 'value' };
    if (platformSchema && actualVersion >= 8) blobs = { ...blobs, email_invitations: 'value' };
    if (platformSchema && actualVersion >= 9) blobs = { ...blobs, booking_requests: 'value' };
    if (platformSchema && actualVersion >= 10)
      blobs = { ...blobs, staff_telegram_links: 'value', staff_notification_jobs: 'value' };
    if (platformSchema && actualVersion >= 11)
      blobs = {
        ...blobs,
        admin_operations: 'value',
        admin_audit_details: 'value',
        admin_directory_records: 'source_value',
        admin_email_recoveries: 'value',
        admin_email_jobs: 'value',
        support_messages: 'value',
      };
    if (platformSchema && actualVersion >= 19) {
      validatePaidSchema(db);
      blobs = {
        ...blobs,
        ...billingBlobs,
        ...(actualVersion >= 20 ? { billing_financial_actions: 'value' } : {}),
      };
    }
    if (platformSchema) {
      publicLinks.validate(db);
      notificationMaintenance.validate(db);
      blobs = { ...blobs, ...notificationBlobs(actualVersion) };
    }
    for (const [table, column] of Object.entries(blobs))
      for (const row of db.prepare('SELECT ' + column + ' FROM ' + table).iterate())
        JSON.parse(openValue(key, row[column]).toString('utf8'));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
async function validateRecovered(directory, seen) {
  const manifestFile = path.join(directory, 'manifest.json');
  if (fs.statSync(manifestFile).size > 32 * 1024 * 1024) throw Error('Excessive manifest size.');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (
    manifest.format !== 2 ||
    !Array.isArray(manifest.cabinets) ||
    !Array.isArray(manifest.organizations) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== seen.size - 1
  )
    throw Error('Incomplete v2 backup manifest.');
  const listed = new Set();
  for (const file of manifest.files) {
    if (
      !validName(file.name) ||
      file.name === 'manifest.json' ||
      listed.has(file.name) ||
      !seen.has(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw Error('Invalid backup manifest entry.');
    listed.add(file.name);
    const target = path.join(directory, file.name);
    if (fs.statSync(target).size !== file.size || (await digest(target)) !== file.sha256)
      throw Error('Backup file checksum mismatch.');
  }
  for (const name of ['platform/platform.sqlite', 'platform/platform.key'])
    if (!listed.has(name)) throw Error('Platform backup is missing.');
  const platform = validateDatabase(
    path.join(directory, 'platform', 'platform.sqlite'),
    readKey(path.join(directory, 'platform', 'platform.key')),
    platformBlobs,
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  );
  const counts = { accounts: 0, organizations: 0, cabinets: 0, patients: 0, photos: 0 },
    roots = new Set();
  try {
    const assistantBytes = readStateBytes(path.join(directory, 'platform'));
    if (listed.has('platform/' + stateName) !== Boolean(assistantBytes))
      throw Error('Assistant backup inventory mismatch.');
    validateAssistantSnapshot(
      assistantContext(
        platform,
        readKey(path.join(directory, 'platform', 'platform.key')),
        path.join(directory, 'platform'),
      ),
    );
    const budgetRecord = readBudget.registration(platform),
      budgetName = 'platform/' + readBudget.filename;
    if (listed.has(budgetName) !== Boolean(budgetRecord))
      throw Error('Booking read-budget backup registration mismatch.');
    readBudget.validateFile(path.join(directory, 'platform'), budgetRecord);
    readBudget.validateLegacyGuards(platform, budgetRecord);
    if (budgetRecord) {
      const budget = validateDatabase(path.join(directory, budgetName), null, {}, 1);
      try {
        readBudget.validate(budget, budgetRecord);
        if (
          budget
            .prepare(
              'SELECT 1 FROM login_limits WHERE key IS NULL OR NOT (' +
                readBudget.readWhere +
                ') LIMIT 1',
            )
            .get()
        )
          throw Error('Unexpected booking read-budget counter.');
      } finally {
        budget.close();
      }
    }
    counts.accounts = platform.prepare('SELECT count(*) n FROM accounts').get().n;
    counts.organizations = platform.prepare('SELECT count(*) n FROM organizations').get().n;
    for (const root of manifest.cabinets) {
      if (
        typeof root !== 'string' ||
        (root !== '' && !/^tenants\/[a-zA-Z0-9_-]{1,120}$/.test(root)) ||
        roots.has(root)
      )
        throw Error('Invalid cabinet inventory.');
      roots.add(root);
      const prefix = root ? root + '/' : '';
      if (!listed.has(prefix + 'cabinet.sqlite') || !listed.has(prefix + 'encryption.key'))
        throw Error('Cabinet backup is missing.');
      const key = readKey(path.join(directory, prefix + 'encryption.key')),
        db = validateDatabase(
          path.join(directory, prefix + 'cabinet.sqlite'),
          key,
          cabinetBlobs,
          [1, 2],
        );
      try {
        counts.cabinets++;
        counts.patients += db.prepare('SELECT count(*) n FROM patients').get().n;
        const active = new Set(
          db
            .prepare('SELECT id FROM photos WHERE active=1')
            .all()
            .map((row) => row.id),
        );
        for (const id of active) {
          const name = prefix + 'photos/' + id + '.enc';
          if (!listed.has(name)) throw Error('Active photograph is missing.');
          openValue(key, fs.readFileSync(path.join(directory, name)));
          counts.photos++;
        }
        const decode = (value) => JSON.parse(openValue(key, value).toString('utf8'));
        const records = createPatientRecords({ db, decode });
        for (const row of db.prepare('SELECT id,value FROM patients').iterate())
          for (const visit of (records ? records.hydrate([row])[0] : decode(row.value)).visits ||
            [])
            for (const photo of visit.photos || []) {
              const match = photo.data?.match(/^\/api\/photos\/([a-f0-9]{32})$/);
              if (!match || !active.has(match[1]))
                throw Error('Invalid clinical photograph reference.');
            }
      } finally {
        db.close();
      }
    }
    for (const name of listed) {
      if (name.startsWith('platform/')) continue;
      const match = name.match(/^(tenants\/[^/]+)\//);
      if (!roots.has(match ? match[1] : '')) throw Error('Unlisted cabinet in backup.');
    }
    const platformKey = readKey(path.join(directory, 'platform', 'platform.key'));
    const organizationIds = new Set();
    if (manifest.organizations.length !== counts.organizations)
      throw Error('Incomplete organization inventory.');
    for (const row of platform.prepare('SELECT id,value FROM organizations').iterate()) {
      const profile = JSON.parse(openValue(platformKey, row.value).toString('utf8'));
      personalCollection(profile.personalEvents);
      const legacy = profile.legacyData;
      const root = legacy ? '' : 'tenants/' + row.id,
        entry = manifest.organizations.find((entry) => entry.id === row.id);
      if (
        !entry ||
        organizationIds.has(entry.id) ||
        entry.root !== root ||
        entry.initialized !== roots.has(root) ||
        (legacy && !roots.has(''))
      )
        throw Error('Organization backup inventory mismatch.');
      organizationIds.add(entry.id);
    }
    return { manifest, counts };
  } finally {
    platform.close();
  }
}
function revokeRestoredCredentials(directory, manifest) {
  const filename = path.join(directory, 'platform', 'platform.sqlite'),
    key = readKey(path.join(directory, 'platform', 'platform.key')),
    db = new DatabaseSync(filename);
  let restoredRows = false;
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(
      'BEGIN IMMEDIATE; DELETE FROM platform_sessions; DELETE FROM password_resets; DELETE FROM email_verifications; DELETE FROM invitations; DELETE FROM admin_bootstraps; DELETE FROM telegram_link_tokens;',
    );
    // An old archive must not reactivate revoked Apple or Google feed links.
    const updateAccount = db.prepare('UPDATE accounts SET value=? WHERE id=?');
    for (const row of db.prepare('SELECT id,value FROM accounts').all()) {
      const account = JSON.parse(openValue(key, row.value).toString('utf8'));
      if (
        !Object.hasOwn(account, 'calendarSubscriptions') &&
        !Object.hasOwn(account, 'adminMfaPending') &&
        !account.adminMfa?.enabled
      )
        continue;
      delete account.calendarSubscriptions;
      delete account.adminMfaPending;
      // A disaster archive cannot know which backup codes were spent afterwards.
      // Keep the authenticator, but never resurrect an old one-use recovery code.
      if (account.adminMfa?.enabled) account.adminMfa = { ...account.adminMfa, recoveryHashes: [] };
      updateAccount.run(seal(key, account), row.id);
    }
    // Revoke credentials, not the active public-read budget. Legacy mode after
    // rollback keeps its current windows here; isolated mode retains its own DB.
    db.prepare('DELETE FROM login_limits WHERE NOT (' + readBudget.readWhere + ')').run();
    db.prepare("DELETE FROM telegram_runtime WHERE key='poll-leader'").run();
    if (db.prepare('PRAGMA user_version').get().user_version >= 10) {
      db.prepare('DELETE FROM staff_telegram_tokens').run();
      db.prepare(
        "UPDATE staff_notification_jobs SET status='failed',lease_until=0,lease_id=NULL WHERE status IN ('pending','sending')",
      ).run();
      for (const row of db
        .prepare('SELECT organization_id,account_id,value FROM staff_telegram_links')
        .all())
        db.prepare(
          'UPDATE staff_telegram_links SET value=? WHERE organization_id=? AND account_id=?',
        ).run(
          seal(key, { ...JSON.parse(openValue(key, row.value).toString('utf8')), enabled: false }),
          row.organization_id,
          row.account_id,
        );
    }
    if (db.prepare('PRAGMA user_version').get().user_version >= 11) {
      db.prepare('UPDATE admin_email_recoveries SET used_at=? WHERE used_at IS NULL').run(
        Date.now(),
      );
      db.prepare(
        "UPDATE admin_email_jobs SET status='cancelled',lease_until=0,lease_id=NULL WHERE status IN ('pending','sending')",
      ).run();
      db.prepare('DELETE FROM admin_operations').run();
    }
    // Restored data must not silently restart old deliveries or accept pre-disaster callbacks.
    pauseRestoredNotifications(db, key, openValue, seal);
    db.prepare(
      "UPDATE telegram_jobs SET status='failed',lease_until=0 WHERE status IN ('pending','sending')",
    ).run();
    if (db.prepare('PRAGMA user_version').get().user_version >= 5)
      db.prepare(
        "UPDATE support_deliveries SET status='failed',lease_until=0,lease_id=NULL WHERE status IN ('pending','waiting','sending')",
      ).run();
    db.prepare('UPDATE telegram_jobs SET callback_hash=lower(hex(randomblob(32)))').run();
    for (const row of db
      .prepare(
        'SELECT o.id organization_id,s.value FROM organizations o LEFT JOIN telegram_settings s ON s.organization_id=o.id',
      )
      .all())
      db.prepare('INSERT OR REPLACE INTO telegram_settings VALUES(?,?)').run(
        row.organization_id,
        seal(key, {
          ...(row.value
            ? JSON.parse(openValue(key, row.value).toString('utf8'))
            : { leadMinutes: 1440, showServices: true }),
          enabled: false,
          restoredPaused: true,
        }),
      );
    for (const row of db
      .prepare('SELECT organization_id,patient_id,value FROM telegram_links')
      .all())
      db.prepare('UPDATE telegram_links SET value=? WHERE organization_id=? AND patient_id=?').run(
        seal(key, {
          ...JSON.parse(openValue(key, row.value).toString('utf8')),
          consentToken: crypto.randomBytes(20).toString('base64url'),
        }),
        row.organization_id,
        row.patient_id,
      );
    db.prepare("INSERT INTO platform_audit(time,event,detail) VALUES(?,'backup_restored',?)").run(
      Date.now(),
      JSON.stringify({ format: 2, notificationsPaused: true }),
    );
    // Row state shares this commit with credential revocation. Never route an
    // encrypted rows sentinel through the old whole-file reset/serializer.
    restoredRows = resetRestoredAssistantRows(
      assistantContext(db, key, path.join(directory, 'platform')),
    );
    db.exec('COMMIT');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
  // Disaster recovery must never reactivate old pilot grants or paid credentials.
  // Upgrade-copy intentionally skips this function and preserves current policy.
  if (!restoredRows)
    resetRestoredAssistant({
      directory: path.join(directory, 'platform'),
      seal: (value) => seal(key, value),
      open: (value) => JSON.parse(openValue(key, value).toString('utf8')),
    });
  for (const root of manifest.cabinets) {
    const filename = path.join(directory, root, 'cabinet.sqlite'),
      key = readKey(path.join(directory, root, 'encryption.key')),
      cabinet = new DatabaseSync(filename);
    try {
      cabinet.exec('BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM limits;');
      for (const name of ['reset', 'mfaPending'])
        cabinet.prepare('DELETE FROM meta WHERE key=?').run(name);
      cabinet.exec('COMMIT');
    } finally {
      if (cabinet.isTransaction) cabinet.exec('ROLLBACK');
      cabinet.close();
    }
    // Empty photo directories are omitted by tar; the running storage recreates them as usual.
    fs.mkdirSync(path.join(directory, root, 'photos'), { recursive: true, mode: 0o700 });
  }
}
module.exports = { validateRecovered, revokeRestoredCredentials };
