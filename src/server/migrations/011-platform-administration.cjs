const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function migratePlatformAdministration(database, directory) {
  const { db } = database;
  if (db.prepare('PRAGMA user_version').get().user_version >= 11) return;
  if (db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
    const target = path.join(
      directory,
      'migration-backups',
      'before-011-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    );
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const filename = path.join(target, 'platform.sqlite');
    db.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
    fs.copyFileSync(
      path.join(directory, 'platform.key'),
      path.join(target, 'platform.key'),
      fs.constants.COPYFILE_EXCL,
    );
    const snapshot = new DatabaseSync(filename, { readOnly: true });
    try {
      if (
        snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        snapshot.prepare('PRAGMA foreign_key_check').all().length
      )
        throw Error('Administration migration backup failed.');
    } finally {
      snapshot.close();
    }
  }
  database.transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version >= 11) return;
    const separated = db
      .prepare(
        "SELECT count(*) n FROM subscriptions WHERE status='suspended' AND organization_id IN (SELECT id FROM organizations WHERE status='suspended')",
      )
      .get().n;
    db.exec(
      [
        'CREATE TABLE admin_resource_versions(kind TEXT NOT NULL, resource_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,resource_id));',
        'CREATE TABLE admin_operations(actor_id TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, value BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(actor_id,request_id));',
        'CREATE TABLE admin_audit_details(audit_id INTEGER PRIMARY KEY REFERENCES platform_audit(id) ON DELETE CASCADE, value BLOB NOT NULL);',
        'CREATE TABLE admin_directory_records(kind TEXT NOT NULL, resource_id TEXT NOT NULL, source_value BLOB NOT NULL, PRIMARY KEY(kind,resource_id));',
        'CREATE TABLE admin_directory_terms(kind TEXT NOT NULL, resource_id TEXT NOT NULL, term_hash TEXT NOT NULL, PRIMARY KEY(kind,resource_id,term_hash), FOREIGN KEY(kind,resource_id) REFERENCES admin_directory_records(kind,resource_id) ON DELETE CASCADE);',
        'CREATE INDEX admin_directory_lookup ON admin_directory_terms(kind,term_hash,resource_id);',
        'CREATE TABLE admin_email_recoveries(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), actor_id TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, value BLOB NOT NULL);',
        'CREATE INDEX admin_email_recovery_account ON admin_email_recoveries(account_id,expires_at);',
        "CREATE TABLE admin_email_jobs(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL, value BLOB NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, lease_id TEXT, UNIQUE(operation_id,kind));",
        'CREATE INDEX admin_email_due ON admin_email_jobs(status,next_at);',
        "CREATE TABLE support_cases(request_id TEXT PRIMARY KEY REFERENCES support_requests(id) ON DELETE CASCADE, state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new','in_progress','waiting','resolved')), revision INTEGER NOT NULL DEFAULT 0, assigned_to TEXT REFERENCES accounts(id), changed_at INTEGER NOT NULL, resolved_at INTEGER);",
        'CREATE INDEX support_cases_state ON support_cases(state,changed_at);',
        'INSERT INTO support_cases(request_id,changed_at) SELECT id,created_at FROM support_requests;',
        "CREATE TABLE support_messages(id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES accounts(id), kind TEXT NOT NULL CHECK(kind IN ('internal','reply','author')), created_at INTEGER NOT NULL, value BLOB NOT NULL);",
        'CREATE INDEX support_messages_request ON support_messages(request_id,created_at);',
        'CREATE INDEX platform_audit_actor_time ON platform_audit(actor_id,time);',
        'CREATE INDEX platform_audit_org_time ON platform_audit(organization_id,time);',
        'CREATE INDEX platform_audit_event_id ON platform_audit(event,id);',
        "UPDATE subscriptions SET status='active' WHERE status='suspended' AND organization_id IN (SELECT id FROM organizations WHERE status='suspended');",
        'CREATE INDEX admin_organizations_order ON organizations(created_at DESC,id DESC);',
        'CREATE INDEX admin_accounts_order ON accounts(created_at DESC,id DESC);',
        'CREATE INDEX admin_membership_account ON memberships(account_id,organization_id);',
        'PRAGMA user_version=11;',
      ].join('\n'),
    );
    db.prepare(
      "INSERT INTO platform_audit(time,event,detail) VALUES(?,'administration_schema_migrated',?)",
    ).run(Date.now(), JSON.stringify({ schema: 11, legacySubscriptionsSeparated: separated }));
  });
}
module.exports = { migratePlatformAdministration };
