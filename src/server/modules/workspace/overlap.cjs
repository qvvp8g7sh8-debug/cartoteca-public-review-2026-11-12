// Legacy rooms inherit the former global switch; new rooms carry an explicit rule.
function roomBlocksOverlap(settings, room) {
  return typeof room?.preventOverlap === 'boolean'
    ? room.preventOverlap
    : settings.enabled === true;
}
function staffBlocksOverlap(settings, staffId) {
  const rule = settings.staffRules?.find((r) => r.staffId === staffId);
  return typeof rule?.preventOverlap === 'boolean'
    ? rule.preventOverlap
    : settings.enabled === true;
}
function hasOverlapProtection(settings) {
  return (
    settings.enabled === true ||
    settings.staffRules?.some((r) => r.preventOverlap === true) ||
    settings.rooms.some((r) => r.active && roomBlocksOverlap(settings, r))
  );
}
module.exports = { roomBlocksOverlap, staffBlocksOverlap, hasOverlapProtection };
