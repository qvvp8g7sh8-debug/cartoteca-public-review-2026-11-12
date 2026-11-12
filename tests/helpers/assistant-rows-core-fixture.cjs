const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { adminFixture } = require('./admin-fixture.cjs');
const { initialState } = require('../../src/server/modules/assistant/access/defaults.cjs');
const { createAssistant } = require('../../src/server/modules/assistant/service.cjs');
const {
  createAssistantRowStore,
  importRows,
} = require('../../src/server/modules/assistant/access/row-store.cjs');
const { schema, validate } = require('../../src/server/modules/assistant/access/row-schema.cjs');
const { sealSentinel } = require('../../src/server/modules/assistant/access/row-sentinel.cjs');
const { createAssistantPolicy } = require('../../src/server/modules/assistant/access/policy.cjs');
const { createAssistantBudget } = require('../../src/server/modules/assistant/access/budget.cjs');
async function rowsFixture(t, { version = 19, initial = () => {} } = {}) {
  const f = await adminFixture(t),
    context = { ...f.database, organizationTimeZone: f.store.organizationTimeZone };
  for (const [file, method] of [
    ['012-max-connections', 'migrateMaxConnections'],
    ['013-notification-queue', 'migrateNotificationQueue'],
    ['014-notification-channels', 'migrateNotificationChannels'],
    ['015-max-inbox', 'migrateMaxInbox'],
    ['016-staff-max', 'migrateStaffMax'],
    ['017-staff-push', 'migrateStaffPush'],
    ['018-notification-schedule', 'migrateNotificationSchedule'],
    ['019-paid-services', 'migratePaidServices'],
  ])
    require('../../src/server/migrations/' + file + '.cjs')[method](context, f.platformDirectory);
  if (version === 20)
    require('../../src/server/migrations/020-multi-service-billing.cjs').migrateMultiServiceBilling(
      context,
      f.platformDirectory,
      { offline: true },
    );
  const member = context.db
    .prepare('SELECT created_at FROM memberships WHERE organization_id=? AND account_id=?')
    .get(f.owner.organizationId, f.owner.accountId);
  const membershipId = createHash('sha256')
    .update(JSON.stringify([f.owner.organizationId, f.owner.accountId, member.created_at]))
    .digest('base64url');
  const state = initialState(),
    date = new Date().toISOString().slice(0, 10),
    month = date.slice(0, 7);
  state.revision = 3;
  state.policy.mode = 'selected';
  state.grants = [
    { organizationId: f.owner.organizationId, accountId: f.owner.accountId, membershipId },
  ];
  initial(state, { date, month, membershipId, f });
  let imported;
  context.transaction(() => {
    context.db.exec(schema);
    imported = importRows(context, state, { sourceHash: 'a'.repeat(64) });
  });
  const registration = validate(context.db, { required: true });
  fs.writeFileSync(
    path.join(f.platformDirectory, 'assistant-state.enc'),
    sealSentinel(context, registration),
  );
  const store = createAssistantRowStore(context, { directory: f.platformDirectory });
  const policy = createAssistantPolicy(context, store),
    budget = createAssistantBudget(context, store, policy);
  const current = () => f.store.session(f.ownerSession.token);
  function c() {
    const original = current();
    return {
      current: original,
      platform: f.store,
      assertCurrent() {
        const active = current();
        if (
          !active ||
          active.organizationId !== original.organizationId ||
          active.role !== original.role
        )
          throw Object.assign(Error('Synthetic scope revoked'), { status: 403 });
      },
      tenantStore() {
        throw Error('Unexpected clinical access');
      },
    };
  }
  const api = (options = {}) =>
    createAssistant(context, {
      directory: f.platformDirectory,
      stateBackend: 'rows-v1',
      ...options,
    });
  return {
    ...f,
    context,
    repository: store,
    policy,
    budget,
    current,
    c,
    api,
    membershipId,
    date,
    month,
    imported,
    registration,
    initial: state,
  };
}
module.exports = { rowsFixture };
