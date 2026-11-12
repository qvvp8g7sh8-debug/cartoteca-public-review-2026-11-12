#!/usr/bin/env node
const { backupConfiguration } = require('../src/server/infrastructure/backup/agent-config.cjs');
const { runBackup } = require('../src/server/infrastructure/backup/agent.cjs');
const { createBackupJournal } = require('../src/server/infrastructure/backup/journal.cjs');
const { readBackupStatus } = require('../src/server/infrastructure/backup/status.cjs');
const {
  retentionPlan,
  applyRetention,
} = require('../src/server/infrastructure/backup/retention.cjs');
const { createS3Storage } = require('../src/server/infrastructure/backup/s3-storage.cjs');
const {
  localRetentionPlan,
  rotateLocalBackups,
} = require('../src/server/infrastructure/backup/local-retention.cjs');

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  if (
    !['run', 'status', 'retention-plan', 'prune', 'preflight', 'check'].includes(command) ||
    flags.some((flag) => !['--scheduled', '--apply'].includes(flag)) ||
    (flags.includes('--apply') && command !== 'prune') ||
    (flags.includes('--scheduled') && command !== 'run')
  )
    throw Error('BACKUP_COMMAND');
  const nativeStatus =
    ['status', 'check'].includes(command) &&
    (process.env.CARTOTECA_STORAGE_BACKEND === 'postgres' ||
      (process.env.CARTOTECA_DATA_DIR &&
        require('node:fs').existsSync(
          require('node:path').join(process.env.CARTOTECA_DATA_DIR, 'postgresql-runtime.json'),
        )))
      ? require('../src/server/infrastructure/backup/agent-config.cjs').backupStatusConfiguration()
      : null;
  if (['preflight', 'check'].includes(command)) {
    const {
      backupPreflightAsync,
      monitorBackup,
      monitorBackupForProfile,
    } = require('../src/server/infrastructure/backup/operations.cjs');
    const result =
      command === 'preflight'
        ? await backupPreflightAsync()
        : nativeStatus
          ? await monitorBackupForProfile(process.env.BACKUP_STATUS_FILE, nativeStatus)
          : monitorBackup(process.env.BACKUP_STATUS_FILE);
    process.exitCode = result.exitCode;
    return result;
  }
  if (command === 'status' && nativeStatus) {
    const result =
      await require('../src/server/infrastructure/backup/operations.cjs').readBackupStatusForProfile(
        nativeStatus.statusFile,
        nativeStatus,
      );
    if (result.health === 'unavailable') process.exitCode = 2;
    return result;
  }
  const config = backupConfiguration();
  if (command === 'status') return readBackupStatus(config.statusFile, config);
  if (command === 'run')
    return runBackup(config, {
      slot: flags.includes('--scheduled') ? 'daily:' + new Date().toISOString().slice(0, 10) : null,
    });
  const journal = createBackupJournal(config.stateDirectory);
  let claimed = false;
  try {
    if (command === 'prune') {
      if (!flags.includes('--apply')) throw Error('BACKUP_EXPLICIT_APPLY_REQUIRED');
      journal.begin(config.destinationId);
      claimed = true;
    }
    const rows = journal.rows(config.destinationId);
    if (command === 'retention-plan')
      return {
        candidates: (config.remote ? retentionPlan : localRetentionPlan)(config, rows).map(
          (row) => row.id,
        ),
        deleted: false,
      };
    const remote = config.remote && createS3Storage(config.remote);
    const removed = remote
      ? await applyRetention(config, rows, remote, { leaseCheck: journal.heartbeat })
      : await rotateLocalBackups(config, rows, { leaseCheck: journal.heartbeat });
    journal.update('local_only', { maintenance: 'prune', removed: removed.length }, true);
    claimed = false;
    return { removed: removed.length, remoteDeletion: false };
  } finally {
    if (claimed) {
      try {
        journal.update('failed', { error: 'BACKUP_FAILED' }, true);
      } catch {
        /* Lease lost. */
      }
    }
    journal.close();
  }
}
// Independent hard deadline bounds the lease, including stalled disk/network work.
// An interrupted staging directory is NOT deleted by the next process.
const deadline = setTimeout(() => {
  process.stderr.write('BACKUP_DEADLINE\n');
  process.exit(1);
}, 1800000);
deadline.unref();
main()
  .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch((error) => {
    process.stderr.write(
      /^BACKUP_[A-Z_]+$/.test(error.message) ? error.message + '\n' : 'BACKUP_FAILED\n',
    );
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(deadline));
