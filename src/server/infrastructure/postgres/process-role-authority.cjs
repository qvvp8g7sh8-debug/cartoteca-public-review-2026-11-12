const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const LEASE_MS = 60000;
const CLOSE_MS = 2000;
const MAX_OWNERS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['expired', 'released', 'closed', 'unavailable']);
const CLEAN_BUSY = Symbol('proven lease unchanged');
const CODES = new Set([
  'POSTGRES_ROLE_AUTHORITY_ARGUMENT',
  'POSTGRES_ROLE_AUTHORITY_UNAVAILABLE',
  'POSTGRES_ROLE_AUTHORITY_BUSY',
  'POSTGRES_ROLE_AUTHORITY_CONFLICT',
  'POSTGRES_ROLE_AUTHORITY_CAPACITY',
  'POSTGRES_ROLE_AUTHORITY_LOST',
  'POSTGRES_ROLE_AUTHORITY_QUERY_FAILED',
  'POSTGRES_ROLE_AUTHORITY_CLOSE_TIMEOUT',
]);
function fault(code, fields = {}) {
  const error = Object.assign(Error('PostgreSQL process role coordination is unavailable.'), {
    code: CODES.has(code) ? code : 'POSTGRES_ROLE_AUTHORITY_UNAVAILABLE',
    status: 503,
  });
  for (const name of ['leaseUnchanged', 'transactionOpen', 'outcomeUnknown', 'channelPoisoned'])
    if (typeof fields[name] === 'boolean') error[name] = fields[name];
  return error;
}
function exact(value, names) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function commandOf(value) {
  const fields = value?.op === 'acquire' ? ['op', 'role', 'owner'] : ['op', 'owner', 'token'];
  if (
    !exact(value, fields) ||
    !['acquire', 'renew', 'release'].includes(value.op) ||
    typeof value.owner !== 'string' ||
    !UUID.test(value.owner) ||
    (value.op === 'acquire'
      ? !['combined', 'background'].includes(value.role)
      : typeof value.token !== 'string' || !UUID.test(value.token))
  )
    throw fault('POSTGRES_ROLE_AUTHORITY_ARGUMENT');
  return value;
}
function roleLockKey(platformStoreId) {
  if (typeof platformStoreId !== 'string' || !UUID.test(platformStoreId.toLowerCase()))
    throw fault('POSTGRES_ROLE_AUTHORITY_ARGUMENT');
  return createHash('sha256')
    .update('cartoteca:process-role-ttl:v1:' + platformStoreId.toLowerCase())
    .digest()
    .readBigInt64BE()
    .toString();
}
const tokenHash = (token) => createHash('sha256').update(token).digest();
const TABLE = 'cartoteca_catalog.process_role_leases';
const LIVE =
  'platform_store_id=$1 AND owner=$2 AND role=$3 AND token_hash=$4::bytea AND expires_at>clock_timestamp()';

// Only a NEW dedicated, connected pg.Client may be passed. The worker verifies
// exact asset lineage, app role and native technical-table schema before this
// construction. No SQL/text/scope/clock can arrive through the dispatch API.
async function createProcessRoleAuthority(client, options) {
  if (
    !client ||
    typeof client.query !== 'function' ||
    typeof client.end !== 'function' ||
    !exact(options, ['platformStoreId', 'lineageVerified']) ||
    options.lineageVerified !== true ||
    typeof options.platformStoreId !== 'string' ||
    !UUID.test(options.platformStoreId)
  )
    throw fault('POSTGRES_ROLE_AUTHORITY_ARGUMENT');
  const storeId = options.platformStoreId,
    lockKey = roleLockKey(storeId);
  let state = 'idle',
    proof = null,
    watchdog = null,
    closing = null,
    working = false;
  function shutdown(nextState) {
    if (!TERMINAL.has(state)) state = nextState;
    proof = null;
    clearTimeout(watchdog);
    watchdog = null;
    if (closing) return closing;
    // Closing NEVER deletes a durable TTL row. Losing this session must not let
    // another owner start before the old application's confirmed deadline.
    try {
      client.connection?.stream?.destroy();
    } catch {}
    closing = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(fault('POSTGRES_ROLE_AUTHORITY_CLOSE_TIMEOUT')),
        CLOSE_MS,
      );
      timer.unref?.();
      Promise.resolve()
        .then(() => client.end())
        .then(
          () => finish(),
          () => finish(fault('POSTGRES_ROLE_AUTHORITY_UNAVAILABLE')),
        );
    });
    void closing.catch(() => {});
    return closing;
  }
  client.on?.('error', () => {
    void shutdown('unavailable').catch(() => {});
  });
  function alive() {
    return proof && !TERMINAL.has(state) && performance.now() < proof.deadline;
  }
  function requireAlive() {
    if (!alive()) throw fault('POSTGRES_ROLE_AUTHORITY_LOST');
  }
  function arm() {
    clearTimeout(watchdog);
    if (!proof || TERMINAL.has(state)) return;
    watchdog = setTimeout(
      () => {
        if (!proof || TERMINAL.has(state)) return;
        if (performance.now() < proof.deadline) return arm();
        void shutdown('expired').catch(() => {});
      },
      Math.max(1, Math.ceil(proof.deadline - performance.now())),
    );
    watchdog.unref?.();
  }
  async function transaction(work) {
    let opened = false,
      committing = false;
    try {
      requireAlive();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      opened = true;
      requireAlive();
      await client.query(
        "SELECT set_config('cartoteca.kind','platform',true),set_config('cartoteca.store_id',$1,true)",
        [storeId],
      );
      requireAlive();
      const locked = (
        await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [lockKey])
      ).rows?.[0]?.locked;
      requireAlive();
      if (locked !== true) {
        // No lease SELECT/DML has run. Only confirmed ROLLBACK proves unchanged;
        // this is deliberately NOT labelled retryableBeforeBegin.
        await client.query('ROLLBACK');
        opened = false;
        requireAlive();
        const error = fault('POSTGRES_ROLE_AUTHORITY_BUSY', {
          leaseUnchanged: true,
          transactionOpen: false,
          outcomeUnknown: false,
          channelPoisoned: false,
        });
        error[CLEAN_BUSY] = true;
        throw error;
      }
      const result = await work();
      requireAlive();
      committing = true;
      await client.query('COMMIT');
      opened = false;
      committing = false;
      requireAlive();
      return result;
    } catch (error) {
      if (error?.[CLEAN_BUSY] === true) throw error;
      let rollbackFailed = false;
      if (opened) {
        try {
          await client.query('ROLLBACK');
        } catch {
          rollbackFailed = true;
        }
      }
      const code = CODES.has(error?.code) ? error.code : 'POSTGRES_ROLE_AUTHORITY_QUERY_FAILED';
      const expired = proof && performance.now() >= proof.deadline;
      await shutdown(expired ? 'expired' : 'unavailable').catch(() => {});
      throw fault(code, {
        transactionOpen: false,
        channelPoisoned: true,
        outcomeUnknown: committing || rollbackFailed,
      });
    }
  }
  const parameters = (current) => [storeId, current.owner, current.role, current.hash];
  async function matches(current) {
    const row = (
      await client.query(`SELECT 1 AS present FROM ${TABLE} WHERE ${LIVE}`, parameters(current))
    ).rows?.[0];
    return row?.present === 1;
  }
  async function acquire({ role, owner }) {
    if (state === 'held') {
      if (proof?.role !== role || proof.owner !== owner)
        throw fault('POSTGRES_ROLE_AUTHORITY_CONFLICT');
      const current = proof;
      const found = await transaction(() => matches(current));
      if (!found || proof !== current) throw fault('POSTGRES_ROLE_AUTHORITY_LOST');
      return current.token; // No UPDATE, lock reference growth or TTL extension.
    }
    if (state !== 'idle') throw fault('POSTGRES_ROLE_AUTHORITY_UNAVAILABLE');
    state = 'acquiring';
    const current = { role, owner, token: randomUUID(), deadline: performance.now() + LEASE_MS };
    current.hash = tokenHash(current.token);
    proof = current;
    arm();
    await transaction(async () => {
      await client.query(
        `DELETE FROM ${TABLE} WHERE platform_store_id=$1 AND expires_at<=clock_timestamp()`,
        [storeId],
      );
      const rows = (
        await client.query(
          `SELECT owner,role FROM ${TABLE} WHERE platform_store_id=$1 AND expires_at>clock_timestamp() LIMIT 65`,
          [storeId],
        )
      ).rows;
      requireAlive();
      if (!Array.isArray(rows)) throw fault('POSTGRES_ROLE_AUTHORITY_QUERY_FAILED');
      if (
        rows.some(
          (row) => row.owner === owner || role === 'background' || row.role === 'background',
        )
      )
        throw fault('POSTGRES_ROLE_AUTHORITY_CONFLICT');
      if (rows.length >= MAX_OWNERS) throw fault('POSTGRES_ROLE_AUTHORITY_CAPACITY');
      const inserted = await client.query(
        `INSERT INTO ${TABLE}(platform_store_id,owner,role,token_hash,expires_at)
          VALUES($1,$2,$3,$4::bytea,clock_timestamp()+INTERVAL '60 seconds') RETURNING 1 AS inserted`,
        parameters(current),
      );
      if (inserted.rows?.[0]?.inserted !== 1) throw fault('POSTGRES_ROLE_AUTHORITY_QUERY_FAILED');
    });
    if (proof !== current || !alive()) throw fault('POSTGRES_ROLE_AUTHORITY_LOST');
    state = 'held';
    return current.token;
  }
  async function renew({ owner, token }) {
    if (state !== 'held' || proof?.owner !== owner || proof.token !== token) return false;
    if (!alive()) {
      await shutdown('expired');
      return false;
    }
    const current = proof,
      started = performance.now();
    const changed = await transaction(
      async () =>
        (
          await client.query(
            `UPDATE ${TABLE} SET expires_at=clock_timestamp()+INTERVAL '60 seconds'
        WHERE ${LIVE} RETURNING 1 AS renewed`,
            parameters(current),
          )
        ).rows?.[0]?.renewed === 1,
    );
    if (!changed || proof !== current) {
      await shutdown('unavailable');
      return false;
    }
    current.deadline = started + LEASE_MS;
    arm();
    return true;
  }
  async function release({ owner, token }) {
    if (state !== 'held' || proof?.owner !== owner || proof.token !== token) return false;
    if (!alive()) {
      await shutdown('expired');
      return false;
    }
    const current = proof;
    const changed = await transaction(
      async () =>
        (
          await client.query(
            `DELETE FROM ${TABLE} WHERE ${LIVE} RETURNING 1 AS released`,
            parameters(current),
          )
        ).rows?.[0]?.released === 1,
    );
    await shutdown(changed ? 'released' : 'unavailable');
    return changed;
  }
  return {
    durationMs: LEASE_MS,
    async dispatch(input) {
      let ownsTurn = false;
      try {
        const command = commandOf(input);
        if (working) throw fault('POSTGRES_ROLE_AUTHORITY_BUSY');
        working = true;
        ownsTurn = true;
        if (command.op === 'acquire') return await acquire(command);
        if (command.op === 'renew') return await renew(command);
        return await release(command);
      } catch (error) {
        if (error?.[CLEAN_BUSY] === true) {
          if (state === 'acquiring') {
            state = 'idle';
            proof = null;
            clearTimeout(watchdog);
            watchdog = null;
          }
          throw error;
        }
        const expired = state === 'expired' || (proof && performance.now() >= proof.deadline);
        await shutdown(expired ? 'expired' : 'unavailable').catch(() => {});
        if (
          expired &&
          ['renew', 'release'].includes(input?.op) &&
          error?.code !== 'POSTGRES_ROLE_AUTHORITY_ARGUMENT' &&
          error?.outcomeUnknown !== true
        )
          return false;
        throw fault(CODES.has(error?.code) ? error.code : 'POSTGRES_ROLE_AUTHORITY_QUERY_FAILED', {
          transactionOpen: false,
          channelPoisoned: true,
          outcomeUnknown: error?.outcomeUnknown === true,
        });
      } finally {
        if (ownsTurn) working = false;
      }
    },
    close: () => shutdown('closed'),
    status() {
      if (proof && performance.now() >= proof.deadline) void shutdown('expired').catch(() => {});
      return Object.freeze({
        state,
        held: state === 'held' && Boolean(alive()),
        durationMs: LEASE_MS,
        remainingMs: proof ? Math.max(0, Math.floor(proof.deadline - performance.now())) : 0,
      });
    },
  };
}
module.exports = { createProcessRoleAuthority, roleLockKey, LEASE_MS };
