const { searchWords, directoryQuery, directoryCursor } = require('./directory-query.cjs');

function createAdminDirectory(context, commands) {
  const { db, open, limitKey, fail, transaction, setAuditObserver } = context;
  const hash = (term) => limitKey('admin-search', term);
  const source = Object.fromEntries(
    [
      ['account', 'accounts'],
      ['organization', 'organizations'],
    ].map(([kind, table]) => [kind, db.prepare('SELECT value FROM ' + table + ' WHERE id=?')]),
  );
  const previousRecord = db.prepare(
    'SELECT source_value FROM admin_directory_records WHERE kind=? AND resource_id=?',
  );
  const saveRecord = db.prepare(
    'INSERT INTO admin_directory_records VALUES(?,?,?) ON CONFLICT(kind,resource_id) DO UPDATE SET source_value=excluded.source_value',
  );
  const clearTerms = db.prepare('DELETE FROM admin_directory_terms WHERE kind=? AND resource_id=?');
  const insertTerm = db.prepare('INSERT INTO admin_directory_terms VALUES(?,?,?)');
  function sync(kind, resourceId, bump = false) {
    if (!resourceId) return;
    const row = source[kind].get(resourceId);
    if (!row) return;
    const previous = previousRecord.get(kind, resourceId);
    if (previous && Buffer.from(previous.source_value).equals(Buffer.from(row.value))) return;
    const value = open(row.value);
    const tokens = searchWords(
      kind === 'account'
        ? value.displayName + ' ' + value.email
        : [value.name, value.city, value.phone].join(' '),
    );
    if (kind === 'organization') {
      const digits = String(value.phone || '').replace(/\D/g, '');
      if (digits)
        tokens.push(
          digits,
          /^[78]\d{10}$/.test(digits) ? '8' + digits.slice(1) : digits,
          /^[78]\d{10}$/.test(digits) ? '7' + digits.slice(1) : digits,
        );
    }
    saveRecord.run(kind, resourceId, row.value);
    clearTerms.run(kind, resourceId);
    const prefixes = new Set();
    for (const token of tokens)
      for (let size = 1; size <= Math.min(80, token.length); size++)
        prefixes.add(hash(token.slice(0, size)));
    for (const term of prefixes) insertTerm.run(kind, resourceId, term);
    if (previous && bump) commands.touch(kind, resourceId);
  }
  transaction(() => {
    for (const kind of ['account', 'organization']) {
      const table = kind === 'account' ? 'accounts' : 'organizations';
      const changed = db.prepare(
        'SELECT r.id FROM ' +
          table +
          ' r LEFT JOIN admin_directory_records d ON d.kind=? AND d.resource_id=r.id ' +
          'WHERE d.resource_id IS NULL OR d.source_value<>r.value',
      );
      for (const row of changed.iterate(kind)) sync(kind, row.id);
    }
  });
  setAuditObserver((event, actorId, organizationId, detail) => {
    // AUTH admission independently proves both source projections equal under policy SH.
    // Stale/missing projections route to the legacy writer before BEGIN for the existing repair.
    if (db.transactionIntent === 'AUTH' && event === 'login_succeeded') return;
    const bump = detail.version !== 1;
    for (const accountId of new Set([actorId, detail.accountId])) sync('account', accountId, bump);
    sync('organization', organizationId, bump);
  });
  function page(kind, options = {}) {
    const { clauses, parameters, cursor, scope } = directoryQuery(kind, options, {
      fail,
      limitKey,
    });
    const table = kind === 'account' ? 'accounts' : 'organizations';
    const where = clauses.join(' AND ');
    const total = db
      .prepare('SELECT count(*) n FROM ' + table + ' r WHERE ' + where)
      .get(...parameters).n;
    if (cursor) {
      clauses.push('(r.created_at<? OR (r.created_at=? AND r.id<?))');
      parameters.push(cursor.time, cursor.time, cursor.id);
    }
    const rows = db
      .prepare(
        'SELECT r.* FROM ' +
          table +
          ' r WHERE ' +
          clauses.join(' AND ') +
          ' ORDER BY r.created_at DESC,r.id DESC LIMIT 21',
      )
      .all(...parameters);
    const selected = rows.slice(0, 20),
      last = selected.at(-1);
    const nextCursor = rows.length > 20 ? directoryCursor(scope, last, limitKey) : null;
    return { rows: selected, total, nextCursor };
  }
  return { page, sync };
}
module.exports = { createAdminDirectory };
