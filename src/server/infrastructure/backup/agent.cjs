const fs = require('node:fs');
const { createV2Backup } = require('./service.cjs');
const { createBackupJournal } = require('./journal.cjs');
const { checkCapacityForBackend } = require('./capacity.cjs');
const { atomicJson } = require('./durable.cjs');
const { createS3Storage } = require('./s3-storage.cjs');
const { restoreDrill } = require('./drill.cjs');
const { retentionPlan } = require('./retention.cjs');
const { localRetentionPlan, rotateLocalBackups } = require('./local-retention.cjs');
const { cleanupBackupStages } = require('./staging.cjs');
const { fingerprints } = require('./s3-storage.cjs');
const { errors } = require('./status.cjs');

function publicStatus(config, rows, postgresProfile) {
  const latest = rows[0],
    existing = (row) => row.detail.file && fs.existsSync(row.detail.file);
  const local = rows.find((row) => row.detail.localAt && existing(row));
  const remote = rows.find((row) => row.detail.remoteAt);
  const drill = rows.find((row) => row.detail.drillAt);
  return {
    ...(config.storageBackend === 'postgres'
      ? {
          postgresProfile:
            postgresProfile || require('../postgres/backup-profile.cjs').backupProfile(config),
        }
      : {}),
    format: 1,
    observedAt: Date.now(),
    cadenceHours: config.cadenceHours,
    remoteConfigured: Boolean(config.remote),
    state: latest?.state || 'preparing',
    lastLocalAt: local?.detail.localAt || null,
    lastRemoteAt: remote?.detail.remoteAt || null,
    lastDrillAt: drill?.detail.drillAt || null,
    error: latest?.detail.error || null,
    maintenanceError: latest?.detail.maintenanceError || null,
    removedArchives: latest?.detail.removedArchives || 0,
    removedStages: latest?.detail.removedStages || 0,
    archiveBytes: latest?.detail.archiveBytes || null,
    durationMilliseconds: latest?.detail.durationMilliseconds || null,
    availableBytes: latest?.detail.availableBytes || null,
    recent: rows
      .slice(0, 10)
      .map((row) => ({ startedAt: row.started, finishedAt: row.finished, state: row.state })),
  };
}
async function runBackup(config, dependencies = {}) {
  let nativeProfile;
  if (config.storageBackend === 'postgres') {
    const verified = await (
      dependencies.verifyProfile ||
      require('../postgres/backup-profile.cjs').verifyCurrentBackupProfile
    )(config);
    const { backupProfile, sameProfile } = require('../postgres/backup-profile.cjs');
    if (!sameProfile(verified.profile, backupProfile(verified.config)))
      throw Error('BACKUP_CONFIGURATION');
    config = verified.config;
    nativeProfile = verified.profile;
  }
  const journal = createBackupJournal(config.stateDirectory, {
    leaseMilliseconds: config.leaseMilliseconds,
  });
  const remote =
    dependencies.remote === undefined
      ? config.remote && createS3Storage(config.remote)
      : dependencies.remote;
  let id, heartbeat, leaseError, started;
  const publish = () => {
    if (nativeProfile) {
      const { backupProfile, sameProfile } = require('../postgres/backup-profile.cjs');
      if (!sameProfile(backupProfile(config), nativeProfile)) throw Error('BACKUP_CONFIGURATION');
    }
    atomicJson(
      config.statusFile,
      publicStatus(config, journal.statusRows(config.destinationId), nativeProfile),
    );
  };
  const update = (state, detail, finish = false) => {
    if (leaseError) throw leaseError;
    journal.update(state, detail, finish);
    publish();
  };
  try {
    id = journal.begin(config.destinationId, dependencies.slot || null);
    if (!id) return { state: 'already_completed' };
    started = Date.now();
    publish();
    heartbeat = setInterval(() => {
      try {
        journal.heartbeat();
      } catch (error) {
        leaseError = error;
      }
    }, 10000);
    heartbeat.unref();
    let removedStages = 0;
    cleanupBackupStages(config, journal.rows(config.destinationId), {
      leaseCheck: journal.heartbeat,
      onRemoved: () => {
        removedStages++;
        update('preparing', { removedStages });
      },
    });
    const capacity = await (dependencies.capacity || checkCapacityForBackend)(config);
    update('copying', { availableBytes: capacity.availableBytes });
    const backup = await (dependencies.create || createV2Backup)({ ...config, backupJobId: id });
    if (!backup.verified) throw Error('BACKUP_FAILED');
    update('copying', {
      file: backup.file,
      localAt: Date.now(),
      archiveBytes: backup.archiveBytes,
      snapshotMilliseconds: backup.snapshotMilliseconds,
      localChecksum: backup.localChecksum || (await fingerprints(backup.file)),
      removedStages,
    });
    if (remote) {
      update('uploading');
      const receipt = await remote.upload(backup.file, id);
      update('uploading', { remote: receipt, remoteAt: Date.now() });
    }
    update('drilling');
    const drill = await (dependencies.drill || restoreDrill)(
      backup.file,
      config.keyFile,
      config.workDirectory,
      {
        backupJobId: id,
        destinationId: config.destinationId,
        connection: config.connection,
        applicationRole: config.applicationRole,
        ...(config.connectionOptions ? { connectionOptions: config.connectionOptions } : {}),
      },
    );
    const native = config.storageBackend === 'postgres';
    if (
      native &&
      (backup.backend !== 'postgres' ||
        drill?.backend !== 'postgres' ||
        drill.restored !== true ||
        drill.started !== true ||
        drill.notificationsPaused !== true)
    )
      throw Error('BACKUP_DRILL_FAILED');
    const nativeProof = native
      ? {
          backend: 'postgres',
          verified: true,
          drill: { backend: 'postgres', restored: true, started: true, notificationsPaused: true },
        }
      : null;
    const state = remote ? 'protected' : 'local_only';
    const finished = Date.now();
    update('drilling', { drillAt: finished, ...(native ? { nativeProof } : {}) });
    let removedArchives = 0,
      maintenanceError = null;
    if (!remote) {
      // Keep the lease through validation/deletion; the projected completed row
      // includes the freshly restored copy without releasing ownership early.
      const rows = journal
        .rows(config.destinationId)
        .map((row) => (row.id === id ? { ...row, state, finished } : row));
      try {
        await rotateLocalBackups(config, rows, {
          leaseCheck: journal.heartbeat,
          newestId: id,
          onRemoved: () => {
            removedArchives++;
            update('drilling', { removedArchives });
          },
        });
      } catch (error) {
        if (error.message === 'BACKUP_LEASE_LOST' || leaseError) throw error;
        // A verified new backup remains valid if housekeeping fails. Report the
        // failure separately instead of losing the completed recovery point.
        maintenanceError = 'BACKUP_MAINTENANCE_FAILED';
      }
    }
    update(
      state,
      {
        removedArchives,
        maintenanceError,
        durationMilliseconds: Date.now() - started,
      },
      true,
    );
    return {
      id,
      state,
      removedArchives,
      removedStages,
      maintenanceError,
      ...(native ? nativeProof : {}),
      retentionCandidates: (remote ? retentionPlan : localRetentionPlan)(
        config,
        journal.rows(config.destinationId),
      ).length,
    };
  } catch (error) {
    if (id) {
      const code = errors.includes(error.message) ? error.message : 'BACKUP_FAILED';
      try {
        update('failed', { error: code, durationMilliseconds: Date.now() - started }, true);
      } catch {
        /* Lost lease cannot publish. */
      }
    }
    throw Error(
      errors.includes(error.message) || error.message === 'BACKUP_BUSY'
        ? error.message
        : 'BACKUP_FAILED',
    );
  } finally {
    clearInterval(heartbeat);
    journal.close();
  }
}
module.exports = { runBackup, publicStatus };
