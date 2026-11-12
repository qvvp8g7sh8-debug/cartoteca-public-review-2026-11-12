const FUNCTIONS = Object.freeze({
  session: ['pg_try_advisory_lock', 'pg_try_advisory_lock_shared'],
  transaction: ['pg_try_advisory_xact_lock', 'pg_try_advisory_xact_lock_shared'],
  release: ['pg_advisory_unlock', 'pg_advisory_unlock_shared'],
});
const invalid = () =>
  Object.assign(Error('PostgreSQL ordered lock batch failed.'), {
    code: 'POSTGRES_LOCK_BATCH_INVALID',
  });
function lockBatch(locks, operation) {
  if (!Array.isArray(locks) || locks.length > 16 || !Object.hasOwn(FUNCTIONS, operation))
    throw invalid();
  const keys = new Set();
  for (const lock of locks) {
    if (
      !lock ||
      typeof lock.key !== 'string' ||
      !/^(?:0|-?[1-9][0-9]{0,18})$/.test(lock.key) ||
      BigInt(lock.key) < -(1n << 63n) ||
      BigInt(lock.key) >= 1n << 63n ||
      typeof lock.shared !== 'boolean' ||
      keys.has(lock.key)
    )
      throw invalid();
    keys.add(lock.key);
  }
  if (!locks.length) return null;
  const release = operation === 'release';
  const steps = locks.map((lock, index) => {
    const fn = FUNCTIONS[operation][lock.shared ? 1 : 0],
      call = `pg_catalog.${fn}($${index + 1}::bigint)`,
      prior = `ct_lock_${index - 1}`;
    // A materialized dependency forces every later acquisition to inspect the
    // confirmed prefix first. CASE never invokes a later try-lock after false.
    // Release deliberately attempts every key, even after a false unlock.
    return `ct_lock_${index} AS MATERIALIZED (SELECT ${
      index && !release ? `CASE WHEN locked THEN ${call} ELSE false END` : call
    } AS locked${index ? ` FROM ${prior}` : ''})`;
  });
  return {
    text: `WITH ${steps.join(',')} SELECT ARRAY[${locks
      .map((_, index) => `(SELECT locked FROM ct_lock_${index})`)
      .join(',')}] AS locked`,
    values: locks.map((lock) => lock.key),
  };
}
async function runLockBatch(client, locks, operation) {
  const plan = lockBatch(locks, operation);
  if (!plan) return [];
  const result = await client.query(plan.text, plan.values),
    locked = result?.rows?.[0]?.locked;
  if (
    !Array.isArray(result?.rows) ||
    result.rows.length !== 1 ||
    !Array.isArray(locked) ||
    locked.length !== locks.length ||
    locks.some((_, index) => typeof locked[index] !== 'boolean') ||
    (operation !== 'release' && locked.some((value, index) => value && locked[index - 1] === false))
  )
    throw invalid();
  return locked;
}
module.exports = { lockBatch, runLockBatch };
