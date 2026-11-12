function migratePlatform(db, supportedVersion = 7) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > supportedVersion) throw Error('Database schema is newer than this application.');
  if (version >= 1) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY,
      email_hash TEXT UNIQUE NOT NULL,
      value BLOB NOT NULL,
      global_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organizations(
      id TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships(
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(organization_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS invitations(
      token_hash TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      invited_by TEXT NOT NULL REFERENCES accounts(id),
      email_hash TEXT,
      role TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS subscriptions(
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      limits BLOB NOT NULL,
      changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_sessions(
      token_hash TEXT PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      organization_id TEXT REFERENCES organizations(id),
      value BLOB NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_verifications(
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS password_resets(
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS platform_audit(
      id INTEGER PRIMARY KEY,
      time INTEGER NOT NULL,
      actor_id TEXT,
      organization_id TEXT,
      event TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_limits(
      key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      window_started INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS admin_bootstraps(
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
  `);
    // The former assistant role was removed from the product. Existing accounts
    // become suspended cosmetologists so an owner must explicitly reopen access.
    db.prepare(
      "UPDATE memberships SET role='cosmetologist',status='suspended' WHERE role='assistant'",
    ).run();
    db.prepare("UPDATE invitations SET used_at=? WHERE role='assistant' AND used_at IS NULL").run(
      Date.now(),
    );
    db.exec('PRAGMA user_version=1; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migratePlatform };
