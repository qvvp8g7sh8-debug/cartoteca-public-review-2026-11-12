const fs = require('node:fs');
const path = require('node:path');

function switchMarker(directory) {
  directory = path.resolve(directory);
  // The data root is never renamed. Keep the gate INSIDE the mounted data volume,
  // so a container restart sees it even when the host parent directory is not mounted.
  return path.join(directory, '.organization-restore.json');
}
function assertNoOrganizationSwitch(directory) {
  if (fs.existsSync(switchMarker(directory)))
    throw Error('Organization restore switch is incomplete; offline recovery is required.');
}
module.exports = { switchMarker, assertNoOrganizationSwitch };
