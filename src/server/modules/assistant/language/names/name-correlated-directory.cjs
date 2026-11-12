const { readCabinetSnapshot } = require('../../../../infrastructure/cabinet-read-snapshot.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const { cachedRows, cachedSearchText } = require('../../../cabinet/directory.cjs');
const { LIMITS, nameTokens, searchPlan, matchesName } = require('./name-matching.cjs');
const { readSteps } = require('../../read-steps.cjs');
function correlatedNamePlan(query) {
  if (typeof query !== 'string' || query.length > 160) return null;
  const words = nameTokens(query);
  if (
    words.length < 2 ||
    words.length > 3 ||
    words.some((word) => word.length < 2 || word.length > 48)
  )
    return null;
  const plans = words.map(searchPlan);
  if (plans.some((plan) => plan.overflow || !plan.queries.length)) return null;
  let families = plans.map((plan) => plan.queries);
  const distinct = () => [...new Set(families.flat())];
  if (distinct().length > LIMITS.queries) {
    // Every original literal query retains a prefix in its own family, including ё aliases.
    // This packs candidate reads only: the complete original FIO still decides identity.
    families = families.map((family) => {
      const prefixes = [...new Set(family.map((value) => value.slice(0, 4)))];
      return prefixes.filter(
        (value) =>
          !prefixes.some((other) => other.length < value.length && value.startsWith(other)),
      );
    });
  }
  const queries = distinct();
  return queries.length <= LIMITS.queries ? { words, families, queries } : null;
}
function currentScope(c, expected = '') {
  c.assertCurrent();
  const current = c.current;
  if (
    !current?.organizationId ||
    !current.accountId ||
    current.globalAdmin ||
    !['owner', 'salon_admin', 'cosmetologist'].includes(current.role)
  )
    throw fail(403, 'Нет доступа к поиску клиентов этой организации.');
  const identity = JSON.stringify([
    current.organizationId,
    current.accountId,
    current.role,
    current.sessionId,
  ]);
  if (expected && identity !== expected)
    throw fail(409, 'Доступ к поиску клиентов изменился. Повторите запрос.');
  return { current, identity };
}
const correlatedClientMatches = readSteps(function* (c, query) {
  const plan = correlatedNamePlan(query);
  if (!plan) return null;
  const { current, identity } = currentScope(c);
  if (c.assistantReads) {
    const result = yield c.assistantReads.directory(query, LIMITS.perQuery, {
      families: plan.families,
    });
    currentScope(c, identity);
    if (result.matched > LIMITS.perQuery || result.matched > LIMITS.candidates) return null;
    const matches = result.directory.filter((row) => matchesName(row, query));
    return matches.length ? { matches, overflow: false } : null;
  }
  const storage = c.tenantStore(current.organizationId),
    encode = storage.encode;
  return readCabinetSnapshot(storage, () => {
    currentScope(c, identity);
    const revision = storage.get('revision', 0);
    const entry = cachedRows(storage, current);
    const check = () => {
      currentScope(c, identity);
      if (
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        entry.revision !== revision ||
        storage.get('revision', 0) !== revision ||
        storage.encode !== encode ||
        entry.encode !== encode
      )
        throw fail(409, 'Список клиентов изменился. Повторите поиск.');
    };
    check();
    const candidates = [];
    let overflow = false;
    for (const row of entry.rows) {
      const text = cachedSearchText(row);
      if (!plan.families.every((family) => family.some((anchor) => text.includes(anchor))))
        continue;
      candidates.push(row);
      if (candidates.length > LIMITS.perQuery || candidates.length > LIMITS.candidates) {
        overflow = true;
        break;
      }
    }
    check();
    if (overflow) return null;
    const matches = candidates.filter((row) => matchesName(row, query));
    check();
    return matches.length ? { matches, overflow: false } : null;
  });
});
module.exports = { correlatedNamePlan, correlatedClientMatches };
