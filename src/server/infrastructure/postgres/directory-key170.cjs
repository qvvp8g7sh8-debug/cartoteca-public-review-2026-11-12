const { createHash } = require('node:crypto');
const { uuid169 } = require('./hot-metadata-component169.cjs');
const hash170 = (value) => createHash('sha256').update(value).digest('hex');

// Hint classification must not raise directory/cursor errors before authority.
// Only q has this exact normalization in parameters() and cursor.scope.
function canonicalDirectoryQuery170(url) {
  if (
    !(url instanceof URL) ||
    url.pathname !== '/api/cabinet/directory' ||
    url.href.length > 8192 ||
    url.searchParams.get('picker') === '1'
  )
    return null;
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (q.length > 160) return null;
  const params = new URLSearchParams(url.searchParams);
  params.set('q', q);
  params.sort();
  return params.toString();
}

function fullDirectoryKey170({ epoch, storeId, current, url }) {
  let query = canonicalDirectoryQuery170(url);
  if (query === null) {
    const params = new URLSearchParams(url.searchParams);
    params.sort();
    query = params.toString();
  }
  return JSON.stringify([
    epoch,
    storeId,
    current.organizationId,
    current.accountId,
    current.sessionId,
    current.role,
    url.pathname,
    query,
  ]);
}

// Private bounded lookup metadata, never an HTTP token or cached authority.
// A claim hash collision can only cause an extra fresh SQL attempt: actual body
// retrieval still requires fullDirectoryKey170 with the exact canonical query.
function directoryClaimKey170({ epoch, platformStoreId, token, headers, url }) {
  const query = canonicalDirectoryQuery170(url);
  if (
    query === null ||
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
    hash170(token),
    headers['x-cartoteca-account-id'],
    headers['x-cartoteca-organization-id'],
    url.pathname,
    hash170(query),
  ]);
}

module.exports = {
  canonicalDirectoryQuery170,
  fullDirectoryKey170,
  directoryClaimKey170,
};
