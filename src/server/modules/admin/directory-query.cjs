function searchWords(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/u)
    .filter(Boolean);
}
function directoryQuery(kind, options, { fail, limitKey }) {
  const q = String(options.q || '').trim();
  const words = searchWords(q);
  if (q.length > 120 || words.length > 8) throw fail(400, 'Сократите поисковый запрос.');
  const status = options.status || '';
  if (!['', 'active', 'suspended'].includes(status)) throw fail(400, 'Неверный фильтр доступа.');
  const plan = options.plan || '';
  if (!['', 'free', 'paid'].includes(plan)) throw fail(400, 'Неверный фильтр тарифа.');
  const scope = limitKey('admin-page', JSON.stringify({ kind, q, status, plan }));
  let cursor = null;
  if (options.cursor) {
    try {
      if (typeof options.cursor !== 'string' || options.cursor.length > 2048) throw Error();
      cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
      if (
        cursor.scope !== scope ||
        cursor.signature !==
          limitKey('admin-cursor', JSON.stringify([cursor.scope, cursor.time, cursor.id])) ||
        !Number.isSafeInteger(cursor.time) ||
        typeof cursor.id !== 'string'
      )
        throw Error();
    } catch {
      throw fail(400, 'Неверная страница поиска. Начните поиск заново.');
    }
  }
  const clauses = ['1=1'],
    parameters = [];
  if (status) {
    clauses.push('r.status=?');
    parameters.push(status);
  }
  if (kind === 'organization' && plan) {
    clauses.push('EXISTS(SELECT 1 FROM subscriptions s WHERE s.organization_id=r.id AND s.plan=?)');
    parameters.push(plan);
  }
  for (const word of words) {
    const term = limitKey('admin-search', word);
    if (kind === 'organization') {
      clauses.push(
        "(EXISTS(SELECT 1 FROM admin_directory_terms t WHERE t.kind='organization' AND t.resource_id=r.id AND t.term_hash=?) OR EXISTS(SELECT 1 FROM memberships m JOIN admin_directory_terms t ON t.kind='account' AND t.resource_id=m.account_id WHERE m.organization_id=r.id AND m.role='owner' AND t.term_hash=?))",
      );
      parameters.push(term, term);
    } else {
      const role =
        { владелец: 'owner', администратор: 'salon_admin', сотрудник: 'cosmetologist' }[word] || '';
      clauses.push(
        "(EXISTS(SELECT 1 FROM admin_directory_terms t WHERE t.kind='account' AND t.resource_id=r.id AND t.term_hash=?) OR EXISTS(SELECT 1 FROM memberships m JOIN admin_directory_terms t ON t.kind='organization' AND t.resource_id=m.organization_id WHERE m.account_id=r.id AND (t.term_hash=? OR m.role=?)))",
      );
      parameters.push(term, term, role);
    }
  }
  return { clauses, parameters, cursor, scope };
}
function directoryCursor(scope, row, limitKey) {
  return Buffer.from(
    JSON.stringify({
      scope,
      time: row.created_at,
      id: row.id,
      signature: limitKey('admin-cursor', JSON.stringify([scope, row.created_at, row.id])),
    }),
  ).toString('base64url');
}
module.exports = { searchWords, directoryQuery, directoryCursor };
