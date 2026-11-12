const test = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test(
  'read-budget release fixtures preserve sessions, jobs and active counters under failures',
  { skip: process.platform !== 'linux' },
  () => {
    execFileSync(
      'python3',
      ['-I', '-B', path.join(__dirname, 'helpers/release-stand-read-budget.test.py')],
      {
        encoding: 'utf8',
        timeout: 60000,
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
  },
);
