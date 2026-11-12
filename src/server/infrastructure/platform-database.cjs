const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { crypto, normalizeEmail } = require('./platform-constants.cjs');
const { encryptionKey } = require('./encryption-key.cjs');
const { configureSqlite } = require('./sqlite-configuration.cjs');
const { assertNoOrganizationSwitch } = require('./backup/organization-guard.cjs');
function createPlatformDatabase(
  dataDirectory,
  {
    notificationSchema = 11,
    sharedCabinetWrites = false,
    isolatedReadBudgets = false,
    databaseOwner = null,
  } = {},
) {
  const assets = require('./postgres/runtime.cjs');
  const rootDirectory = path.dirname(path.resolve(dataDirectory));
  assertNoOrganizationSwitch(rootDirectory);
  const postgres = databaseOwner?.dialect === 'postgres';
  if (!postgres) assets.rejectSqliteOnPostgresAssets(rootDirectory);
  if (![11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(notificationSchema))
    throw Error('Unsupported prepared notification schema.');
  if (
    !postgres &&
    notificationSchema > 11 &&
    (!fs.existsSync(path.join(dataDirectory, 'platform.sqlite')) ||
      !fs.existsSync(path.join(dataDirectory, 'platform.key')))
  )
    throw Error('Prepare the complete notification data copy before startup.');
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDirectory, 'platform.sqlite');
  if (!sharedCabinetWrites && fs.existsSync(path.join(dataDirectory, 'write-fence.sqlite')))
    throw Error('Coordinated directory requires all processes to enable shared cabinet writes');
  const keyFile = path.join(dataDirectory, 'platform.key');
  const pgDatabase = postgres
    ? assets.openRuntimeStore(databaseOwner, rootDirectory, dataDirectory, 'platform', {
        schemaVersion: notificationSchema,
      })
    : null;
  const key = (() => {
    try {
      return postgres
        ? assets.storeKey(dataDirectory, 'platform.key', pgDatabase)
        : encryptionKey(
            dataDirectory,
            filename,
            keyFile,
            'Platform encryption key is missing; restore the complete backup.',
          );
    } catch (error) {
      pgDatabase?.close();
      throw error;
    }
  })();
  // One key object per open database; keep the raw key contract for other modules.
  const cipherKey = crypto.createSecretKey(key);
  let db = pgDatabase || new DatabaseSync(filename, { timeout: 5000 });
  let fence;
  try {
    require('./booking-read-budget-store.cjs').assertMode(db, dataDirectory, isolatedReadBudgets, {
      databaseOwner,
    });
    if (!postgres) configureSqlite(db);
    if (!postgres) db.exec('PRAGMA foreign_keys=ON;');
    if (
      notificationSchema > 11 &&
      db.prepare('PRAGMA user_version').get().user_version !== notificationSchema
    )
      throw Error('Notification data copy has not been prepared to the requested schema.');
    fence =
      sharedCabinetWrites && !postgres
        ? require('./platform-write-fence.cjs').createPlatformWriteFence(db, dataDirectory)
        : null;
    if (fence) db = fence.db;
    require('../migrations/001-platform.cjs').migratePlatform(db, notificationSchema);
  } catch (error) {
    db.close();
    throw error;
  }

  function seal(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }
  function open(value) {
    value = Buffer.from(value);
    const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'),
    );
  }
  function transaction(callback, mode = 'IMMEDIATE', queueDomain = null) {
    if (!['IMMEDIATE', 'DEFERRED', ...(postgres ? ['QUEUE', 'READONLY'] : [])].includes(mode))
      throw Error('Invalid platform transaction mode');
    if (queueDomain !== null) {
      require('./postgres/queue-domains.cjs').assertQueueDomain(queueDomain);
      if (mode !== 'QUEUE') throw Error('Queue domain requires a queue transaction');
    }
    if (postgres && queueDomain && [2, 3].includes(db.revisionProfile)) db.beginQueue(queueDomain);
    else db.exec('BEGIN ' + mode);
    try {
      const result = callback();
      if (result && typeof result.then === 'function')
        throw Error('Asynchronous platform transaction is not allowed');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  let auditObserver = null;
  function audit(event, actorId = null, organizationId = null, detail = {}) {
    const inserted = db
      .prepare(
        'INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,?,?)',
      )
      .run(Date.now(), actorId, organizationId, event, JSON.stringify(detail));
    auditObserver?.(event, actorId, organizationId, detail);
    return Number(inserted.lastInsertRowid);
  }
  const emailHash = (email) =>
    crypto.createHmac('sha256', cipherKey).update(normalizeEmail(email)).digest('hex');
  const limitKey = (scope, value) =>
    `${scope}:${crypto
      .createHmac('sha256', cipherKey)
      .update(String(value || 'unknown'))
      .digest('hex')}`;
  const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const id = () => crypto.randomUUID();
  const { createAsyncWriteLock } = require('./async-write-lock.cjs');
  // One bounded FIFO owns both writer intents. Classification cannot bypass the
  // worker's closed QUEUE target validation or increase pending-body capacity.
  const writer = createAsyncWriteLock(db, {
    acquire: (options) => {
      if (postgres && options.intent === 'auth' && db.revisionProfile === 3)
        db.beginAuth(options.authScope);
      else if (postgres && options.intent === 'organization-queue' && db.revisionProfile === 3)
        db.beginQueueOrganization(options.queueScope);
      else if (postgres && options.intent === 'entity-queue' && db.revisionProfile === 3)
        db.beginQueueEntity(options.queueScope);
      else if (postgres && options.intent === 'compound' && db.revisionProfile === 3)
        options.atomicStatements === true && db.beginAtomicCompound
          ? db.beginAtomicCompound(options.compoundScope)
          : db.beginCompound(options.compoundScope);
      else if (
        postgres &&
        options.intent === 'queue' &&
        options.queueDomain &&
        [2, 3].includes(db.revisionProfile)
      )
        db.beginQueue(options.queueDomain);
      else db.exec('BEGIN ' + (postgres && options.intent === 'queue' ? 'QUEUE' : 'IMMEDIATE'));
    },
  });
  const accountingWriter =
    postgres && db.revisionProfile === 3
      ? createAsyncWriteLock(db, {
          maxPending: 32,
          maxBytes: 512 * 1024,
          acquire: (options) => db.beginAccounting(options.accountingScope),
        })
      : null;
  function asyncAccountingTransaction(callback, input, options = {}) {
    if (!accountingWriter) return writer.transaction(callback, { ...options, intent: 'critical' });
    const capability = require('./postgres/assistant-accounting145.cjs').accountingScope(
      input,
      db.scope,
    );
    const { platformStoreId, ...scope } = capability;
    return accountingWriter.transaction(callback, {
      ...options,
      bytes: 16 * 1024,
      accountingScope: scope,
    });
  }
  function queueTransaction(callback, queueDomain = null) {
    if (queueDomain !== null)
      require('./postgres/queue-domains.cjs').assertQueueDomain(queueDomain);
    // A caller already under the stricter policy fence retains that fence.
    if (!db.isTransaction)
      return transaction(callback, postgres ? 'QUEUE' : 'IMMEDIATE', postgres ? queueDomain : null);
    const result = callback();
    if (result && typeof result.then === 'function')
      throw Error('Asynchronous platform transaction is not allowed');
    return result;
  }
  function compoundTransaction(callback, scope) {
    if (!postgres || db.revisionProfile !== 3) return transaction(callback);
    if (db.isTransaction) throw Error('Compound writer cannot nest inside a transaction');
    db.beginCompound(scope);
    try {
      const result = callback();
      if (result && typeof result.then === 'function')
        throw Error('Asynchronous compound transaction is not allowed');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  function asyncCompoundTransaction(callback, scope, options = {}) {
    if (!postgres || db.revisionProfile !== 3)
      return writer.transaction(callback, { ...options, intent: 'critical' });
    const validated = require('./postgres/compound-intent133.cjs').compoundScope(scope, db.scope);
    const admittedScope = Object.freeze({
      operation: validated.operation,
      organizationId: validated.organizationId,
      cabinetStoreId: validated.cabinetStoreId,
    });
    return writer.transaction(callback, {
      ...options,
      intent: 'compound',
      compoundScope: admittedScope,
    });
  }
  const scopedQueues = postgres && db.revisionProfile === 3;
  function admittedQueueScope(scope, entity) {
    const helper = require('./postgres/scoped-queue134.cjs');
    const normalized = (entity ? helper.entityQueueScope : helper.organizationQueueScope)(
      scope,
      db.scope,
    );
    return Object.freeze(
      entity
        ? {
            domain: normalized.domain,
            kind: normalized.kind,
            key: normalized.key,
            ...(normalized.kind === 'event' ? { botHash: normalized.botHash } : {}),
          }
        : { queueDomain: normalized.queueDomain, organizationId: normalized.organizationId },
    );
  }
  function scopedCallbackFailure(error) {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
    if (!Object.isExtensible(error))
      error = Object.assign(new Error(error.message, { cause: error }), error);
    error.retryableBeforeBegin = false;
    error.scopedQueueCallbackStarted = true;
    return error;
  }
  function runScopedCallback(callback) {
    try {
      const result = callback();
      if (result && typeof result.then === 'function')
        throw Error('Asynchronous queue transaction is not allowed');
      return result;
    } catch (error) {
      throw scopedCallbackFailure(error);
    }
  }
  function scopedQueueTransaction(callback, scope, entity) {
    const capability = admittedQueueScope(scope, entity);
    if (db.isTransaction) {
      const held = db.scopedQueue;
      if (held) {
        const expected = admittedQueueScope(
          held.type === 'entity'
            ? {
                domain: held.domain,
                kind: held.kind,
                key: held.key,
                ...(held.kind === 'event' ? { botHash: held.botHash } : {}),
              }
            : { queueDomain: held.queueDomain, organizationId: held.organizationId },
          held.type === 'entity',
        );
        if (JSON.stringify(expected) !== JSON.stringify(capability))
          throw Error('Scoped queue cannot upgrade its capability');
      } else if (['QUEUE', 'READONLY', 'COMPOUND'].includes(db.transactionIntent))
        throw Error('Scoped queue cannot upgrade its transaction');
      return runScopedCallback(callback);
    }
    (entity ? db.beginQueueEntity : db.beginQueueOrganization)(capability);
    try {
      const result = runScopedCallback(callback);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      const failure = scopedCallbackFailure(error);
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch (rollbackError) {
          if (!failure?.outcomeUnknown && !failure?.channelPoisoned)
            throw scopedCallbackFailure(rollbackError);
        }
      }
      throw failure;
    }
  }
  function asyncScopedQueueTransaction(callback, scope, options, entity) {
    const queueScope = admittedQueueScope(scope, entity);
    let callbackStarted = false,
      callbackFailure = null;
    return writer
      .transaction(
        () => {
          callbackStarted = true;
          try {
            return runScopedCallback(callback);
          } catch (error) {
            callbackFailure = error;
            throw error;
          }
        },
        {
          ...options,
          intent: entity ? 'entity-queue' : 'organization-queue',
          queueScope,
        },
      )
      .catch((error) => {
        const failure =
          callbackFailure?.outcomeUnknown || callbackFailure?.channelPoisoned
            ? callbackFailure
            : error;
        throw callbackStarted ? scopedCallbackFailure(failure) : failure;
      });
  }
  const pgShared =
    postgres && sharedCabinetWrites
      ? createAsyncWriteLock(db, {
          acquire: () => (db.beginAtomicShared ? db.beginAtomicShared() : db.exec('BEGIN SHARED')),
        })
      : null;
  return {
    db,
    processRoles: databaseOwner?.processRoles || null,
    key,
    seal,
    open,
    emailHash,
    limitKey,
    tokenHash,
    id,
    transaction,
    organizationQueueTransaction: scopedQueues
      ? (callback, scope) => scopedQueueTransaction(callback, scope, false)
      : null,
    asyncOrganizationQueueTransaction: scopedQueues
      ? (callback, scope, options = {}) =>
          asyncScopedQueueTransaction(callback, scope, options, false)
      : null,
    entityQueueTransaction: scopedQueues
      ? (callback, scope) => scopedQueueTransaction(callback, scope, true)
      : null,
    asyncEntityQueueTransaction: scopedQueues
      ? (callback, scope, options = {}) =>
          asyncScopedQueueTransaction(callback, scope, options, true)
      : null,
    compoundTransaction,
    asyncCompoundTransaction,
    asyncAuthTransaction: scopedQueues
      ? (callback, input, options = {}) => {
          const capability = require('./postgres/auth-intent137.cjs').authScope(input, db.scope);
          const auth = Object.freeze({
            accountId: capability.accountId,
            organizationId: capability.organizationId,
            emailHash: capability.emailHash,
            clientKey: capability.clientKey,
          });
          let started = false;
          return writer
            .transaction(
              () => {
                started = true;
                return callback();
              },
              { ...options, intent: 'auth', authScope: auth },
            )
            .catch((error) => {
              if (started && error && Object.isExtensible(error)) {
                error.retryableBeforeBegin = false;
                error.authCallbackStarted = true;
              }
              throw error;
            });
        }
      : null,
    asyncAccountingTransaction,
    accountingQueueStats: accountingWriter?.stats || null,
    asyncTransaction: (callback, options = {}) =>
      writer.transaction(callback, { ...options, intent: 'critical' }),
    queueTransaction,
    asyncQueueTransaction: (callback, options = {}) => {
      if (options.queueDomain != null)
        require('./postgres/queue-domains.cjs').assertQueueDomain(options.queueDomain);
      return writer.transaction(callback, { ...options, intent: 'queue' });
    },
    sharedCabinetCommit: pgShared ? pgShared.transaction : fence?.readCommit,
    sharedCabinetStats: pgShared ? pgShared.stats : fence?.stats,
    writeQueueStats: writer.stats,
    closeWriter: () => {
      writer.close();
      accountingWriter?.close();
      pgShared?.close();
    },
    readSnapshot: (callback) => transaction(callback, 'DEFERRED'),
    readOnlySnapshot: (callback) => transaction(callback, postgres ? 'READONLY' : 'DEFERRED'),
    audit,
    setAuditObserver: (observer) => {
      auditObserver = observer;
    },
  };
}
module.exports = { createPlatformDatabase };
