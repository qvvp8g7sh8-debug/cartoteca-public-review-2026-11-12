function createAdminOrganizations(context, policy, commands) {
  const { db, open, seal, fail, textRule } = context;
  function profile(row) {
    const value = open(row.value);
    const owner = db
      .prepare(
        "SELECT a.id,a.value FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.role='owner' LIMIT 1",
      )
      .get(row.id);
    const account = owner ? open(owner.value) : {};
    const sub = db
      .prepare('SELECT plan,status,limits FROM subscriptions WHERE organization_id=?')
      .get(row.id);
    return {
      id: row.id,
      name: value.name,
      city: value.city || '',
      phone: value.phone || '',
      timeZone: value.timeZone || 'Europe/Moscow',
      ownerId: owner?.id || null,
      ownerName: account.displayName || '',
      ownerEmail: account.email || '',
      status: row.status,
      createdAt: row.created_at,
      plan: sub?.plan || null,
      subscriptionStatus: sub?.status || null,
      limits: sub ? open(sub.limits) : null,
      members: db
        .prepare("SELECT count(*) n FROM memberships WHERE organization_id=? AND status='active'")
        .get(row.id).n,
    };
  }
  function detail(actorId, organizationId) {
    policy.assert(actorId, 'organizations.read');
    const row = db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
    if (!row) throw fail(404, 'Организация не найдена.');
    const subscription = db
      .prepare('SELECT changed_at FROM subscriptions WHERE organization_id=?')
      .get(organizationId);
    const last = db
      .prepare(
        "SELECT max(time) time FROM platform_audit WHERE organization_id=? AND event IN ('login_succeeded','organization_selected')",
      )
      .get(organizationId);
    const members = db
      .prepare(
        'SELECT m.account_id,m.role,m.status,a.value FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? ORDER BY m.created_at',
      )
      .all(organizationId)
      .map((item) => {
        const account = open(item.value);
        return {
          accountId: item.account_id,
          role: item.role,
          status: item.status,
          displayName: account.displayName,
          email: account.email,
        };
      });
    return {
      ...profile(row),
      revision: commands.revision('organization', organizationId),
      subscriptionRevision: commands.revision('subscription', organizationId),
      subscriptionChangedAt: subscription?.changed_at || null,
      lastActivityAt: last.time || null,
      members,
      subscriptionTerms: open(row.value).adminSubscriptionTerms || null,
    };
  }
  function updateProfile(actorId, organizationId, input) {
    return commands.execute(
      actorId,
      'organizations.profile',
      'organization',
      organizationId,
      input,
      () => {
        const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(organizationId);
        if (!row) throw fail(404, 'Организация не найдена.');
        const previous = open(row.value);
        const allowed = ['name', 'city', 'phone'];
        const changes = input.changes;
        if (
          !changes ||
          typeof changes !== 'object' ||
          Array.isArray(changes) ||
          Object.keys(changes).some((key) => !allowed.includes(key) && key !== 'businessType')
        )
          throw fail(400, 'Неверные поля профиля.');
        const after = Object.fromEntries(
          allowed.map((key) => [
            key,
            changes[key] === undefined ? previous[key] || '' : changes[key],
          ]),
        );
        after.name = textRule(after.name, 'название организации или имя специалиста');
        for (const [key, maximum] of [
          ['city', 120],
          ['phone', 40],
        ]) {
          if (typeof after[key] !== 'string' || after[key].trim().length > maximum)
            throw fail(400, 'Проверьте контактные сведения.');
          after[key] = after[key].trim();
        }
        db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
          seal({ ...previous, ...after }),
          organizationId,
        );
        return {
          event: 'organization_profile_admin_updated',
          detail: {
            before: Object.fromEntries(allowed.map((key) => [key, previous[key] || ''])),
            after,
          },
        };
      },
    );
  }
  function updateAccess(actorId, organizationId, input) {
    return commands.execute(
      actorId,
      'organizations.access',
      'organization',
      organizationId,
      input,
      () => {
        const row = db.prepare('SELECT status FROM organizations WHERE id=?').get(organizationId);
        if (!row) throw fail(404, 'Организация не найдена.');
        if (!['active', 'suspended'].includes(input.status))
          throw fail(400, 'Недопустимый статус организации.');
        if (input.status === 'active') {
          const members = db
            .prepare(
              "SELECT account_id FROM memberships WHERE organization_id=? AND status='active'",
            )
            .all(organizationId);
          if (
            members.some((member) =>
              context
                .availableMemberships(member.account_id)
                .some((link) => link.organizationId !== organizationId),
            )
          )
            throw fail(
              409,
              'У сотрудника уже есть доступ к другой организации. Используйте отдельную учётную запись.',
            );
        }
        db.prepare('UPDATE organizations SET status=? WHERE id=?').run(
          input.status,
          organizationId,
        );
        if (input.status === 'suspended' && row.status !== 'suspended')
          require('../notifications/pause-pending.cjs').pausePendingNotifications(
            context,
            organizationId,
          );
        return {
          event: 'organization_access_admin_updated',
          detail: { before: { status: row.status }, after: { status: input.status } },
        };
      },
      { reasonRequired: true },
    );
  }
  function updateSubscription(actorId, organizationId, input) {
    return commands.execute(
      actorId,
      'subscriptions.manage',
      'subscription',
      organizationId,
      input,
      (reason) => {
        const row = db
          .prepare('SELECT * FROM subscriptions WHERE organization_id=?')
          .get(organizationId);
        if (!row) throw fail(404, 'Тариф организации не найден.');
        const limits = input.limits;
        if (
          !['free', 'paid'].includes(input.plan) ||
          !limits ||
          typeof limits !== 'object' ||
          Object.keys(limits).some(
            (key) =>
              !['patients', 'photos', 'publicBooking', 'automaticNotifications'].includes(key),
          ) ||
          !Number.isInteger(limits.patients) ||
          limits.patients < 1 ||
          limits.patients > 100000 ||
          !Number.isInteger(limits.photos) ||
          limits.photos < 1 ||
          limits.photos > 1000000 ||
          typeof limits.publicBooking !== 'boolean' ||
          typeof limits.automaticNotifications !== 'boolean'
        )
          throw fail(400, 'Проверьте условия и лимиты тарифа.');
        db.prepare(
          'UPDATE subscriptions SET plan=?,limits=?,changed_at=? WHERE organization_id=?',
        ).run(input.plan, seal(limits), Date.now(), organizationId);
        const org = db.prepare('SELECT value FROM organizations WHERE id=?').get(organizationId);
        db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
          seal({
            ...open(org.value),
            adminSubscriptionTerms: {
              source: 'manual',
              actorId,
              at: Date.now(),
              reason,
              paymentVerified: false,
            },
          }),
          organizationId,
        );
        return {
          event: 'subscription_terms_admin_updated',
          detail: {
            before: { plan: row.plan, limits: open(row.limits) },
            after: { plan: input.plan, limits },
            paymentVerified: false,
          },
        };
      },
      { reasonRequired: true },
    );
  }
  return { profile, detail, updateProfile, updateAccess, updateSubscription };
}
module.exports = { createAdminOrganizations };
