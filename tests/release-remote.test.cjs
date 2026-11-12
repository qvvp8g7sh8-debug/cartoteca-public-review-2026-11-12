const test = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test(
  'Linux deployment worker recovers synthetic failures without production access',
  { skip: process.platform !== 'linux' },
  () => {
    execFileSync('python3', ['-I', path.join(__dirname, 'helpers/release-remote.py')], {
      encoding: 'utf8',
      timeout: 30000,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
  },
);
