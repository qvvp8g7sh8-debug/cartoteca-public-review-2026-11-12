const { fail } = require('../../../shared/errors.cjs');

function normalizeContactPhone(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^[+\d\s().-]*$/.test(value))
    throw fail(400, 'Укажите телефон для клиентов в международном формате.');
  if (!value.trim()) return '';
  let digits = value.replace(/\D/g, '');
  if (!value.trim().startsWith('+')) {
    if (digits.length === 10) digits = '7' + digits;
    else if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  }
  if (!/^[1-9]\d{9,14}$/.test(digits)) throw fail(400, 'Проверьте номер телефона для клиентов.');
  return '+' + digits;
}

function adminContactPhone(organization, accountId) {
  return organization?.staffContactPhones?.[accountId] || '';
}

// Called only inside the profile transaction; numbers belong to this membership.
function saveAdminContactPhone(context, user, value, expected) {
  if (user.role !== 'salon_admin' || !user.organizationId)
    throw fail(403, 'Личный телефон для клиентов доступен администратору организации.');
  if (typeof expected !== 'string' || expected.length > 40)
    throw fail(400, 'Обновите профиль перед изменением телефона.');
  const phone = normalizeContactPhone(value);
  const membership = context.db
    .prepare('SELECT role,status FROM memberships WHERE organization_id=? AND account_id=?')
    .get(user.organizationId, user.accountId);
  if (membership?.role !== 'salon_admin' || membership.status !== 'active')
    throw fail(403, 'Администратор неактивен.');
  const row = context.db
    .prepare('SELECT value FROM organizations WHERE id=?')
    .get(user.organizationId);
  if (!row) throw fail(404, 'Организация не найдена.');
  const organization = context.open(row.value);
  if (expected !== adminContactPhone(organization, user.accountId))
    throw fail(409, 'Телефон уже изменён. Обновите профиль.');
  const phones = { ...organization.staffContactPhones };
  if (phone) phones[user.accountId] = phone;
  else delete phones[user.accountId];
  context.db
    .prepare('UPDATE organizations SET value=? WHERE id=?')
    .run(context.seal({ ...organization, staffContactPhones: phones }), user.organizationId);
}

function publicContact(context, organizationId, organization) {
  if (Object.keys(organization.staffContactPhones || {}).length) {
    const administrators = context.db
      .prepare(
        `SELECT m.account_id FROM memberships m JOIN accounts a ON a.id=m.account_id
       WHERE m.organization_id=? AND m.role='salon_admin' AND m.status='active'
       AND a.status='active' ORDER BY m.created_at,m.account_id`,
      )
      .all(organizationId);
    for (const member of administrators) {
      try {
        const phone = normalizeContactPhone(adminContactPhone(organization, member.account_id));
        if (phone) return { phone, phoneLabel: 'Телефон администратора' };
      } catch {
        // A malformed historical contact must not break the public page.
      }
    }
  }
  try {
    return {
      phone: normalizeContactPhone(organization.phone || ''),
      phoneLabel: 'Телефон организации',
    };
  } catch {
    return { phone: '', phoneLabel: 'Телефон организации' };
  }
}

module.exports = { adminContactPhone, saveAdminContactPhone, publicContact };
