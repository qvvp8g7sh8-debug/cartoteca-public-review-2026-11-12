// Offline holdout evaluation. No provider credentials, recordings, or working data are read.
// node scripts/assistant-accuracy-eval.cjs > work/assistant-next-20261105/accuracy-summary.json
const { evaluateAccuracy } = require('../tests/helpers/assistant-accuracy-eval.cjs');
evaluateAccuracy()
  .then((report) => {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.passed) process.exitCode = 1;
  })
  .catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
