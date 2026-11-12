'use strict';
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function failure(code = 'POSTGRES_ROLE_AUTHORITY_ARGUMENT') {
  return Object.assign(Error('Фоновая аренда процесса недоступна.'), { code, status: 503 });
}
async function createProcessRoleChannel({
  connection,
  marker,
  createTransport,
  nativeMemoryProcess,
} = {}) {
  if (
    !connection ||
    typeof connection !== 'object' ||
    marker?.version !== 1 ||
    marker.backend !== 'postgres' ||
    !UUID.test(marker.platformStoreId || '') ||
    !UUID.test(marker.migrationId || '')
  )
    throw failure();
  const roleProfile = Object.freeze({
    platformStoreId: marker.platformStoreId,
    migrationId: marker.migrationId,
    markerHash: require('./catalog-sqlite.cjs').digest(marker),
  });
  const transport = (createTransport || require('./transport.cjs').createTransport)({
    connection,
    roleProfile,
    ...(nativeMemoryProcess ? { nativeMemoryProcess } : {}),
    filename: path.join(__dirname, 'process-role-worker.cjs'),
    timeoutMs: 5000,
    startupMs: 15000,
    maxCommandBytes: 8192,
    maxReplyBytes: 16384,
    inlineBytes: 1024,
    resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
  });
  try {
    await transport.ready();
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
  let closed = false,
    lost = false,
    currentOwner = null,
    currentToken = null,
    confirmedUntil = 0;
  const healthy = () => {
    const value = transport.stats();
    return !closed && value.ready === true && !value.poisoned && !value.exited;
  };
  const isCurrent = () =>
    !lost && currentToken !== null && healthy() && performance.now() < confirmedUntil;
  const lose = () => {
    lost = true;
    confirmedUntil = 0;
  };
  const valid = (value) => {
    if (!UUID.test(value || '')) throw failure();
  };
  const cleanBusy = (error) =>
    error?.code === 'POSTGRES_ROLE_AUTHORITY_BUSY' &&
    error.leaseUnchanged === true &&
    error.transactionOpen === false &&
    error.outcomeUnknown === false &&
    error.channelPoisoned === false;
  const call = (command) => {
    if (closed || lost) throw failure('POSTGRES_ROLE_AUTHORITY_UNAVAILABLE');
    try {
      return transport.request(command, { mutating: true });
    } catch (error) {
      if (!cleanBusy(error)) lose();
      throw error;
    }
  };
  return Object.freeze({
    durationMs: 60000,
    isCurrent,
    acquire(role, owner) {
      if (!['combined', 'background'].includes(role)) throw failure();
      valid(owner);
      if (currentToken && !isCurrent()) {
        lose();
        throw failure('POSTGRES_ROLE_AUTHORITY_LOST');
      }
      const started = performance.now(),
        value = call({ op: 'acquire', role, owner });
      if (!UUID.test(value || '')) {
        lose();
        throw failure('POSTGRES_ROLE_CHANNEL_PROTOCOL');
      }
      if (currentToken) {
        if (currentOwner !== owner || value !== currentToken || !isCurrent()) {
          lose();
          throw failure('POSTGRES_ROLE_AUTHORITY_LOST');
        }
        return value;
      }
      if (!healthy() || performance.now() >= started + 60000) {
        lose();
        throw failure('POSTGRES_ROLE_AUTHORITY_LOST');
      }
      currentOwner = owner;
      currentToken = value;
      confirmedUntil = started + 60000;
      return value;
    },
    renew(owner, token) {
      valid(owner);
      valid(token);
      if (currentOwner !== owner || currentToken !== token) return false;
      if (!isCurrent()) {
        lose();
        return false;
      }
      const started = performance.now(),
        oldDeadline = confirmedUntil;
      const renewed = call({ op: 'renew', owner, token });
      if (renewed !== true || !healthy() || performance.now() >= oldDeadline) {
        lose();
        return false;
      }
      confirmedUntil = started + 60000;
      return true;
    },
    release(owner, token) {
      valid(owner);
      valid(token);
      if (currentOwner !== owner || currentToken !== token) return false;
      if (!isCurrent()) {
        lose();
        return false;
      }
      const released = call({ op: 'release', owner, token });
      lose();
      return released === true;
    },
    closeSync() {
      if (closed) return;
      lose();
      try {
        transport.closeSync();
      } finally {
        closed = true;
      }
    },
    close() {
      lose();
      closed = true;
      return transport.close();
    },
    stats: () => ({
      ...transport.stats(),
      independent: true,
      scope: 'process-role',
      durationMs: 60000,
      current: isCurrent(),
      monotonicRemainingMs: isCurrent()
        ? Math.max(0, Math.floor(confirmedUntil - performance.now()))
        : 0,
    }),
  });
}
module.exports = { createProcessRoleChannel };
