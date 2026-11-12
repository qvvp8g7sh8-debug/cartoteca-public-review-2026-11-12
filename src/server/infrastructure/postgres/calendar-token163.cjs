const { calendarReadPlan } = require('../../modules/cabinet/calendar-read.cjs');
const { calendarPeriod } = require('../../modules/cabinet/queries.cjs');
// Tokens are fingerprints only. Ordinary reads keep pre/RR/post authority;
// optional169 unchanged reads prove fresh authority/assets/durable versions in
// one metadata-only operation before the kernel's synchronous final gate.
function calendarToken163({ current, url, hash, versions, runtime, renderConfig }) {
  const plan = calendarReadPlan(url, calendarPeriod);
  if (!plan.compact) return null;
  const scope = [
    current.organizationId,
    current.accountId,
    current.sessionId,
    current.role,
    plan.from,
    plan.to,
    plan.overview,
    plan.projection,
    runtime,
    renderConfig,
  ];
  const sign = (payload) => hash('calendar163-v1:' + JSON.stringify([scope, payload]));
  return {
    sign(revision, until) {
      const payload = [revision, until, versions];
      return (
        'c163.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sign(payload)
      );
    },
    read() {
      const token = url.searchParams.get('version');
      if (typeof token !== 'string' || token.length > 2048) return null;
      const match = /^c163\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(token);
      if (!match) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (
        !Array.isArray(payload) ||
        payload.length !== 3 ||
        !Number.isSafeInteger(payload[0]) ||
        payload[0] < 0 ||
        !Number.isSafeInteger(payload[1]) ||
        payload[1] !== Number(url.searchParams.get('until')) ||
        payload[1] <= Date.now() ||
        payload[1] > Date.now() + 3600000 ||
        payload[2] !== versions ||
        match[2] !== sign(payload)
      )
        return null;
      return { revision: payload[0], unchanged: true };
    },
  };
}
module.exports = { calendarToken163 };
