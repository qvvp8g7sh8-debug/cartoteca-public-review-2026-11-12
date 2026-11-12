const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformDatabase } = require('../infrastructure/platform-database.cjs');
const { createStorage } = require('../infrastructure/cabinet-storage.cjs');
const normalize = (v) => String(v).trim().toLowerCase();
function decoder(key) {
  return (blob) => {
    const value = Buffer.from(blob),
      cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'),
    );
  };
}
function selectedState(db, open, emails) {
  const selected = new Set(emails.map(normalize));
  if (!selected.size) throw Error('Select account emails explicitly.');
  const accounts = db
    .prepare('SELECT * FROM accounts')
    .all()
    .map((row) => ({ ...row, decoded: open(row.value) }))
    .filter((row) => selected.has(normalize(row.decoded.email)));
  if (accounts.length !== selected.size)
    throw Error('Not all selected accounts exist in the source.');
  const accountIds = new Set(accounts.map((row) => row.id));
  const memberships = db
    .prepare('SELECT * FROM memberships')
    .all()
    .filter((row) => accountIds.has(row.account_id));
  const organizationIds = new Set(memberships.map((row) => row.organization_id));
  const organizations = db
    .prepare('SELECT * FROM organizations')
    .all()
    .filter((row) => organizationIds.has(row.id))
    .map((row) => ({ ...row, decoded: open(row.value) }));
  const subscriptions = db
    .prepare('SELECT * FROM subscriptions')
    .all()
    .filter((row) => organizationIds.has(row.organization_id))
    .map((row) => ({ ...row, decoded: open(row.limits) }));
  for (const row of memberships)
    if (!['owner', 'salon_admin', 'cosmetologist'].includes(row.role))
      throw Error('Unsupported role in source.');
  return { accounts, memberships, organizations, subscriptions };
}
function fingerprint(state) {
  const plain = {
    accounts: state.accounts.map(({ value, ...row }) => row),
    organizations: state.organizations.map(({ value, ...row }) => row),
    memberships: state.memberships,
    subscriptions: state.subscriptions.map(({ limits, ...row }) => row),
  };
  return crypto.createHash('sha256').update(JSON.stringify(plain)).digest('hex');
}
function migrateSelectedAccounts({ source, destination, emails, backupDirectory, dryRun = false }) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (
    destination === source ||
    destination.startsWith(source + path.sep) ||
    source.startsWith(destination + path.sep)
  )
    throw Error('Source and destination must be separate directories.');
  if (fs.existsSync(destination)) throw Error('Destination already exists. Use a new directory.');
  const filename = path.join(source, 'platform', 'platform.sqlite'),
    keyFile = path.join(source, 'platform', 'platform.key');
  if (!fs.existsSync(filename) || !fs.existsSync(keyFile))
    throw Error('Source database or encryption key is missing.');
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw Error('Invalid source key.');
  const db = new DatabaseSync(filename, { readOnly: true });
  let stage, target;
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw Error('Source database integrity check failed.');
    db.exec('BEGIN');
    const open = decoder(key),
      state = selectedState(db, open, emails),
      before = fingerprint(state);
    if (dryRun)
      return {
        accounts: state.accounts.length,
        organizations: state.organizations.length,
        memberships: state.memberships.length,
        validated: true,
      };
    if (!backupDirectory) throw Error('An explicit local backup directory is required.');
    backupDirectory = path.resolve(backupDirectory);
    if (
      backupDirectory === source ||
      backupDirectory.startsWith(source + path.sep) ||
      backupDirectory === destination ||
      backupDirectory.startsWith(destination + path.sep)
    )
      throw Error('Backup directory must be independent.');
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const backup = fs.mkdtempSync(path.join(backupDirectory, 'accounts-v1-'));
    // The read transaction pins a WAL-consistent snapshot; VACUUM reads only source.
    db.exec('COMMIT');
    db.exec("VACUUM INTO '" + path.join(backup, 'platform.sqlite').replace(/'/g, "''") + "'");
    fs.copyFileSync(keyFile, path.join(backup, 'platform.key'), fs.constants.COPYFILE_EXCL);
    const snapshot = new DatabaseSync(path.join(backup, 'platform.sqlite'), { readOnly: true });
    let snapshotState;
    try {
      snapshotState = selectedState(snapshot, open, emails);
      if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
        throw Error('Backup integrity check failed.');
    } finally {
      snapshot.close();
    }
    if (fingerprint(snapshotState) !== before)
      throw Error('Selected accounts changed during backup. Retry the migration.');
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    stage = fs.mkdtempSync(
      path.join(path.dirname(destination), path.basename(destination) + '.staging-'),
    );
    target = createPlatformDatabase(path.join(stage, 'platform'));
    target.transaction(() => {
      for (const row of state.accounts)
        target.db
          .prepare(
            'INSERT INTO accounts(id,email_hash,value,global_admin,status,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            row.id,
            target.emailHash(row.decoded.email),
            target.seal(row.decoded),
            row.global_admin,
            row.status,
            row.created_at,
          );
      for (const row of state.organizations)
        target.db
          .prepare('INSERT INTO organizations(id,value,slug,status,created_at) VALUES(?,?,?,?,?)')
          .run(
            row.id,
            target.seal({ ...row.decoded, legacyData: false }),
            row.slug,
            row.status,
            row.created_at,
          );
      for (const row of state.memberships)
        target.db
          .prepare(
            'INSERT INTO memberships(organization_id,account_id,role,status,created_at) VALUES(?,?,?,?,?)',
          )
          .run(row.organization_id, row.account_id, row.role, row.status, row.created_at);
      for (const row of state.subscriptions)
        target.db
          .prepare(
            'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at) VALUES(?,?,?,?,?)',
          )
          .run(row.organization_id, row.plan, row.status, target.seal(row.decoded), row.changed_at);
      target.db.exec(
        'CREATE TABLE migration_receipts(version INTEGER PRIMARY KEY,completed_at INTEGER NOT NULL,accounts INTEGER NOT NULL,organizations INTEGER NOT NULL);',
      );
      target.db
        .prepare('INSERT INTO migration_receipts VALUES(2,?,?,?)')
        .run(Date.now(), state.accounts.length, state.organizations.length);
      target.db.exec('PRAGMA user_version=2');
    });
    // Compare all private credential fields in memory; never print them.
    for (const row of state.accounts) {
      const migrated = target.db.prepare('SELECT * FROM accounts WHERE id=?').get(row.id);
      if (
        JSON.stringify(target.open(migrated.value)) !== JSON.stringify(row.decoded) ||
        migrated.global_admin !== row.global_admin ||
        migrated.status !== row.status
      )
        throw Error('Account verification failed.');
    }
    if (target.db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('Membership verification failed.');
    target.db.close();
    target = null;
    for (const organization of state.organizations) {
      const cabinet = createStorage(path.join(stage, 'tenants', organization.id));
      try {
        cabinet.write({ patients: [], services: [], revision: 0 }, { migrating: true });
      } finally {
        cabinet.close();
      }
    }
    const fresh = selectedState(db, open, emails);
    if (fingerprint(fresh) !== before)
      throw Error('Source accounts changed during migration. Retry.');
    if (fs.existsSync(destination)) throw Error('Destination was created by another operation.');
    fs.renameSync(stage, destination);
    stage = null;
    return {
      accounts: state.accounts.length,
      organizations: state.organizations.length,
      memberships: state.memberships.length,
      validated: true,
      backup,
      destination,
      passwordsPreserved: true,
      clinicalDataCopied: false,
    };
  } finally {
    target?.db.close();
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    // A failed staging copy remains recoverable and is never published as the target.
    if (stage)
      console.error(
        'Migration did not publish the destination; a private staging copy was retained.',
      );
  }
}
module.exports = { migrateSelectedAccounts };
