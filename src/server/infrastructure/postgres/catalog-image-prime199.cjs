const { randomUUID } = require('node:crypto');
const { KEYS } = require('./lock-intents.cjs');
const { invalid199 } = require('./catalog-image-anchors199.cjs');

// Compile the new anchor constants before READY, with a freshly random absent
// authority. No patient/cache warmup and no clinical response is admitted here.
async function primeCatalogImage199({ sql, marker, capability, queries }) {
  if (!capability) return;
  const cabinet = marker.stores.find((s) => s.kind === 'cabinet' && s.organizationId);
  if (!cabinet) return;
  const accountId = randomUUID();
  const input = {
    claimedAccountId: accountId,
    claimedOrganizationId: cabinet.organizationId,
    tokenHash: '0'.repeat(64),
    audience: '*',
    selectedIds: [],
  };
  for (const variant of ['metadata169', 'directory196']) {
    if (!capability.variants[variant] || !queries[variant]) continue;
    const plan = queries[variant](input);
    if (plan.unsupported) continue;
    const result = await sql(plan.text, plan.values);
    if (
      result.rows.length !== 1 ||
      result.rows[0].id != null ||
      result.rows[0].account_value != null ||
      result.rows[0].session_value != null ||
      result.rows[0].fence_locked !== true
    )
      throw invalid199();
  }
  if (!capability.variants.patient197 || !queries.patient197 || cabinet.schemaVersion !== 2) return;
  const plan = queries.patient197({
    scope: { kind: 'cabinet', storeId: cabinet.storeId, organizationId: cabinet.organizationId },
    current: {
      accountId,
      organizationId: cabinet.organizationId,
      sessionId: randomUUID(),
      globalAdmin: false,
      role: 'owner',
    },
    token: randomUUID() + randomUUID(),
    selection: {
      kind: 'card',
      id: randomUUID(),
      audience: '*',
      cursor: { visit: 0, outcome: 0, upcoming: 0 },
    },
  });
  if (plan.unsupported) return;
  const lock = await sql('SELECT pg_catalog.pg_try_advisory_lock_shared($1::bigint) held', [
    KEYS.maintenance,
  ]);
  if (lock.rows.length !== 1 || lock.rows[0].held !== true) throw invalid199();
  try {
    await sql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await sql(plan.text, plan.values);
    const header = result.rows.find((r) => r.section197 === 'guard197');
    // An absent authority also removes the C binding, so the original capsule
    // may classify this harmless compile-only result as dependency.
    if (
      !header ||
      !['authority', 'dependency'].includes(header.payload197?.reason) ||
      header.payload197.locked !== true ||
      header.payload197.released !== true ||
      !result.rows.every(
        (r) =>
          r.section197 !== 'body197' &&
          r.cipher197 == null &&
          r.account197 == null &&
          r.session197 == null,
      )
    )
      throw invalid199();
    await sql('COMMIT');
  } catch (error) {
    await sql('ROLLBACK').catch(() => {});
    // Startup caller closes this physical connection on failure, releasing
    // any pre-BEGIN fence not consumed by the capsule.
    throw error;
  }
}
module.exports = { primeCatalogImage199 };
