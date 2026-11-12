const { createStaffMaxLinks } = require('./staff-max-links.cjs');
const { createStaffQueue } = require('./staff-queue.cjs');
function createStaffMaxNotifications(context) {
  const links = createStaffMaxLinks(context);
  return { ...links, ...createStaffQueue(context, links, 'max') };
}
module.exports = { createStaffMaxNotifications };
