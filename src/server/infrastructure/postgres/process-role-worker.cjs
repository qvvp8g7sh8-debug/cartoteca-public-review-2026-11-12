'use strict';
const { Int32Array, Atomics, ArrayBuffer } = globalThis;
const { parentPort, workerData } = require('node:worker_threads');
const v8 = require('node:v8');
const memorySampling = require('../native-memory-observation.cjs').startMemorySampling(
  workerData.memoryProcess,
  workerData.memoryMailbox,
);
const { Client } = require('pg');
const { createProcessRoleAuthority } = require('./process-role-authority.cjs');
const { validateRoleLeaseSchema } = require('./process-role-schema.cjs');

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const CODES = new Set([
  'POSTGRES_ROLE_AUTHORITY_ARGUMENT',
  'POSTGRES_ROLE_AUTHORITY_UNAVAILABLE',
  'POSTGRES_ROLE_AUTHORITY_BUSY',
  'POSTGRES_ROLE_AUTHORITY_CONFLICT',
  'POSTGRES_ROLE_AUTHORITY_CAPACITY',
  'POSTGRES_ROLE_AUTHORITY_LOST',
  'POSTGRES_ROLE_AUTHORITY_QUERY_FAILED',
  'POSTGRES_ROLE_AUTHORITY_CLOSE_TIMEOUT',
  'POSTGRES_ROLE_LINEAGE_MISMATCH',
  'POSTGRES_ROLE_SCHEMA_INVALID',
  'POSTGRES_ROLE_CHANNEL_PROTOCOL',
]);
const state = new Int32Array(workerData.mailbox, 0, 4);
const inline = new Uint8Array(workerData.mailbox, 16);
const profile = workerData.roleProfile;
const timeout = Math.max(1, Math.min(4500, workerData.statementTimeoutMs || 4500));
const client = new Client({
  ...workerData.connection,
  connectionTimeoutMillis: timeout,
  query_timeout: timeout,
  statement_timeout: timeout,
  application_name: 'cartoteca-process-role-lease',
});
let authority,
  active = null,
  broken = false,
  closing;

function fault(code) {
  return Object.assign(Error('Process role authority unavailable.'), { code });
}
function validProfile(value) {
  return (
    value &&
    typeof value === 'object' &&
    Object.keys(value).sort().join(',') === 'markerHash,migrationId,platformStoreId' &&
    UUID.test(value.platformStoreId || '') &&
    UUID.test(value.migrationId || '') &&
    /^[a-f0-9]{64}$/.test(value.markerHash || '')
  );
}
function validCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.op === 'shutdown') return keys === 'op';
  if (value.op === 'acquire')
    return (
      keys === 'op,owner,role' &&
      ['combined', 'background'].includes(value.role) &&
      UUID.test(value.owner || '')
    );
  return (
    ['renew', 'release'].includes(value.op) &&
    keys === 'op,owner,token' &&
    UUID.test(value.owner || '') &&
    UUID.test(value.token || '')
  );
}
function publish(id, reply) {
  if (!active || active.id !== id || active.finished) return;
  let bytes = v8.serialize({ id, ...reply });
  if (bytes.byteLength > workerData.maxReplyBytes) {
    broken = true;
    bytes = v8.serialize({
      id,
      ok: false,
      error: {
        code: 'POSTGRES_ROLE_CHANNEL_PROTOCOL',
        channelPoisoned: true,
        outcomeUnknown: active.mutating,
        transactionOpen: false,
      },
    });
  }
  active.finished = true;
  Atomics.store(state, 2, id);
  Atomics.store(state, 1, bytes.byteLength);
  if (bytes.byteLength <= inline.length) {
    inline.set(bytes);
    Atomics.store(state, 0, 1);
  } else {
    const owned = Uint8Array.from(bytes);
    workerData.replyPort.postMessage({ id, bytes: owned.buffer }, [owned.buffer]);
    Atomics.store(state, 0, 2);
  }
  memorySampling?.publish();
  Atomics.notify(state, 0);
}
function close() {
  if (!closing)
    closing = (async () => {
      if (authority) await authority.close();
      else await client.end();
    })();
  return closing;
}
function errorShape(error, mutating) {
  const code = CODES.has(error?.code) ? error.code : 'POSTGRES_ROLE_AUTHORITY_QUERY_FAILED';
  const cleanBusy =
    code === 'POSTGRES_ROLE_AUTHORITY_BUSY' &&
    error?.leaseUnchanged === true &&
    error.transactionOpen === false &&
    error.outcomeUnknown === false &&
    error.channelPoisoned === false;
  if (cleanBusy)
    return {
      code,
      leaseUnchanged: true,
      transactionOpen: false,
      outcomeUnknown: false,
      channelPoisoned: false,
    };
  const definite = [
    'POSTGRES_ROLE_AUTHORITY_ARGUMENT',
    'POSTGRES_ROLE_AUTHORITY_CONFLICT',
    'POSTGRES_ROLE_AUTHORITY_CAPACITY',
  ].includes(code);
  return {
    code,
    channelPoisoned: broken || !definite,
    outcomeUnknown: mutating && !definite,
    transactionOpen: false,
  };
}
client.on('error', () => {
  broken = true;
  if (active && !active.finished)
    publish(active.id, { ok: false, error: errorShape(null, active.mutating) });
  void close().catch(() => {});
  parentPort.postMessage({ type: 'fatal', code: 'POSTGRES_ROLE_AUTHORITY_QUERY_FAILED' });
});
parentPort.on('message', async (message) => {
  if (message?.close === true) {
    try {
      await close();
    } catch {}
    workerData.replyPort.close();
    parentPort.close();
    return;
  }
  if (active && !active.finished) return;
  if (
    !(message?.bytes instanceof ArrayBuffer) ||
    message.bytes.byteLength > workerData.maxCommandBytes ||
    !Number.isSafeInteger(message.id) ||
    message.id <= 0
  )
    return;
  active = { id: message.id, finished: false, mutating: false };
  try {
    const command = v8.deserialize(Buffer.from(message.bytes));
    if (!validCommand(command)) {
      broken = true;
      throw fault('POSTGRES_ROLE_CHANNEL_PROTOCOL');
    }
    active.mutating = command.op !== 'shutdown';
    if (broken) throw fault('POSTGRES_ROLE_AUTHORITY_UNAVAILABLE');
    if (command.op === 'shutdown') {
      await close();
      publish(message.id, { ok: true, value: null });
      workerData.replyPort.close();
      parentPort.close();
      return;
    }
    const value = await authority.dispatch(command);
    if (command.op === 'acquire' ? !UUID.test(value || '') : typeof value !== 'boolean') {
      broken = true;
      throw fault('POSTGRES_ROLE_CHANNEL_PROTOCOL');
    }
    publish(message.id, { ok: true, value });
  } catch (error) {
    const shape = errorShape(error, active?.mutating === true);
    if (shape.channelPoisoned) {
      broken = true;
      try {
        await close();
      } catch {}
    }
    publish(message.id, { ok: false, error: shape });
  }
});
(async () => {
  try {
    if (!validProfile(profile)) throw fault('POSTGRES_ROLE_LINEAGE_MISMATCH');
    await client.connect();
    const role = (
      await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    ).rows;
    if (role.length !== 1 || role[0].rolsuper !== false || role[0].rolbypassrls !== false)
      throw fault('POSTGRES_ROLE_LINEAGE_MISMATCH');
    // Exact trusted lineage tuple; a wire command cannot choose another store.
    await client.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [profile.platformStoreId],
    );
    const rows = (
      await client.query(
        "SELECT migration_id,marker_hash FROM cartoteca_catalog.asset_profiles WHERE kind='platform' AND store_id=$1",
        [profile.platformStoreId],
      )
    ).rows;
    if (
      rows.length !== 1 ||
      rows[0].migration_id !== profile.migrationId ||
      rows[0].marker_hash !== profile.markerHash
    )
      throw fault('POSTGRES_ROLE_LINEAGE_MISMATCH');
    await validateRoleLeaseSchema(client, client.user);
    authority = await createProcessRoleAuthority(client, {
      platformStoreId: profile.platformStoreId,
      lineageVerified: true,
    });
    parentPort.postMessage({ type: 'ready' });
  } catch (error) {
    broken = true;
    try {
      await close();
    } catch {}
    parentPort.postMessage({
      type: 'fatal',
      code: CODES.has(error?.code) ? error.code : 'POSTGRES_ROLE_AUTHORITY_QUERY_FAILED',
    });
    workerData.replyPort.close();
    parentPort.close();
    process.exitCode = 1;
  }
})();
