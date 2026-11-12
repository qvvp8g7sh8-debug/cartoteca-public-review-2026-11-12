const candidateLimit = 8;
const exclusions = Array(candidateLimit).fill('?').join(',');
const cleanBusy = (error) =>
  error.code === 'ERR_SQLITE_ERROR' &&
  error.postgresCode === 'POSTGRES_BUSY' &&
  error.retryableBeforeBegin === true &&
  error.transactionOpen === false &&
  !error.outcomeUnknown &&
  !error.channelPoisoned;
function organizationQueue(c, queueDomain, organizationId, callback) {
  if (c.db.isTransaction) return callback();
  return c.organizationQueueTransaction(callback, { queueDomain, organizationId });
}
const candidateAfter = '(next_at>? OR (next_at=? AND id>?))';
function createOrganizationClaims(c, domain) {
  const initial = () => ({ nextAt: Number.MIN_SAFE_INTEGER, id: '' });
  let cursor = initial();
  return function claimByOrganization(select, claim) {
    const visited = [];
    for (let attempt = 0; attempt < candidateLimit; attempt++) {
      const omitted = [...visited, ...Array(candidateLimit - visited.length).fill('')];
      let hint = select(omitted, cursor);
      if (!hint && cursor.id) {
        cursor = initial();
        hint = select(omitted, cursor);
      }
      if (!hint) return null;
      cursor = { nextAt: hint.next_at, id: hint.id };
      visited.push(hint.organization_id);
      let entered = false;
      try {
        const result = organizationQueue(c, domain, hint.organization_id, () => {
          entered = true;
          return claim(hint.organization_id);
        });
        if (result) return result;
      } catch (error) {
        // Only positively known failed admission may choose a different scope.
        // A callback/commit failure never enters another candidate transaction.
        if (entered || !cleanBusy(error)) throw error;
      }
    }
    return null;
  };
}
module.exports = {
  exclusions,
  candidateAfter,
  organizationQueue,
  createOrganizationClaims,
  cleanBusy,
};
