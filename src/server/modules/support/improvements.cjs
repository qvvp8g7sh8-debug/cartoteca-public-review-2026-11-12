// Proposals share the encrypted support store, but have their own author-only projection.
function createImprovementListing({ db, open, fail }) {
  function improvements(current, input = {}) {
    const clauses = ['r.account_id=?', 'r.organization_id IS ?'],
      parameters = [current.accountId, current.organizationId || null];
    if (input.before) {
      const before = Number(input.before);
      if (
        !Number.isSafeInteger(before) ||
        before < 1 ||
        !/^[\w-]{1,128}$/.test(input.beforeId || '')
      )
        throw fail(400, 'Неверная страница предложений.');
      clauses.push('(r.created_at<? OR (r.created_at=? AND r.id<?))');
      parameters.push(before, before, input.beforeId);
    }
    // Bounded scan: the category stays encrypted. Cursor advances through scanned rows,
    // including ordinary support cases, so an empty page never loses older proposals.
    const rows = db
      .prepare(
        'SELECT r.id,r.created_at,r.value,c.changed_at FROM support_requests r JOIN support_cases c ON c.request_id=r.id WHERE ' +
          clauses.join(' AND ') +
          ' ORDER BY r.created_at DESC,r.id DESC LIMIT 51',
      )
      .all(...parameters);
    const items = rows.slice(0, 50).flatMap((row) => {
      const value = open(row.value);
      return value.kind === 'improvement'
        ? [
            {
              id: row.id,
              createdAt: row.created_at,
              changedAt: row.changed_at,
              description: value.description,
              state: value.improvementState || 'received',
            },
          ]
        : [];
    });
    return {
      items,
      next: rows.length > 50 ? { before: rows[49].created_at, beforeId: rows[49].id } : null,
    };
  }
  return { improvements };
}
module.exports = { createImprovementListing };
