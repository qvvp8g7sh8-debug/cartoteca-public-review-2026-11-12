const { createHash } = require('node:crypto');
const { uuid169 } = require('./hot-metadata-component169.cjs');
const { canonicalDirectoryQuery170 } = require('./directory-key170.cjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
function snapshotRequest180(url) {
  return canonicalDirectoryQuery170(url) !== null;
}
function directorySnapshotKey180({ epoch, storeId, current }) {
  return JSON.stringify([
    epoch,
    storeId,
    current.organizationId,
    current.accountId,
    current.sessionId,
    current.role,
    current.role === 'cosmetologist' ? 'staff:' + current.accountId : '*',
  ]);
}
function directorySnapshotClaim180({ epoch, platformStoreId, token, headers, url }) {
  if (
    !snapshotRequest180(url) ||
    !uuid169(epoch) ||
    !uuid169(platformStoreId) ||
    typeof token !== 'string' ||
    token.length > 16384 ||
    !uuid169(headers?.['x-cartoteca-account-id']) ||
    !uuid169(headers?.['x-cartoteca-organization-id'])
  )
    return null;
  return JSON.stringify([
    epoch,
    platformStoreId,
    hash(token),
    headers['x-cartoteca-account-id'],
    headers['x-cartoteca-organization-id'],
    '/api/cabinet/directory',
  ]);
}
module.exports = { snapshotRequest180, directorySnapshotKey180, directorySnapshotClaim180 };
