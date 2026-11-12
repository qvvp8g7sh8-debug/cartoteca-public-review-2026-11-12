const path = require('node:path'), os = require('node:os');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
function platformInspection(directory) {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw Error('Test inspection is limited to temporary synthetic data');
  const database = createPlatformDatabase(directory);
  try {
    return {
      accounts: database.db.prepare('SELECT id,status,global_admin,value FROM accounts ORDER BY id').all().map(row => {
        const { email, displayName } = database.open(row.value);
        return { id: row.id, email, displayName, status: row.status, globalAdmin: Boolean(row.global_admin) };
      }),
      organizations: database.db.prepare('SELECT id,status,value FROM organizations ORDER BY id').all().map(row =>
        ({ id: row.id, status: row.status, ...database.open(row.value) })),
    };
  } finally { database.db.close(); }
}
// Only synthetic downgrade fixtures use this; production migrations are never rewritten.
function dropAdminSchema(db) {
  for (const table of ['admin_operations', 'admin_audit_details', 'admin_directory_terms', 'admin_directory_records',
    'admin_email_jobs', 'admin_email_recoveries', 'support_messages', 'support_cases', 'admin_resource_versions'])
    db.exec('DROP TABLE IF EXISTS ' + table);
  for (const index of ['platform_audit_actor_time', 'platform_audit_org_time', 'platform_audit_event_id',
    'admin_organizations_order', 'admin_accounts_order', 'admin_membership_account'])
    db.exec('DROP INDEX IF EXISTS ' + index);
}
module.exports = { platformInspection, dropAdminSchema };
