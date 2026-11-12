// A specialty belongs to a membership, not to a role or the global account.
function createStaffSpecialties(context) {
  const { db, open, seal, fail, transaction, audit } = context;
  function staffSpecialty(organizationId, accountId) {
    const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(organizationId);
    return row ? open(row.value).staffSpecialties?.[accountId] || '' : '';
  }
  function saveStaffSpecialty(organizationId, accountId, specialty, expectedSpecialty) {
    if (
      typeof specialty !== 'string' ||
      specialty.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(specialty)
    )
      throw fail(400, 'Укажите специальность до 120 символов.');
    if (
      !db
        .prepare('SELECT 1 FROM memberships WHERE organization_id=? AND account_id=?')
        .get(organizationId, accountId)
    )
      throw fail(404, 'Сотрудник не найден.');
    const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(organizationId);
    if (!row) throw fail(404, 'Организация не найдена.');
    const organization = open(row.value);
    const specialties = { ...organization.staffSpecialties };
    if (expectedSpecialty !== undefined && expectedSpecialty !== (specialties[accountId] || ''))
      throw fail(409, 'Специальность уже изменена. Обновите профиль.');
    specialty = specialty.trim();
    if (specialty) specialties[accountId] = specialty;
    else delete specialties[accountId];
    db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
      seal({ ...organization, staffSpecialties: specialties }),
      organizationId,
    );
  }
  function updateStaffSpecialty(token, values) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some(
        (k) => !['accountId', 'specialty', 'expectedSpecialty'].includes(k),
      ) ||
      typeof values.accountId !== 'string' ||
      typeof values.expectedSpecialty !== 'string'
    )
      throw fail(400, 'Некорректные поля специальности.');
    return transaction(() => {
      const user = context.session(token);
      if (!user) throw fail(401, 'Войдите в картотеку.');
      if (!user.organizationId || user.role !== 'owner')
        throw fail(403, 'Специальности сотрудников меняет владелец.');
      saveStaffSpecialty(
        user.organizationId,
        values.accountId,
        values.specialty,
        values.expectedSpecialty,
      );
      audit('staff_specialty_updated', user.accountId, user.organizationId, {
        accountId: values.accountId,
      });
      return context.organizationAccess(user.organizationId, user.accountId);
    });
  }
  return { staffSpecialty, saveStaffSpecialty, updateStaffSpecialty };
}
module.exports = { createStaffSpecialties };
