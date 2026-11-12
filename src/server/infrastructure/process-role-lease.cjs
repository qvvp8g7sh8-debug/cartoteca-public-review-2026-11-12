const { randomUUID } = require('node:crypto');
const { fail } = require('../../shared/errors.cjs');

const KEY = 'application-process-roles';
const LEASE_MS = 60000;

// This encrypted runtime row is ephemeral coordination, not a schema migration.
// New binaries coordinate with each other; older binaries do not know this registry.
function createProcessRoleLease({
  db,
  open,
  seal,
  transaction,
  queueTransaction = transaction,
  processRoles = null,
}) {
  if (db.dialect === 'postgres') {
    if (processRoles) return processRoles;
    return {
      acquire() {
        throw Object.assign(fail(503, 'PostgreSQL process role coordination was not prepared.'), {
          code: 'POSTGRES_ROLE_COORDINATION_REQUIRED',
        });
      },
      renew: () => false,
      release: () => false,
      isCurrent: () => false,
      durationMs: LEASE_MS,
    };
  }
  const select = db.prepare('SELECT value FROM telegram_runtime WHERE key=?');
  const put = db.prepare('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)');
  const remove = db.prepare('DELETE FROM telegram_runtime WHERE key=?');
  const read = () => {
    const row = select.get(KEY);
    const value = row ? open(row.value) : { owners: [] };
    if (!value || !Array.isArray(value.owners)) throw Error('Invalid process role registry.');
    return value.owners;
  };
  const write = (owners) => {
    if (owners.length) put.run(KEY, seal({ owners }));
    else remove.run(KEY);
  };
  function acquire(role, owner, now = Date.now()) {
    if (!['combined', 'background'].includes(role) || !/^[a-f0-9-]{36}$/.test(owner))
      throw Error('Invalid process role lease.');
    return queueTransaction(() => {
      const owners = read().filter((entry) => entry.until > now);
      if (
        owners.some(
          (entry) =>
            entry.owner !== owner && (role === 'background' || entry.role === 'background'),
        )
      )
        throw fail(503, 'Фоновый процесс уже занят. Используйте web отдельно от background.');
      const existing = owners.find((entry) => entry.owner === owner);
      if (existing && existing.role !== role) throw Error('Process role cannot change in place.');
      if (!existing && owners.length >= 64) throw fail(503, 'Превышено число фоновых процессов.');
      const token = existing?.token || randomUUID();
      write([
        ...owners.filter((entry) => entry.owner !== owner),
        { owner, role, token, until: now + LEASE_MS },
      ]);
      return token;
    });
  }
  function renew(owner, token, now = Date.now()) {
    return queueTransaction(() => {
      const owners = read().filter((entry) => entry.until > now);
      const current = owners.find((entry) => entry.owner === owner && entry.token === token);
      if (!current) return false;
      current.until = now + LEASE_MS;
      write(owners);
      return true;
    });
  }
  function release(owner, token) {
    return queueTransaction(() => {
      const owners = read();
      const next = owners.filter((entry) => entry.owner !== owner || entry.token !== token);
      if (next.length !== owners.length) write(next);
    });
  }
  return { acquire, renew, release, durationMs: LEASE_MS };
}

module.exports = { createProcessRoleLease };
