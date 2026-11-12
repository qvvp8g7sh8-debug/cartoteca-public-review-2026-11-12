const { fail } = require('../../../../shared/errors.cjs');
const { keys } = require('../interpretation/intent-schema.cjs');
const limitRanges = Object.freeze({
  monthlyBudgetRub: [0, 100000],
  dailyRequests: [1, 1000],
  maxTextChars: [100, 4000],
  maxAudioSeconds: [1, 60],
  maxReplyChars: [100, 1000],
  maxOutputTokens: [50, 1000],
  requestTimeoutMs: [3000, 30000],
});
const memberLimitKeys = Object.freeze(
  Object.keys(limitRanges).filter((key) => key !== 'monthlyBudgetRub'),
);
function normalizedLimits(value, member = false) {
  keys(value, member ? memberLimitKeys : Object.keys(limitRanges));
  const result = {};
  for (const [key, number] of Object.entries(value)) {
    const [min, max] = limitRanges[key];
    if (
      !Number.isFinite(number) ||
      number < min ||
      number > max ||
      (key !== 'monthlyBudgetRub' && !Number.isInteger(number))
    )
      throw fail(400, 'Недопустимый лимит помощника: ' + key + '.');
    result[key] = number;
  }
  return result;
}
function memberGrant(state, member) {
  return state.grants.find(
    (grant) =>
      grant.membershipId === member?.membershipId &&
      grant.organizationId === member?.organizationId &&
      grant.accountId === member?.accountId,
  );
}
function limitsForMember(state, member) {
  return { ...state.policy.limits, ...memberGrant(state, member)?.limits };
}
module.exports = { normalizedLimits, memberGrant, limitsForMember };
