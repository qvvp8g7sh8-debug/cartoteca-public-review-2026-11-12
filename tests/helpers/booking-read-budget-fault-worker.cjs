// A separate process is intentional: SIGKILL must bypass migration finally blocks.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  prepareBookingReadBudgetCopy,
} = require('../../src/server/migrations/prepare-booking-read-budget.cjs');

const [source, destination, directory, keyFile, fault, proof, rollback] = process.argv.slice(2);
const platformFile = path.resolve(destination, 'platform/platform.sqlite');
const budgetFile = path.resolve(destination, 'platform/booking-read-budget.sqlite');
const originalExec = DatabaseSync.prototype.exec;
const originalLink = fs.linkSync;
let published = 0;
function record(value) {
  const fd = fs.openSync(proof, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function crash(point) {
  if (fault !== point) return;
  record({ fault, reached: true });
  process.kill(process.pid, 'SIGKILL');
  throw Error('SIGKILL unexpectedly returned');
}
DatabaseSync.prototype.exec = function (sql) {
  if (sql !== 'COMMIT') return originalExec.call(this, sql);
  const filename = path.resolve(this.prepare('PRAGMA database_list').get().file);
  if (filename === budgetFile) crash('before-budget-commit');
  if (filename === platformFile) crash('before-platform-commit');
  const result = originalExec.call(this, sql);
  if (filename === budgetFile) crash('after-budget-commit');
  if (filename === platformFile) crash('after-platform-commit');
  return result;
};
fs.linkSync = function (from, to) {
  if (fault === 'archive-full' && path.dirname(to) === directory && ++published === 2) {
    record({ fault, reached: true });
    const error = Error('Synthetic archive storage exhausted');
    error.code = 'ENOSPC';
    throw error;
  }
  return originalLink(from, to);
};
prepareBookingReadBudgetCopy({
  source,
  destination,
  directory,
  keyFile,
  offline: true,
  rollback: rollback === 'true',
}).then(
  () => {
    console.error('Fault point was not reached');
    process.exitCode = 2;
  },
  (error) => {
    if (fault === 'archive-full' && error.code === 'ENOSPC') return;
    console.error(error.message);
    process.exitCode = 3;
  },
);
