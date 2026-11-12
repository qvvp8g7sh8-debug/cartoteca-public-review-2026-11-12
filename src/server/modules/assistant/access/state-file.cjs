const fs = require('node:fs');
const path = require('node:path');
const stateName = 'assistant-state.enc';
const MAX_BYTES = 2 * 1024 * 1024;
function createStateFileReader(fileSystem = fs) {
  return function readStateBytes(directory) {
    const filename = path.join(directory, stateName);
    try {
      if (fileSystem.statSync(filename).size > MAX_BYTES)
        throw Error('Assistant state exceeds its limit.');
      return fileSystem.readFileSync(filename);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
}
const readStateBytes = createStateFileReader();
module.exports = { stateName, MAX_BYTES, readStateBytes, createStateFileReader };
