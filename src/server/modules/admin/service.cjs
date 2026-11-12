const { createAdminPolicy } = require('./policy.cjs');
const { createAdminCommands } = require('./commands.cjs');
const { createAdminDirectory } = require('./directory.cjs');
const { createAdminOrganizations } = require('./organizations.cjs');
const { createAdminAccounts } = require('./accounts.cjs');
const { createAdminEmailQueue } = require('./email-queue.cjs');
const { createAdminRecovery } = require('./recovery.cjs');
const { createAdminAudit } = require('./audit.cjs');
const { createSupportCases } = require('../support/cases.cjs');

function createAdministration(context) {
  const { db } = context;
  const policy = createAdminPolicy(context);
  const commands = createAdminCommands(context, policy);
  const directory = createAdminDirectory(context, commands);
  const organizations = createAdminOrganizations(context, policy, commands);
  const accounts = createAdminAccounts(context, policy, commands);
  const emailQueue = createAdminEmailQueue(context);
  const recovery = createAdminRecovery(context, policy, commands, emailQueue);
  const history = createAdminAudit(context, policy);
  const support = createSupportCases(context, policy, commands, emailQueue);
  function overview(actorId) {
    policy.assert(actorId, 'organizations.read');
    return {
      accountsTotal: db.prepare('SELECT count(*) n FROM accounts').get().n,
      accountsActive: db.prepare("SELECT count(*) n FROM accounts WHERE status='active'").get().n,
      organizationsTotal: db.prepare('SELECT count(*) n FROM organizations').get().n,
      organizationsSuspended: db
        .prepare("SELECT count(*) n FROM organizations WHERE status='suspended'")
        .get().n,
      supportNew: db.prepare("SELECT count(*) n FROM support_cases WHERE state='new'").get().n,
      supportOpen: db.prepare("SELECT count(*) n FROM support_cases WHERE state!='resolved'").get()
        .n,
      failedDeliveries:
        db.prepare("SELECT count(*) n FROM support_deliveries WHERE status='failed'").get().n +
        db.prepare("SELECT count(*) n FROM admin_email_jobs WHERE status='failed'").get().n,
    };
  }
  function page(actorId, kind, options) {
    policy.assert(actorId, kind === 'organization' ? 'organizations.read' : 'accounts.read');
    const result = directory.page(kind, options);
    return {
      items: result.rows.map(kind === 'organization' ? organizations.profile : accounts.profile),
      total: result.total,
      nextCursor: result.nextCursor,
    };
  }
  function queues(actorId) {
    policy.assert(actorId, 'system.read');
    const tables = [
      'telegram_jobs',
      'staff_notification_jobs',
      'support_deliveries',
      'admin_email_jobs',
    ];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare('SELECT status,count(*) count FROM ' + table + ' GROUP BY status').all(),
      ]),
    );
  }
  const admin = {
    overview,
    organizations: (actorId, options) => page(actorId, 'organization', options),
    organization: organizations.detail,
    updateProfile: organizations.updateProfile,
    updateOrganizationAccess: organizations.updateAccess,
    updateSubscription: organizations.updateSubscription,
    accounts: (actorId, options) => page(actorId, 'account', options),
    account: accounts.detail,
    updateAccountAccess: accounts.updateAccess,
    revokeSessions: accounts.revokeSessions,
    verifyActor: recovery.verifyActor,
    prepareEmailRecovery: recovery.prepare,
    cancelEmailRecovery: recovery.cancel,
    confirmEmailRecovery: recovery.confirm,
    consumeConfirmation: recovery.consumeConfirmation,
    operation(actorId, requestId) {
      policy.assert(actorId, 'accounts.read');
      const row = db
        .prepare('SELECT value FROM admin_operations WHERE actor_id=? AND request_id=?')
        .get(actorId, requestId);
      return { result: row ? context.open(row.value) : null };
    },
    audit: history.page,
    support,
    queues,
    emailQueue,
    capabilities: policy.capabilities,
  };
  return { admin, adminOverview: overview };
}
module.exports = { createAdministration };
