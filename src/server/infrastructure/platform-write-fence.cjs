const path = require('node:path');
const { DatabaseSync, constants } = require('node:sqlite');
const { createAsyncWriteLock } = require('./async-write-lock.cjs');
const { Proxy, Reflect } = globalThis;

// Disposable coordination only: no tenant data and no TTL-based ownership.
// SQLite's rollback-journal file locks are released by the OS on process death.
// All processes of an offline-switched data directory must use this protocol.
function createPlatformWriteFence(raw, directory) {
  const gate = new DatabaseSync(path.join(directory, 'write-fence.sqlite'));
  gate.exec('PRAGMA busy_timeout=5000');
  if (gate.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete')
    throw Error('Write fence must use rollback journal locking');
  gate.exec('CREATE TABLE IF NOT EXISTS fence(version INTEGER NOT NULL)');
  const exec = raw.exec.bind(raw),
    prepare = raw.prepare.bind(raw),
    close = raw.close.bind(raw);
  let shared = false,
    exclusive = false,
    collecting = null,
    executing = 0;
  const reads = new Set([
    constants.SQLITE_SELECT,
    constants.SQLITE_READ,
    constants.SQLITE_FUNCTION,
    constants.SQLITE_RECURSIVE,
  ]);
  const readPragmas = new Set([
    'table_info',
    'table_xinfo',
    'index_list',
    'index_info',
    'index_xinfo',
    'foreign_key_list',
    'foreign_key_check',
    'integrity_check',
    'quick_check',
  ]);
  raw.setAuthorizer((action, first, second) => {
    const pragmaRead =
      action === constants.SQLITE_PRAGMA &&
      (readPragmas.has(first) ||
        ([
          'busy_timeout',
          'user_version',
          'schema_version',
          'data_version',
          'query_only',
          'synchronous',
          'foreign_keys',
          'journal_mode',
        ].includes(first) &&
          second === null));
    // Some PRAGMAs execute at preparation, not step. Only exec (already fenced)
    // may prepare a setting; never allow a cached statement to bypass the fence.
    if (collecting && action === constants.SQLITE_PRAGMA && !pragmaRead && !exclusive)
      return constants.SQLITE_DENY;
    if (collecting && !reads.has(action) && !pragmaRead) collecting.writes = true;
    return constants.SQLITE_OK;
  });
  function release() {
    if (exclusive && !raw.isTransaction && executing === 0) {
      gate.exec('ROLLBACK');
      exclusive = false;
    }
  }
  function enter() {
    if (shared) throw Error('Platform write attempted inside shared cabinet commit');
    if (exclusive) return;
    gate.exec('PRAGMA busy_timeout=' + prepare('PRAGMA busy_timeout').get().timeout);
    gate.exec('BEGIN EXCLUSIVE');
    exclusive = true;
  }
  function run(writes, operation) {
    if (writes) enter();
    executing++;
    try {
      return operation();
    } finally {
      executing--;
      release();
    }
  }
  function statement(sql) {
    const classification = { writes: false };
    collecting = classification;
    let result;
    try {
      result = prepare(sql);
    } finally {
      collecting = null;
    }
    return new Proxy(result, {
      get(target, key) {
        if (['run', 'get', 'all'].includes(key))
          return (...args) => run(classification.writes, () => target[key](...args));
        if (key === 'iterate')
          return function* (...args) {
            if (classification.writes) enter();
            executing++;
            try {
              yield* target.iterate(...args);
            } finally {
              executing--;
              release();
            }
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const writer = createAsyncWriteLock(gate, {
    acquire: () => {
      gate.exec('BEGIN DEFERRED');
      try {
        gate.prepare('SELECT version FROM fence LIMIT 1').get();
      } catch (error) {
        gate.exec('ROLLBACK');
        throw error;
      }
    },
  });
  const db = new Proxy(raw, {
    get(target, key) {
      if (key === 'prepare') return statement;
      if (key === 'exec')
        return (sql) => {
          const control =
            /^\s*(?:BEGIN\s+DEFERRED|COMMIT|ROLLBACK|PRAGMA\s+busy_timeout\s*=\s*\d+)\s*;?\s*$/i.test(
              sql,
            );
          return run(!control, () => exec(sql));
        };
      if (key === 'close')
        return () => {
          writer.close();
          try {
            close();
          } finally {
            gate.close();
          }
        };
      // A new bypass-capable API must be deliberately covered before use.
      if (
        [
          'setAuthorizer',
          'createTagStore',
          'applyChangeset',
          'createSession',
          'enableLoadExtension',
          'loadExtension',
          'function',
          'aggregate',
          'deserialize',
        ].includes(key)
      )
        return () => {
          throw Error('Unsupported API on coordinated platform connection: ' + key);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  async function readCommit(callback, options) {
    return writer.transaction(() => {
      if (raw.isTransaction || exclusive || shared) throw Error('Nested shared cabinet commit');
      shared = true;
      exec('PRAGMA query_only=ON');
      try {
        exec('BEGIN DEFERRED');
        const result = callback();
        if (result && typeof result.then === 'function')
          throw Error('Async shared commit callback');
        exec('COMMIT');
        return result;
      } catch (error) {
        if (raw.isTransaction) exec('ROLLBACK');
        throw error;
      } finally {
        exec('PRAGMA query_only=OFF');
        shared = false;
      }
    }, options);
  }
  return { db, readCommit, stats: writer.stats };
}
module.exports = { createPlatformWriteFence };
