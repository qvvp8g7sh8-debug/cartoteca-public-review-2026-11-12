// The same closed domains select advisory ownership and durable revisions.
// Callers cannot supply SQL identifiers or split a global queue by organization.
const queueDomainTables = Object.freeze({
  telegram: Object.freeze(['telegram_jobs']),
  'staff-telegram': Object.freeze(['staff_notification_jobs']),
  'staff-max': Object.freeze(['staff_max_jobs']),
  push: Object.freeze(['staff_push_jobs']),
  client: Object.freeze(['notification_channel_jobs', 'notification_jobs']),
  'max-inbox': Object.freeze(['max_event_inbox', 'max_runtime_leases']),
});
const queueDomainNames = Object.freeze(Object.keys(queueDomainTables));
function queueDomainForTable(table, key) {
  if (table === 'telegram_runtime') {
    if (typeof key !== 'string') return null;
    const channel = /^staff-selftest-v1:(telegram|max):[A-Za-z0-9_-]{1,128}$/.exec(key)?.[1];
    return channel ? 'staff-' + channel : null;
  }
  for (const domain of queueDomainNames)
    if (queueDomainTables[domain].includes(table)) return domain;
  return null;
}
function assertQueueDomain(domain) {
  if (typeof domain !== 'string' || !Object.hasOwn(queueDomainTables, domain))
    throw Object.assign(Error('Invalid PostgreSQL queue domain.'), {
      code: 'POSTGRES_QUEUE_DOMAIN_INVALID',
    });
  return domain;
}
module.exports = { queueDomainTables, queueDomainNames, queueDomainForTable, assertQueueDomain };
