const {
  tables,
  queueStatements,
  compatibilityStatements,
} = require('./queue-org-statements134.cjs');
const freeze = (entry, domain) =>
  Object.freeze({
    sql: entry.sql,
    org: Object.freeze([...entry.org]),
    domains: Object.freeze([domain]),
  });
const entries = Object.keys(tables).flatMap((domain) =>
  Object.values(queueStatements(domain)).map((entry) => freeze(entry, domain)),
);
function candidates(arity) {
  const selected = [];
  for (const domain of Object.keys(tables)) {
    const widths = {
      update: ['telegram', 'client'].includes(domain) ? 6 : 7,
      remove: 3,
      ...(domain.startsWith('staff-') ? { markers: 1 } : {}),
    };
    for (const [kind, width] of Object.entries(widths)) {
      const count = (arity - 1) / width;
      if (Number.isSafeInteger(count) && count >= 1 && count <= 64)
        selected.push(freeze(compatibilityStatements(tables[domain], count)[kind], domain));
    }
  }
  return selected;
}
Object.defineProperty(entries, 'candidates', { value: candidates });
module.exports = Object.freeze(entries);
