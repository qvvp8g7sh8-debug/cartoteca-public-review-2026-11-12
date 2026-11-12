const { createStaffLinks } = require('./staff-links.cjs');
const { createStaffQueue } = require('./staff-queue.cjs');
function createStaffNotifications(context) {
  const links = createStaffLinks(context);
  return { ...links, ...createStaffQueue(context, links) };
}
module.exports = { createStaffNotifications };
