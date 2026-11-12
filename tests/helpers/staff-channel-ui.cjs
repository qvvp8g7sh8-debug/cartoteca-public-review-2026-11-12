const fs = require('node:fs');
const path = require('node:path');
const { installActionConfirmation } = require('./action-confirmation.cjs');

function installStaffChannelUI(window, state, actions) {
  installActionConfirmation(window);
  actions.markSettingsSaved ||= () => {};
  for (const [file, factory] of [
    ['staff-channel-icons', 'createStaffChannelIcons'],
    ['staff-notification-actions', 'createStaffNotificationActions'],
    ['staff-channel-panels', 'createStaffChannelPanels'],
  ]) {
    window.eval(fs.readFileSync(path.join(__dirname, '../../src/client/modules', file + '.js'), 'utf8'));
    Object.assign(actions, window.eval(factory)(state, actions));
  }
}
module.exports = { installStaffChannelUI };
