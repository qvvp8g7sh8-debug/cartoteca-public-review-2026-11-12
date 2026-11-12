const fs = require('node:fs');
const path = require('node:path');
const { safeTree, plainFile } = require('./snapshot.cjs');
const states = [
  'preparing',
  'copying',
  'uploading',
  'drilling',
  'protected',
  'local_only',
  'failed',
  'interrupted',
];
const errors = [
  'BACKUP_FAILED',
  'BACKUP_DISK_SPACE',
  'BACKUP_REMOTE_FAILED',
  'BACKUP_REMOTE_RETENTION',
  'BACKUP_REMOTE_CHECKSUM',
  'BACKUP_DRILL_FAILED',
  'BACKUP_LEASE_LOST',
  'BACKUP_SOURCE_TOO_LARGE',
];
function sanitizeStatus(value) {
  if (!value || value.format !== 1) throw Error('BACKUP_STATUS_INVALID');
  const time = (value) =>
    Number.isSafeInteger(value) && value > 0 && value <= Date.now() + 60000 ? value : null;
  const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  return {
    configured: true,
    remoteConfigured: value.remoteConfigured === true,
    observedAt: time(value.observedAt),
    cadenceHours: value.cadenceHours === 24 ? 24 : null,
    lastLocalAt: time(value.lastLocalAt),
    lastRemoteAt: time(value.lastRemoteAt),
    lastDrillAt: time(value.lastDrillAt),
    state: states.includes(value.state) ? value.state : 'failed',
    error: errors.includes(value.error) ? value.error : null,
    maintenanceError:
      value.maintenanceError === 'BACKUP_MAINTENANCE_FAILED' ? value.maintenanceError : null,
    removedArchives: number(value.removedArchives),
    removedStages: number(value.removedStages),
    durationMilliseconds: number(value.durationMilliseconds),
    archiveBytes: number(value.archiveBytes),
    availableBytes: number(value.availableBytes),
    recent: (Array.isArray(value.recent) ? value.recent : []).slice(0, 10).map((item) => ({
      startedAt: time(item.startedAt),
      finishedAt: time(item.finishedAt),
      state: states.includes(item.state) ? item.state : 'failed',
    })),
  };
}
function readBackupStatus(file, expectedConfiguration) {
  if (!file) return { configured: false, health: 'unconfigured' };
  try {
    safeTree(path.dirname(file));
    plainFile(file);
    if (fs.statSync(file).size > 32768) throw Error('BACKUP_STATUS_INVALID');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      Object.hasOwn(raw, 'postgresProfile') ||
      expectedConfiguration?.storageBackend === 'postgres'
    ) {
      const { backupProfile, sameProfile } = require('../postgres/backup-profile.cjs');
      const expected = backupProfile(expectedConfiguration);
      if (!expected || !sameProfile(raw.postgresProfile, expected))
        throw Error('BACKUP_STATUS_INVALID');
    }
    const value = sanitizeStatus(raw);
    const fresh = (time) => time && Date.now() - time < 26 * 3600000;
    value.health = !fresh(value.observedAt)
      ? 'stale'
      : ['failed', 'interrupted'].includes(value.state)
        ? 'failed'
        : fresh(value.lastLocalAt) &&
            fresh(value.lastRemoteAt) &&
            fresh(value.lastDrillAt) &&
            value.remoteConfigured
          ? 'protected'
          : 'incomplete';
    return value;
  } catch {
    return { configured: true, health: 'unavailable' };
  }
}
module.exports = { readBackupStatus, sanitizeStatus, states, errors };
