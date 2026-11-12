const PREFIX = 'client-interest-v1:';
const PAGE = 128;
const MUTATION_PAGE = 64;
// A missing sentinel must never cause one encrypted read + several rewrites per
// organization. Reconcile the derived index atomically in bounded SQL pages;
// already-correct ciphertext remains byte-identical. This is still one O(N)
// bootstrap transaction, not a resumable or hard wall-time-bounded background job.
function createClientInterestBootstrap({ db, seal, open, transaction }, expectedKeys) {
  const ready = db.prepare('SELECT 1 FROM telegram_runtime WHERE key=?');
  const keys = db.prepare(
    'SELECT key FROM telegram_runtime WHERE key>? AND key<? ORDER BY key LIMIT ?',
  );
  let candidates;
  function build() {
    if (ready.get(PREFIX + 'ready')) return;
    if (!candidates) {
      const max = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='max_client_links'")
        .get();
      candidates = db.prepare(`WITH candidate_orgs AS (
        SELECT organization_id FROM telegram_settings UNION SELECT organization_id FROM telegram_links
        ${max ? 'UNION SELECT organization_id FROM max_client_links' : ''})
        SELECT c.organization_id,s.value FROM candidate_orgs c
        LEFT JOIN telegram_settings s ON s.organization_id=c.organization_id
        WHERE c.organization_id>? ORDER BY c.organization_id LIMIT ?`);
    }
    const organizations = new Set(),
      expected = new Set(),
      existing = new Set();
    let cursor = '';
    for (;;) {
      const rows = candidates.all(cursor, PAGE);
      for (const row of rows) {
        organizations.add(row.organization_id);
        const settings = row.value ? open(row.value) : {};
        // Preserve touch() semantics, including defaults and restored pauses.
        for (const key of expectedKeys(row.organization_id, {
          ...settings,
          enabled: settings.restoredPaused !== true,
        }))
          expected.add(key);
      }
      if (rows.length < PAGE) break;
      cursor = rows.at(-1).organization_id;
    }
    cursor = PREFIX;
    for (;;) {
      const rows = keys.all(cursor, PREFIX + '\uffff', PAGE);
      for (const row of rows) existing.add(row.key);
      if (rows.length < PAGE) break;
      cursor = rows.at(-1).key;
    }
    const stale = [];
    for (const key of existing) {
      const kind = ['all', 'reminder', 'lifecycle'].find((value) =>
        key.startsWith(PREFIX + value + ':'),
      );
      if (kind && organizations.has(key.slice((PREFIX + kind + ':').length)) && !expected.has(key))
        stale.push(key);
    }
    for (let offset = 0; offset < stale.length; offset += MUTATION_PAGE) {
      const page = stale.slice(offset, offset + MUTATION_PAGE);
      db.prepare(
        'DELETE FROM telegram_runtime WHERE key IN (' + page.map(() => '?').join(',') + ')',
      ).run(...page);
    }
    const missing = [...expected].filter((key) => !existing.has(key));
    for (let offset = 0; offset < missing.length; offset += MUTATION_PAGE) {
      const page = missing.slice(offset, offset + MUTATION_PAGE);
      db.prepare(
        'INSERT INTO telegram_runtime(key,value) VALUES ' + page.map(() => '(?,?)').join(','),
      ).run(...page.flatMap((key) => [key, seal({ active: true })]));
    }
    // Publishing readiness is the final mutation. Any error rolls back both the
    // missing/stale changes and this sentinel with the owning transaction.
    db.prepare('INSERT OR REPLACE INTO telegram_runtime VALUES(?,?)').run(
      PREFIX + 'ready',
      seal({ version: 1 }),
    );
  }
  return function ensure() {
    if (ready.get(PREFIX + 'ready')) return;
    if (db.isTransaction) build();
    else transaction(build);
  };
}
module.exports = { createClientInterestBootstrap };
