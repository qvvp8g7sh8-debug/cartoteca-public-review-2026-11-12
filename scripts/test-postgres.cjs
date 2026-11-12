const { spawn } = require('node:child_process');
const { startPostgresTestRuntime } = require('./postgres-test-runtime.cjs');
async function run(files = process.argv.slice(2)) {
  if (process.env.CARTOTECA_TEST_PG) throw Error('The test harness owns one PostgreSQL cluster.');
  const runtime = await startPostgresTestRuntime();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
        windowsHide: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          CARTOTECA_TEST_PG: JSON.stringify({
            synthetic: true,
            admin: runtime.admin,
            application: runtime.application,
            data: runtime.data,
          }),
        },
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    await runtime.close();
  }
}
if (require.main === module)
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        'PostgreSQL functional stage did not complete; retain its diagnostic evidence.',
      );
      process.exitCode = 1;
    });
module.exports = { run };
