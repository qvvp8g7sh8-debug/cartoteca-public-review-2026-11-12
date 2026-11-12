function staffRecipientPolicy(c) {
  function member(org, account) {
    return c.db
      .prepare(
        "SELECT m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=? AND m.status='active' AND a.status='active'",
      )
      .get(org, account);
  }
  function allowed(org) {
    try {
      const plan = c.subscription(org);
      return (
        c.organization(org).status === 'active' &&
        plan.status === 'active' &&
        plan.limits.automaticNotifications === true
      );
    } catch {
      return false;
    }
  }
  return { member, allowed };
}
module.exports = { staffRecipientPolicy };
