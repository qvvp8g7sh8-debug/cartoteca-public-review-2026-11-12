'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { readRuntime, validateRuntimeProfile } = require('./runtime.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const { verifyAssetProfile } = require('./catalog-postgres.cjs');
const { plainFile, safeTree } = require('../backup/snapshot.cjs');
const { syncFile, syncDirectory } = require('../backup/durable.cjs');
const {
  MARKER,
  acquireOfflinePreparation145,
  preparePostgresAssistantRows,
} = require('./assistant-prepare145.cjs');
const { preparePostgresCabinetRecords } = require('./cabinet-prepare145.cjs');
const { preparePostgresPatientHistory } = require('./history-prepare145.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function atomicJSON(filename, value, { exclusive = false } = {}) {
  const directory = path.dirname(filename);
  safeTree(directory);
  if (fs.existsSync(filename)) {
    plainFile(filename);
    if (exclusive) throw Error('Package145 output already exists');
  }
  const temporary = filename + '.next-' + randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  syncFile(temporary);
  fs.renameSync(temporary, filename);
  syncDirectory(directory);
}
async function registeredMarkerHash(client, runtime) {
  const result = await client.query(
    "SELECT migration_id,marker_hash FROM cartoteca_catalog.asset_profiles WHERE kind='platform' AND store_id=$1",
    [runtime.platformStoreId],
  );
  if (result.rows.length !== 1 || result.rows[0].migration_id !== runtime.migrationId)
    throw Error('Package145 registered lineage differs');
  return result.rows[0].marker_hash;
}
function resultFromJournal(journal, resumed) {
  return {
    format: 'package145-offline-result-v1',
    direction: journal.direction,
    completed: true,
    passed: true,
    sqlCommitConfirmed: true,
    resumedCommittedPublication: resumed,
    beforeRuntimeHash: journal.beforeHash,
    afterRuntimeHash: journal.afterHash,
    cabinet: journal.cabinet,
    assistant: journal.assistant,
    history: journal.history,
    businessSchema: journal.afterRuntime.notificationSchema,
    cabinetSchema: journal.afterRuntime.cabinetSchema,
    dataCopiesCreated: 0,
    currentDataInverse: journal.direction === 'inverse',
    offlineGateRemovedAfterVerification: true,
  };
}
// One explicit offline transition for both components. The durable guard spans
// SQL COMMIT and filesystem publication. No startup/HTTP path invokes this code.
async function preparePostgresPackage145({
  client,
  directory,
  applicationRole,
  rollback = false,
  resumeCommitted = false,
} = {}) {
  directory = path.resolve(directory);
  safeTree(directory);
  const gate = path.join(directory, '.restore-in-progress');
  if (rollback && resumeCommitted && fs.existsSync(gate))
    throw Error('Package145 inverse publication requires explicit current-state reconciliation');
  const runtimeFile = path.join(directory, 'postgresql-runtime.json');
  plainFile(runtimeFile);
  const direction = rollback ? 'inverse' : 'forward';
  const journalFile = path.join(directory, '.package145-' + direction + '.json');
  const receiptFile = path.join(directory, 'package145-' + direction + '-result.json');
  if (fs.existsSync(receiptFile)) throw Error('Package145 transition is already complete');
  if (!fs.existsSync(gate)) {
    if (!resumeCommitted)
      throw Error('Package145 requires the exact operator-owned offline marker');
    plainFile(journalFile);
    const bytes = fs.readFileSync(journalFile);
    if (bytes.length > 32 * 1024 * 1024)
      throw Error('Package145 journal exceeds its metadata bound');
    const completed = JSON.parse(bytes);
    if (
      completed.format !== 'package145-offline-v1' ||
      completed.phase !== 'files-verified' ||
      completed.direction !== direction ||
      completed.afterHash !== digest(completed.afterRuntime)
    )
      throw Error('Package145 completion journal is not verified');
    const current = readRuntime(directory);
    if (
      digest(current) !== completed.afterHash ||
      (await registeredMarkerHash(client, current)) !== completed.afterHash
    )
      throw Error('Package145 completed lineage differs');
    await verifyAssetProfile(client, current);
    const proof = resultFromJournal(completed, true);
    atomicJSON(receiptFile, proof, { exclusive: true });
    return proof;
  }
  plainFile(gate);
  if (fs.readFileSync(gate, 'utf8') !== MARKER)
    throw Error('Package145 requires the exact operator-owned offline marker');
  const offline = await acquireOfflinePreparation145({ client, directory });
  let transaction = false,
    journal,
    assistant;
  try {
    if (resumeCommitted) {
      plainFile(journalFile);
      const bytes = fs.readFileSync(journalFile);
      if (bytes.length > 32 * 1024 * 1024)
        throw Error('Package145 journal exceeds its metadata bound');
      journal = JSON.parse(bytes);
      if (
        journal.format !== 'package145-offline-v1' ||
        journal.direction !== direction ||
        !['sql-prepared', 'files-verified'].includes(journal.phase) ||
        journal.afterHash !== digest(journal.afterRuntime) ||
        journal.beforeHash !== digest(journal.beforeRuntime)
      )
        throw Error('Package145 journal binding is invalid');
      validateRuntimeProfile(journal.beforeRuntime);
      validateRuntimeProfile(journal.afterRuntime);
      const current = readRuntime(directory),
        currentHash = digest(current);
      if (
        ![journal.beforeHash, journal.afterHash].includes(currentHash) ||
        (await registeredMarkerHash(client, current)) !== journal.afterHash
      )
        throw Error('Package145 SQL COMMIT is not confirmed; do not replay component mutations');
      // The still-closed gate permits publication of the confirmed marker before
      // reconstructing only the already-committed assistant sentinel.
      atomicJSON(runtimeFile, journal.afterRuntime);
      await client.query('BEGIN');
      transaction = true;
      assistant = await preparePostgresAssistantRows({
        client,
        directory,
        applicationRole,
        transactionOwned: true,
      });
      if (assistant.proof.reconciledExisting !== true)
        throw Error('Package145 resume cannot import assistant state again');
      await client.query('ROLLBACK');
      transaction = false;
    } else {
      if (fs.existsSync(journalFile))
        throw Error('Package145 journal exists; reconcile the known outcome first');
      const beforeRuntime = readRuntime(directory),
        beforeBytes = fs.readFileSync(runtimeFile);
      await verifyAssetProfile(client, beforeRuntime);
      await client.query('BEGIN');
      transaction = true;
      let history;
      if (rollback)
        history = await preparePostgresPatientHistory({
          client,
          directory,
          applicationRole,
          runtime: beforeRuntime,
          rollback: true,
        });
      const cabinet = await preparePostgresCabinetRecords({
        client,
        directory,
        applicationRole,
        rollback,
        ...(history ? { runtime: history.runtime } : {}),
      });
      if (!rollback)
        history = await preparePostgresPatientHistory({
          client,
          directory,
          applicationRole,
          runtime: cabinet.runtime,
        });
      assistant = await preparePostgresAssistantRows({
        client,
        directory,
        applicationRole,
        rollback,
        transactionOwned: true,
      });
      const afterRuntime = rollback ? cabinet.runtime : history.runtime;
      validateRuntimeProfile(afterRuntime);
      const beforeHash = digest(beforeRuntime),
        afterHash = digest(afterRuntime);
      if (beforeHash === afterHash)
        throw Error('Package145 transition has no distinct target lineage');
      const changed = await client.query(
        "UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1 WHERE kind='platform' AND store_id=$2 AND migration_id=$3 AND marker_hash=$4",
        [afterHash, beforeRuntime.platformStoreId, beforeRuntime.migrationId, beforeHash],
      );
      if (changed.rowCount !== 1 || !fs.readFileSync(runtimeFile).equals(beforeBytes))
        throw Error('Package145 runtime lineage CAS failed');
      journal = {
        format: 'package145-offline-v1',
        direction,
        phase: 'sql-prepared',
        beforeHash,
        afterHash,
        beforeRuntimeBytesSha256: hash(beforeBytes),
        beforeRuntime,
        afterRuntime,
        cabinet: cabinet.proof,
        assistant: assistant.proof,
        history: history.proof,
        dataCopiesCreated: 0,
      };
      atomicJSON(journalFile, journal, { exclusive: true });
      try {
        await client.query('COMMIT');
        transaction = false;
      } catch (error) {
        transaction = false;
        error.outcomeUnknown = true;
        throw error;
      }
    }
    assistant.publishFile();
    atomicJSON(runtimeFile, journal.afterRuntime);
    await verifyAssetProfile(client, readRuntime(directory));
    journal = { ...journal, phase: 'files-verified' };
    atomicJSON(journalFile, journal);
    if (fs.readFileSync(gate, 'utf8') !== MARKER)
      throw Error('Package145 offline marker changed before release');
    fs.unlinkSync(gate);
    syncDirectory(directory);
    const proof = resultFromJournal(journal, resumeCommitted);
    atomicJSON(receiptFile, proof, { exclusive: true });
    return proof;
  } catch (error) {
    if (transaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        error.outcomeUnknown = true;
        error.channelPoisoned = true;
      }
    }
    throw error;
  } finally {
    await offline.release();
  }
}
module.exports = { preparePostgresPackage145, MARKER };
