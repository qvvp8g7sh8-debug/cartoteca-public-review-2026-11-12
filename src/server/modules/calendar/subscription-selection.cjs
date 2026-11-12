const { createHash } = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
function createSubscriptionSelection({ db, open }) {
  function roster(organizationId) {
    return db
      .prepare(
        `SELECT a.id,a.value FROM accounts a
        JOIN memberships m ON m.account_id=a.id JOIN organizations o ON o.id=m.organization_id
        WHERE m.organization_id=? AND a.status='active' AND m.status='active'
          AND o.status='active' AND m.role IN ('owner','cosmetologist') ORDER BY a.id`,
      )
      .all(organizationId)
      .map((row) => {
        const name = open(row.value).displayName;
        return {
          id: row.id,
          displayName: typeof name === 'string' && name.trim() ? name.trim() : 'Специалист',
        };
      });
  }
  function state(current, saved, provider) {
    const specialists = roster(current.organizationId);
    const stored = saved.adminSelections?.[provider];
    const mode = stored?.mode === 'selected' ? 'selected' : 'all';
    const savedIds = Array.isArray(stored?.staffIds)
      ? [...new Set(stored.staffIds.filter((id) => typeof id === 'string'))].sort()
      : [];
    const ids = new Set(savedIds);
    const selection = {
      mode,
      staffIds:
        mode === 'selected' ? specialists.filter((s) => ids.has(s.id)).map((s) => s.id) : [],
    };
    const selectionRevision = createHash('sha256')
      .update(JSON.stringify([stored?.revision || '', mode, savedIds, specialists]))
      .digest('hex');
    return { selection, selectionRevision, specialists };
  }
  function validate(values, current) {
    if (
      !isObject(values) ||
      Object.keys(values).some(
        (key) => !['selection', 'expectedSelectionRevision'].includes(key),
      ) ||
      typeof values.expectedSelectionRevision !== 'string' ||
      !values.expectedSelectionRevision
    )
      throw fail(400, 'Укажите выбор специалистов и его текущую версию.');
    if (values.expectedSelectionRevision !== current.selectionRevision)
      throw fail(409, 'Список специалистов изменился. Обновите настройки календаря.');
    const selection = values.selection;
    if (
      !isObject(selection) ||
      Object.keys(selection).some((key) => !['mode', 'staffIds'].includes(key)) ||
      !['all', 'selected'].includes(selection.mode) ||
      !Array.isArray(selection.staffIds)
    )
      throw fail(400, 'Укажите всех или выбранных специалистов.');
    const active = new Set(current.specialists.map((s) => s.id));
    if (
      (selection.mode === 'all' && selection.staffIds.length) ||
      (selection.mode === 'selected' && !selection.staffIds.length) ||
      selection.staffIds.some((id) => typeof id !== 'string' || !active.has(id)) ||
      new Set(selection.staffIds).size !== selection.staffIds.length
    )
      throw fail(400, 'Выберите действующих специалистов этой организации.');
    return { mode: selection.mode, staffIds: [...selection.staffIds].sort() };
  }
  return { state, validate };
}
module.exports = { createSubscriptionSelection };
