function createServiceGroups(context) {
  const { db, open, seal, transaction, fail, crypto, audit } = context;
  function serviceGroups(organizationId) {
    const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(organizationId);
    if (!row) throw fail(404, 'Организация не найдена.');
    return (
      open(row.value).serviceGroups || { revision: 0, groups: [{ id: 'other', title: 'Другое' }] }
    );
  }
  function createServiceGroup(token, values) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some((k) => !['revision', 'title', 'id'].includes(k)) ||
      !Number.isSafeInteger(values.revision) ||
      typeof values.title !== 'string' ||
      !values.title.trim() ||
      values.title.length > 100 ||
      /[\r\n\u0000-\u001f]/.test(values.title)
    )
      throw fail(400, 'Укажите название группы — до 100 символов.');
    if (
      values.id !== undefined &&
      (typeof values.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(values.id) ||
        ['other', 'all'].includes(values.id))
    )
      throw fail(400, 'Некорректный идентификатор группы.');
    return transaction(() => {
      const user = context.session(token);
      if (!user?.organizationId || !['owner', 'salon_admin'].includes(user.role))
        throw fail(403, 'Создавать группы может владелец или администратор.');
      if (context.subscription(user.organizationId).status !== 'active')
        throw fail(403, 'Доступ по тарифу приостановлен.');
      const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(user.organizationId),
        profile = open(row.value),
        prior = serviceGroups(user.organizationId);
      if (values.revision !== prior.revision)
        throw fail(409, 'Список групп изменился. Обновите его и повторите создание.');
      const title = values.title.trim(),
        id = values.id || crypto.randomUUID();
      if (
        prior.groups.some(
          (g) =>
            g.id === id || g.title.toLocaleLowerCase('ru-RU') === title.toLocaleLowerCase('ru-RU'),
        )
      )
        throw fail(409, 'Такая группа уже существует.');
      if (prior.groups.length >= 50) throw fail(400, 'Можно создать не более 49 своих групп.');
      const next = { revision: prior.revision + 1, groups: [...prior.groups, { id, title }] };
      db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
        seal({ ...profile, serviceGroups: next }),
        user.organizationId,
      );
      audit('service_group_created', user.accountId, user.organizationId, { groupId: id });
      return { ...next, createdId: id };
    });
  }
  function deleteServiceGroup(token, values, readServices, assertCurrent) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some((key) => !['id', 'revision'].includes(key)) ||
      !Number.isSafeInteger(values.revision) ||
      values.revision < 0 ||
      typeof values.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(values.id)
    )
      throw fail(400, 'Укажите группу и актуальную версию списка.');
    const { id, revision } = values;
    if (['other', 'all'].includes(id)) throw fail(400, 'Эту группу нельзя удалить.');
    return transaction(() => {
      assertCurrent?.();
      const user = context.session(token);
      if (
        !user?.organizationId ||
        user.globalAdmin ||
        !['owner', 'salon_admin'].includes(user.role)
      )
        throw fail(403, 'Удалять группы может владелец или администратор.');
      const { organizationId, accountId } = user;
      if (context.subscription(organizationId).status !== 'active')
        throw fail(403, 'Доступ по тарифу приостановлен.');
      const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(organizationId);
      if (!row) throw fail(404, 'Организация не найдена.');
      const profile = open(row.value);
      const prior = profile.serviceGroups || { revision: 0, groups: [] };
      if (revision !== prior.revision)
        throw fail(409, 'Список групп изменился. Обновите его и повторите удаление.');
      if (!prior.groups.some((group) => group.id === id)) throw fail(404, 'Группа не найдена.');

      // Service saves use the same platform policy fence. Check the whole catalog while it is held.
      const services = typeof readServices === 'function' ? readServices(organizationId) : null;
      if (!Array.isArray(services))
        throw fail(503, 'Не удалось проверить услуги группы. Повторите попытку.');
      if (services.some((service) => service.category === id))
        throw fail(
          409,
          'Перенесите услуги в другую группу или выберите «Без группы», затем удалите группу.',
        );

      const next = {
        revision: prior.revision + 1,
        groups: prior.groups.filter((g) => g.id !== id),
      };
      db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
        seal({ ...profile, serviceGroups: next }),
        organizationId,
      );
      audit('service_group_deleted', accountId, organizationId, { groupId: id });
      return next;
    });
  }
  function assertServiceGroups(org, before, next) {
    const allowed = new Set(serviceGroups(org).groups.map((g) => g.id)),
      prior = new Map(before.services.map((s) => [s.id, s]));
    for (const s of next.services)
      if (s.category && !allowed.has(s.category) && prior.get(s.id)?.category !== s.category)
        throw fail(400, 'Выберите свою группу услуг или «Другое».');
  }
  return { serviceGroups, createServiceGroup, deleteServiceGroup, assertServiceGroups };
}
module.exports = { createServiceGroups };
