const queries = require('../../infrastructure/postgres/queue-org-maintenance-sql134.cjs');
// Discovery is a hint. Each bounded write rechecks original metadata under the
// organization's admission; the cursor advances even when that owner is busy.
function createOrganizationQueueMaintenanceStore(c) {
  const { db } = c;
  const phases = queries.phases.map((d) => {
    const head = db.prepare(
      `SELECT organization_id,${d.lagColumn} due,id FROM ${d.table} WHERE (${d.predicate}) AND organization_id<>? AND (${d.lagColumn}>? OR (${d.lagColumn}=? AND id>?)) ORDER BY ${d.lagColumn},id LIMIT 1`,
    );
    const rows = db.prepare(
      `SELECT id,status,lease_until,expires_at,${d.lagColumn} due FROM ${d.table} WHERE organization_id=? AND (${d.predicate}) ORDER BY ${d.lagColumn},id LIMIT ?`,
    );
    let cursor = { due: Number.MIN_SAFE_INTEGER, id: '', org: '' };
    function nextOrganization(now) {
      const args = queries.parameters(d, now);
      let row = head.get(...args, cursor.org, cursor.due, cursor.due, cursor.id);
      if (!row)
        row = head.get(...args, cursor.org, Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, '');
      if (!row) row = head.get(...args, '', Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, '');
      if (!row) return null;
      cursor = { due: row.due, id: row.id, org: row.organization_id };
      return row.organization_id;
    }
    return {
      channel: d.channel,
      queueDomain: d.domain,
      nextOrganization,
      run(now, limit, org) {
        const parameters = queries.parameters(d, now),
          selected = rows.all(org, ...parameters, limit);
        let changed = 0;
        for (let offset = 0; offset < selected.length; offset += 64) {
          const batch = selected.slice(offset, offset + 64),
            plan = queries.statement(d, batch.length);
          changed += db
            .prepare(plan.sql)
            .run(
              ...(d.mode === 'delete'
                ? []
                : batch.flatMap((row) => [row.id, queries.status(d, row, now)])),
              org,
              ...parameters,
              ...batch.flatMap((row) => [row.id, row.status, row.lease_until, row.expires_at]),
            ).changes;
        }
        return {
          examined: selected.length,
          changed,
          lagMs: selected.length ? Math.max(0, now - d.lagOffset - selected[0].due) : 0,
        };
      },
      recover(directNow, limit, org) {
        return this.run(directNow, limit, org);
      },
      id: d.id,
    };
  });
  for (const channel of ['telegram', 'max']) {
    const prefix = 'staff-selftest-v1:' + channel + ':',
      sql = require('../../infrastructure/postgres/queue-marker-sql134.cjs').find(
        (e) => e.domains[0] === 'staff-' + channel,
      ).sql;
    const page = db.prepare(
      'SELECT key FROM telegram_runtime WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT 1',
    );
    let cursor = '';
    phases.push({
      channel,
      queueDomain: 'staff-' + channel,
      nextEntity() {
        let row = page.get(prefix, prefix + '\uffff', cursor);
        if (!row) {
          cursor = '';
          row = page.get(prefix, prefix + '\uffff', cursor);
        }
        if (!row) return null;
        cursor = row.key;
        return { domain: 'staff-' + channel, kind: 'marker', key: row.key };
      },
      run(now, _limit, scope) {
        return { examined: 1, changed: db.prepare(sql).run(scope.key, now).changes, lagMs: 0 };
      },
    });
  }
  const recover = (ids, now, limit, org) => {
    if (!org) throw Error('Organization required for queue recovery.');
    let examined = 0,
      changed = 0;
    for (const entry of phases.filter((p) => ids.includes(p.id))) {
      if (examined >= limit) break;
      const r = entry.run(now, limit - examined, org);
      examined += r.examined;
      changed += r.changed;
    }
    return { examined, changed };
  };
  return {
    organizationScoped: true,
    phases,
    recoverClient: (now, channels, limit = 8, org) =>
      recover(
        channels.flatMap((channel) => [
          'client-' + channel + '-sending',
          'client-' + channel + '-reserved',
        ]),
        now,
        limit,
        org,
      ),
    recoverStaffMax: (now, limit = 8, org) => recover(['staff-max-sending'], now, limit, org),
  };
}
module.exports = { createOrganizationQueueMaintenanceStore };
