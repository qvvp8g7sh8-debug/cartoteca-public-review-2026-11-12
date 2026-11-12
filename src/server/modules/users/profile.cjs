const { adminContactPhone, saveAdminContactPhone } = require('../organizations/public-contact.cjs');
const { freeAccessPeriod } = require('../billing/free-access-period.cjs');
function createProfiles(context) {
  const { db, open, seal, fail, textRule, transaction, audit } = context;
  function current(token) {
    const user = context.session(token);
    if (!user) throw fail(401, 'Войдите в картотеку.');
    return user;
  }
  function accountProfile(token) {
    const user = current(token),
      row = db.prepare('SELECT value FROM accounts WHERE id=?').get(user.accountId),
      account = open(row.value);
    const org = user.organizationId ? context.organization(user.organizationId) : null;
    const timeZone = org ? context.organizationTimeZone(user.organizationId) : null;
    const registeredAt = org
      ? db.prepare('SELECT created_at FROM organizations WHERE id=?').get(user.organizationId)
          ?.created_at
      : null;
    return {
      account: { displayName: account.displayName, email: account.email },
      freeAccess:
        org && context.subscription(user.organizationId)?.plan === 'free'
          ? freeAccessPeriod(registeredAt, timeZone)
          : null,
      specialty: org ? context.staffSpecialty(user.organizationId, user.accountId) : '',
      organization: org
        ? {
            name: org.name,
            city: org.city || '',
            phone: org.phone || '',
            timeZone,
          }
        : null,
      canEditOrganization: user.role === 'owner',
      canEditContactPhone: user.role === 'salon_admin' && !!org,
      contactPhone: user.role === 'salon_admin' ? adminContactPhone(org, user.accountId) : '',
    };
  }
  function updateAccountProfile(token, values) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some(
        (k) =>
          ![
            'displayName',
            'organization',
            'specialty',
            'expectedSpecialty',
            'contactPhone',
            'expectedContactPhone',
          ].includes(k),
      )
    )
      throw fail(400, 'Изменять можно только поля профиля.');
    const displayName = textRule(values.displayName, 'имя и фамилию');
    if (
      values.expectedSpecialty !== undefined &&
      (typeof values.expectedSpecialty !== 'string' || values.expectedSpecialty.length > 120)
    )
      throw fail(400, 'Некорректная ожидаемая специальность.');
    transaction(() => {
      const user = current(token),
        row = db.prepare('SELECT value FROM accounts WHERE id=?').get(user.accountId);
      const account = open(row.value);
      if (values.contactPhone !== undefined || values.expectedContactPhone !== undefined)
        saveAdminContactPhone(context, user, values.contactPhone, values.expectedContactPhone);
      if (values.specialty !== undefined) {
        if (!user.organizationId) throw fail(403, 'Специальность доступна только в организации.');
        context.saveStaffSpecialty(
          user.organizationId,
          user.accountId,
          values.specialty,
          values.expectedSpecialty,
        );
      }
      if (values.organization !== undefined) {
        if (user.role !== 'owner' || !user.organizationId)
          throw fail(403, 'Профиль организации изменяет только владелец.');
        const org = values.organization;
        if (
          !org ||
          typeof org !== 'object' ||
          Array.isArray(org) ||
          Object.keys(org).some(
            (k) => !['name', 'businessType', 'city', 'phone', 'timeZone'].includes(k),
          )
        )
          throw fail(400, 'Некорректные поля организации.');
        const name = textRule(org.name, 'название организации или имя специалиста');
        for (const [key, max] of [
          ['city', 120],
          ['phone', 40],
        ])
          if (typeof org[key] !== 'string' || org[key].length > max)
            throw fail(400, 'Проверьте город и телефон.');
        const prior = db
          .prepare('SELECT value FROM organizations WHERE id=?')
          .get(user.organizationId);
        db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
          seal({
            ...open(prior.value),
            name,
            city: org.city.trim(),
            phone: org.phone.trim(),
          }),
          user.organizationId,
        );
        if (org.timeZone !== undefined)
          context.setOrganizationTimeZone(user.organizationId, user.accountId, org.timeZone);
      }
      // Password, verification, login email, role, organization flags and slug stay unchanged.
      db.prepare('UPDATE accounts SET value=? WHERE id=?').run(
        seal({ ...account, displayName }),
        user.accountId,
      );
      audit('profile_updated', user.accountId, user.organizationId, {
        fields: values.organization ? ['displayName', 'name', 'city', 'phone'] : ['displayName'],
        ...(values.specialty !== undefined ? { specialtyChanged: true } : {}),
        ...(values.contactPhone !== undefined ? { contactPhoneChanged: true } : {}),
      });
    });
    return accountProfile(token);
  }
  return { accountProfile, updateAccountProfile };
}
module.exports = { createProfiles };
