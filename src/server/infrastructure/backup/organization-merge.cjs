const { updatePersonalVersions } = require('../../modules/calendar/personal-feed-state.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readKey, openValue } = require('./snapshot.cjs');
const { quote, columns } = require('./organization-inventory.cjs');
const {
  resetNotificationSchedule,
  resetNotificationInterests,
} = require('./notification-state.cjs');
const { personalCollection } = require('../../../shared/personal-calendar.cjs');

function seal(key, value) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}
function mergeOrganization(candidate, historical, org, context) {
  const filename = (directory) => path.join(directory, 'platform', 'platform.sqlite');
  const db = new DatabaseSync(filename(candidate)),
    old = new DatabaseSync(filename(historical), { readOnly: true });
  const key = readKey(path.join(candidate, 'platform', 'platform.key'));
  const read = (value) => JSON.parse(openValue(key, value).toString('utf8'));
  const has = (table) => context.policy.some((item) => item.name === table);
  const updateValues = (table, transform) => {
    if (!has(table)) return;
    for (const row of db
      .prepare(`SELECT rowid,value FROM ${quote(table)} WHERE organization_id=?`)
      .all(org))
      db.prepare(`UPDATE ${quote(table)} SET value=? WHERE rowid=?`).run(
        seal(key, transform(read(row.value))),
        row.rowid,
      );
  };
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    // The current organization identity/settings stay current, while calendar data
    // follows the recovered cabinet. A revision bump invalidates pre-restore forms.
    const readProfile = (connection) =>
      read(connection.prepare('SELECT value FROM organizations WHERE id=?').get(org).value);
    const profile = readProfile(db),
      historicalProfile = readProfile(old);
    if (profile.personalEvents !== undefined || historicalProfile.personalEvents !== undefined) {
      const currentPersonal = personalCollection(profile.personalEvents);
      const historicalPersonal = personalCollection(historicalProfile.personalEvents);
      const revision = Math.max(currentPersonal.revision, historicalPersonal.revision) + 1;
      if (!Number.isSafeInteger(revision)) throw Error('Personal calendar revision overflow.');
      db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
        seal(key, {
          ...updatePersonalVersions(profile, currentPersonal.events, historicalPersonal.events),
          personalEvents: { ...historicalPersonal, revision },
        }),
        org,
      );
    }
    // Child invitation rows are removed before their parent capability rows.
    const revoke = context.policy
      .filter((item) => item.mode === 'revoke')
      .sort(
        (a, b) =>
          (a.name === 'email_invitations' ? -1 : 0) - (b.name === 'email_invitations' ? -1 : 0),
      );
    for (const { name } of revoke)
      db.prepare(`DELETE FROM ${quote(name)} WHERE organization_id=?`).run(org);
    for (const { name, mode } of context.policy) {
      if (mode !== 'restore') continue;
      db.prepare(`DELETE FROM ${quote(name)} WHERE organization_id=?`).run(org);
      const names = columns(db, name),
        list = names.map(quote).join(',');
      const insert = db.prepare(
        `INSERT INTO ${quote(name)}(${list}) VALUES(${names.map(() => '?').join(',')})`,
      );
      for (const row of old
        .prepare(`SELECT ${list} FROM ${quote(name)} WHERE organization_id=?`)
        .iterate(org))
        insert.run(...names.map((column) => row[column]));
    }
    // Never resurrect a connection/consent that was withdrawn after the historical copy.
    const cabinetReader = new DatabaseSync(path.join(candidate, context.root, 'cabinet.sqlite'), {
      readOnly: true,
    });
    const patients = new Set();
    try {
      for (const row of cabinetReader.prepare('SELECT id FROM patients').iterate())
        patients.add(row.id);
    } finally {
      cabinetReader.close();
    }
    for (const table of ['telegram_links', 'max_client_links', 'notification_preferences']) {
      if (!has(table)) continue;
      for (const row of db
        .prepare(`SELECT DISTINCT patient_id FROM ${table} WHERE organization_id=?`)
        .all(org))
        if (!patients.has(row.patient_id))
          db.prepare(`DELETE FROM ${table} WHERE organization_id=? AND patient_id=?`).run(
            org,
            row.patient_id,
          );
    }
    if (has('booking_requests'))
      db.prepare(
        "UPDATE booking_requests SET status='expired',revision=revision+1 WHERE organization_id=? AND status IN ('pending','requested')",
      ).run(org);
    for (const table of ['telegram_jobs', 'notification_jobs', 'notification_channel_jobs']) {
      if (!has(table)) continue;
      db.prepare(
        `UPDATE ${table} SET status='failed',lease_until=0,callback_hash=lower(hex(randomblob(32))) WHERE organization_id=?`,
      ).run(org);
    }
    updateValues('telegram_settings', (value) => ({
      ...value,
      enabled: false,
      restoredPaused: true,
    }));
    if (!db.prepare('SELECT 1 FROM telegram_settings WHERE organization_id=?').get(org))
      db.prepare('INSERT INTO telegram_settings(organization_id,value) VALUES(?,?)').run(
        org,
        seal(key, { enabled: false, restoredPaused: true, leadMinutes: 1440, showServices: true }),
      );
    updateValues('telegram_links', (value) => ({
      ...value,
      consentToken: crypto.randomBytes(20).toString('base64url'),
    }));
    updateValues('max_client_links', (value) => ({
      ...value,
      bindingId: crypto.randomUUID(),
      restoredPaused: true,
    }));
    for (const table of ['staff_telegram_links', 'staff_max_links'])
      updateValues(table, (value) => ({
        ...value,
        enabled: false,
        restoredPaused: true,
        bindingId: crypto.randomUUID(),
      }));
    // Permission to edit a schedule remains current; only its optimistic revision changes.
    updateValues('work_schedule_profiles', (value) => ({
      ...value,
      revision: (value.revision || 0) + 1,
    }));
    db.prepare('INSERT INTO platform_audit(time,organization_id,event,detail) VALUES(?,?,?,?)').run(
      Date.now(),
      org,
      'organization_backup_restored',
      JSON.stringify({ format: 1, notificationsPaused: true, accessPreserved: true }),
    );
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('Organization merge broke platform references.');
    resetNotificationInterests(db, org);
    resetNotificationSchedule(db, org);
    db.exec('COMMIT');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    old.close();
    db.close();
  }
  const cabinet = new DatabaseSync(path.join(candidate, context.root, 'cabinet.sqlite'));
  try {
    cabinet.exec('BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM limits;');
    cabinet.prepare("DELETE FROM meta WHERE key IN ('reset','mfaPending')").run();
    cabinet.exec('COMMIT');
  } finally {
    if (cabinet.isTransaction) cabinet.exec('ROLLBACK');
    cabinet.close();
  }
}
module.exports = { mergeOrganization };
