// Only connection flags are returned to the authorized organization manager.
// Provider addresses, binding tokens and device subscriptions stay on the server.
function teamConnections(context, organizationId, accountId) {
  const flags = (service) => {
    const link = service?.link(organizationId, accountId);
    return { prepared: Boolean(service), linked: Boolean(link), enabled: link?.enabled === true };
  };
  let push = { prepared: Boolean(context.staffPush), linked: false, enabled: false };
  if (context.staffPush) {
    const rows = context.db
      .prepare('SELECT value FROM staff_push_devices WHERE organization_id=? AND account_id=?')
      .all(organizationId, accountId);
    push.linked = rows.length > 0;
    push.enabled = rows.some((row) => context.open(row.value).enabled === true);
  }
  return {
    telegram: flags(context.staffNotifications),
    max: flags(context.staffMaxNotifications),
    push,
  };
}
module.exports = { teamConnections };
