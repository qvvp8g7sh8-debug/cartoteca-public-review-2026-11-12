const {
  billingAuditSchemas,
  billingAuditDetail,
  billingAuditTarget,
} = require('../billing/audit.cjs');
function createAdminAudit({ db, open, fail, limitKey }, policy) {
  function page(actorId, input = {}) {
    policy.assert(actorId, 'audit.read');
    const clauses = ['1=1'],
      parameters = [];
    const q = String(input.q || '').trim();
    const words = q
      .normalize('NFKC')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^a-zа-я0-9]+/u)
      .filter(Boolean);
    if (q.length > 120 || words.length > 8) throw fail(400, 'Сократите поиск по истории.');
    for (const word of words) {
      clauses.push(
        "EXISTS(SELECT 1 FROM admin_directory_terms t WHERE t.term_hash=? AND ((t.kind='account' AND (t.resource_id=a.actor_id OR (json_extract(a.detail,'$.targetType')='account' AND t.resource_id=json_extract(a.detail,'$.targetId')))) OR (t.kind='organization' AND t.resource_id=a.organization_id)))",
      );
      parameters.push(limitKey('admin-search', word));
    }
    for (const [key, column] of [
      ['actorId', 'a.actor_id'],
      ['organizationId', 'a.organization_id'],
      ['event', 'a.event'],
    ]) {
      if (input[key]) {
        clauses.push(column + '=?');
        parameters.push(String(input[key]).slice(0, 120));
      }
    }
    if (input.before) {
      const before = Number(input.before);
      if (!Number.isSafeInteger(before) || before < 1)
        throw fail(400, 'Неверная страница истории.');
      clauses.push('a.id<?');
      parameters.push(before);
    }
    const rows = db
      .prepare(
        'SELECT a.*,d.value FROM platform_audit a LEFT JOIN admin_audit_details d ON d.audit_id=a.id WHERE ' +
          clauses.join(' AND ') +
          ' ORDER BY a.id DESC LIMIT 21',
      )
      .all(...parameters);
    function displayAccount(id) {
      const row = id && db.prepare('SELECT value FROM accounts WHERE id=?').get(id);
      return row ? open(row.value).displayName : null;
    }
    return {
      items: rows.slice(0, 20).map((row) => {
        const legacy = JSON.parse(row.detail || '{}');
        const org =
          row.organization_id &&
          db.prepare('SELECT value FROM organizations WHERE id=?').get(row.organization_id);
        const stored = row.value ? open(row.value) : null;
        const detail =
          stored && billingAuditSchemas[row.event]
            ? billingAuditDetail(row.event, stored)
            : stored || { legacy: true, after: {} };
        return {
          id: row.id,
          time: row.time,
          event: row.event,
          actorId: row.actor_id,
          actorName: displayAccount(row.actor_id),
          organizationId: row.organization_id,
          organizationName: org ? open(org.value).name : null,
          targetType:
            legacy.version === 1
              ? billingAuditSchemas[row.event]?.targetType || legacy.targetType
              : null,
          targetId:
            legacy.version === 1
              ? billingAuditSchemas[row.event]
                ? billingAuditTarget(row.event, legacy.targetId)
                : legacy.targetId
              : null,
          detail,
        };
      }),
      next: rows.length > 20 ? rows[19].id : null,
    };
  }
  return { page };
}
module.exports = { createAdminAudit };
