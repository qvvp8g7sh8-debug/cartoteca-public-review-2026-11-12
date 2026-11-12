const tables = Object.freeze({
  telegram: 'telegram_jobs',
  'staff-telegram': 'staff_notification_jobs',
  'staff-max': 'staff_max_jobs',
  push: 'staff_push_jobs',
  client: 'notification_channel_jobs',
});
function queueStatements(domain) {
  const table = tables[domain];
  if (!table) throw Error('Unknown scoped notification queue.');
  if (domain === 'telegram')
    return {
      claim: {
        sql: `UPDATE ${table} SET status='sending',attempts=attempts+1,lease_until=? WHERE organization_id=? AND id=? AND status=? AND attempts=? AND lease_until=? AND callback_hash=? AND expires_at>?`,
        org: [2],
      },
      finish: {
        sql: `UPDATE ${table} SET status=?,next_at=?,lease_until=0 WHERE organization_id=? AND id=? AND status='sending' AND attempts=? AND callback_hash=? AND lease_until=?`,
        org: [3],
      },
      defer: {
        sql: `UPDATE ${table} SET status='pending',next_at=?,lease_until=0,attempts=attempts-1 WHERE organization_id=? AND id=? AND status='sending' AND attempts=? AND callback_hash=? AND lease_until=? AND attempts>0`,
        org: [2],
      },
    };
  if (domain.startsWith('staff-')) {
    const channel = domain === 'staff-max' ? 'max' : 'telegram';
    return {
      claim: {
        sql: `UPDATE ${table} SET status='sending',attempts=attempts+1,lease_until=?,lease_id=? WHERE organization_id=? AND id=? AND status=? AND attempts=? AND lease_until=? AND lease_id IS ?`,
        org: [3],
      },
      finish: {
        sql: `UPDATE ${table} SET status=?,next_at=?,lease_until=0,lease_id=NULL,attempts=attempts-? WHERE organization_id=? AND id=? AND status='sending' AND lease_id=? AND lease_until=? AND attempts>=?`,
        org: [4],
      },
      forget: {
        sql: `DELETE FROM telegram_runtime WHERE key=? AND EXISTS(SELECT 1 FROM ${table} j WHERE j.organization_id=? AND telegram_runtime.key='staff-selftest-v1:${channel}:' || j.id)`,
        org: [2],
      },
    };
  }
  if (domain === 'push')
    return {
      claim: {
        sql: `UPDATE ${table} SET status='sending',attempts=attempts+1,lease_id=?,lease_until=? WHERE organization_id=? AND id=? AND status=? AND attempts=? AND lease_until=? AND lease_id IS ? AND NOT EXISTS(SELECT 1 FROM ${table} live WHERE live.organization_id=? AND live.device_id=? AND live.status='sending' AND live.lease_until>?)`,
        org: [3, 9],
      },
      finish: {
        sql: `UPDATE ${table} SET status=?,next_at=?,lease_id=NULL,lease_until=0 WHERE organization_id=? AND id=? AND status='sending' AND lease_id=? AND lease_until=?`,
        org: [3],
      },
      defer: {
        sql: `UPDATE ${table} SET status='pending',next_at=?,lease_id=NULL,lease_until=0,attempts=attempts-1 WHERE organization_id=? AND id=? AND status='sending' AND lease_id=? AND lease_until=? AND attempts=? AND attempts>0`,
        org: [2],
      },
    };
  return {
    claim: {
      sql: `UPDATE ${table} SET status='reserved',attempt=attempt+1,lease_until=? WHERE organization_id=? AND id=? AND status='pending' AND attempt=? AND lease_until=? AND next_at<=? AND expires_at>?`,
      org: [2],
    },
    transition: {
      sql: `UPDATE ${table} SET status=?,next_at=?,lease_until=?,value=? WHERE organization_id=? AND id=? AND status=? AND attempt=? AND callback_hash=? AND lease_until=?`,
      org: [5],
    },
  };
}
function compatibilityStatements(table, count) {
  const domain = Object.keys(tables).find((name) => tables[name] === table);
  if (!domain || !Number.isInteger(count) || count < 1 || count > 64)
    throw Error('Invalid scoped queue batch.');
  const noLease = ['telegram', 'client'].includes(domain);
  return {
    update: {
      sql: `UPDATE ${table} SET status=CASE id ${Array(count).fill('WHEN ? THEN ?').join(' ')} ELSE status END,lease_until=0${noLease ? '' : ',lease_id=NULL'} WHERE organization_id=? AND (${Array(
        count,
      )
        .fill(
          `(id=? AND status=? AND expires_at=? AND lease_until=?${noLease ? '' : ' AND lease_id IS ?'})`,
        )
        .join(' OR ')})`,
      org: [count * 2 + 1],
    },
    remove: {
      sql: `DELETE FROM ${table} WHERE organization_id=? AND (${Array(count).fill('(id=? AND status=? AND expires_at=?)').join(' OR ')})`,
      org: [1],
    },
    ...(domain.startsWith('staff-')
      ? {
          markers: {
            sql: `DELETE FROM telegram_runtime WHERE key IN (${Array(count).fill('?').join(',')}) AND EXISTS(SELECT 1 FROM ${table} j WHERE j.organization_id=? AND telegram_runtime.key='staff-selftest-v1:${domain === 'staff-max' ? 'max' : 'telegram'}:' || j.id)`,
            org: [count + 1],
          },
        }
      : {}),
  };
}
module.exports = { tables, queueStatements, compatibilityStatements };
