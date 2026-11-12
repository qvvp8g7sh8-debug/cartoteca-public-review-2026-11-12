const { fail } = require('../../../../shared/errors.cjs');
const { assessmentForCase, libraryCoverage } = require('./behavior-library-coverage.cjs');
const { normalizeIntent, validDate } = require('../interpretation/intent-schema.cjs');
const statuses = Object.freeze({
  supported: 'Поддерживается текущим действием',
  manual: 'Продолжение вручную в интерфейсе',
  needs_clarification: 'Нужно уточнение',
  unsupported: 'Пока не поддерживается',
});
let cached;
function normalizeCatalog(index, cases) {
  if (index.schemaVersion !== 1 || !Array.isArray(cases) || !Array.isArray(index.packs))
    throw Error('Invalid assistant scenario catalog.');
  const ids = new Set();
  const normalized = cases.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      ids.has(item.id) ||
      typeof item.category !== 'string' ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      item.text.length > 500 ||
      !validDate(item.referenceDate) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.referenceTime) ||
      !Object.hasOwn(statuses, item.current?.status)
    )
      throw Error('Invalid assistant scenario.');
    ids.add(item.id);
    return { ...item, current: { ...item.current, intent: normalizeIntent(item.current.intent) } };
  });
  const categoryTitles = new Map((index.categories || []).map((item) => [item.id, item.title]));
  const categories = [...new Set(normalized.map((item) => item.category))].map((id) => ({
    id,
    title: categoryTitles.get(id) || id,
    count: normalized.filter((item) => item.category === id).length,
  }));
  const packs = index.packs.map((pack) => {
    if (
      !Array.isArray(pack.caseIds) ||
      new Set(pack.caseIds).size !== pack.caseIds.length ||
      pack.caseIds.some((id) => !ids.has(id))
    )
      throw Error('Invalid assistant scenario pack.');
    return { ...pack, caseIds: [...pack.caseIds] };
  });
  return { schemaVersion: 1, context: index.context, categories, packs, cases: normalized };
}
function loadCatalog() {
  if (cached) return cached;
  const index = require('./scenarios/index.json');
  if (
    !Array.isArray(index.files) ||
    index.files.some((file) => !/^[a-z0-9][a-z0-9-]*\.json$/.test(file))
  )
    throw Error('Invalid assistant scenario files.');
  cached = normalizeCatalog(
    index,
    index.files.flatMap((file) => require('./scenarios/' + file)),
  );
  return cached;
}
const fold = (value) => value.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е');
function parameter(params, key, fallback = '') {
  if (params.getAll(key).length > 1) throw fail(400, 'Не повторяйте параметры библиотеки.');
  return params.get(key) ?? fallback;
}
function pageNumber(value, fallback, max) {
  if (value === '') return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
    throw fail(400, 'Некорректная страница библиотеки.');
  return Number(value);
}
function libraryView(catalog, params) {
  const allowed = ['q', 'category', 'status', 'pack', 'offset', 'limit'];
  if ([...params.keys()].some((key) => !allowed.includes(key)))
    throw fail(400, 'Неизвестный фильтр библиотеки.');
  const q = parameter(params, 'q').trim();
  const category = parameter(params, 'category'),
    status = parameter(params, 'status');
  const packId = parameter(params, 'pack');
  const offset = pageNumber(parameter(params, 'offset'), 0, 100000);
  const limit = pageNumber(parameter(params, 'limit'), 20, 40);
  if (!limit || q.length > 160 || /\u0000/.test(q)) throw fail(400, 'Уточните фильтр библиотеки.');
  if (category && !catalog.categories.some((item) => item.id === category))
    throw fail(400, 'Неизвестная категория сценариев.');
  if (status && !Object.hasOwn(statuses, status)) throw fail(400, 'Неизвестный статус сценариев.');
  const pack = packId ? catalog.packs.find((item) => item.id === packId) : null;
  if (packId && !pack) throw fail(404, 'Набор сценариев не найден.');
  const packIds = pack ? new Set(pack.caseIds) : null;
  const words = fold(q).split(/\s+/).filter(Boolean);
  const filtered = catalog.cases.filter((item) => {
    if (
      (category && item.category !== category) ||
      (status && item.current.status !== status) ||
      (packIds && !packIds.has(item.id))
    )
      return false;
    const searchable = fold(
      [
        item.title,
        item.text,
        item.current.outcome,
        ...(item.tags || []),
        ...(item.current.limitations || []),
      ].join(' '),
    );
    return words.every((word) => searchable.includes(word));
  });
  const result = {
    schemaVersion: catalog.schemaVersion,
    context: catalog.context,
    total: filtered.length,
    offset,
    limit,
    categories: catalog.categories,
    statuses: Object.entries(statuses).map(([id, title]) => ({
      id,
      title,
      count: catalog.cases.filter((item) => item.current.status === id).length,
    })),
    packs: catalog.packs.map(({ id, title, description, caseIds }) => ({
      id,
      title,
      description,
      count: caseIds.length,
    })),
    coverage: libraryCoverage(catalog.cases),
    cases: filtered
      .slice(offset, offset + limit)
      .map((item) => ({ ...item, assessment: assessmentForCase(item) })),
  };
  return structuredClone(result);
}
function createBehaviorLibrary(policy) {
  return (actorId, params) => {
    policy.assertAdmin(actorId);
    return libraryView(loadCatalog(), params);
  };
}
module.exports = { createBehaviorLibrary, loadCatalog, normalizeCatalog, libraryView };
