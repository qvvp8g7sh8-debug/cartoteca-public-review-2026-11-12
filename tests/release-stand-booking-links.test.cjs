const test = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test(
  'booking-links release fixtures preserve addresses, sessions and isolated budgets under failures',
  { skip: process.platform !== 'linux' && !process.env.CARTOTECA_TEST_PYTHON },
  () => {
    execFileSync(
      process.env.CARTOTECA_TEST_PYTHON || 'python3',
      ['-I', '-B', path.join(__dirname, 'helpers/release-stand-booking-links.test.py')],
      {
        encoding: 'utf8',
        timeout: 90000,
        env: {
          PATH: process.env.PATH,
          LANG: 'C.UTF-8',
          PYTHONDONTWRITEBYTECODE: '1',
          ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        },
      },
    );
  },
);
