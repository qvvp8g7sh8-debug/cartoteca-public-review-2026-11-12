const path = require('node:path');
const flow = require('./release/flow.cjs');
async function main(args = process.argv.slice(2)) {
  const [command, id, ...rest] = args;
  if (!['start', 'advance', 'status'].includes(command))
    throw Error('Use start, advance or status');
  const root = path.resolve(__dirname, '..');
  const publish = rest.includes('--publish');
  const index = rest.indexOf('--deploy-config');
  const deployConfig = index === -1 ? undefined : rest[index + 1];
  const expected = [
    ...(publish ? ['--publish'] : []),
    ...(deployConfig ? ['--deploy-config', deployConfig] : []),
  ];
  if (
    rest.length !== expected.length ||
    rest.some((a) => !expected.includes(a)) ||
    (command !== 'start' && rest.length)
  )
    throw Error('Invalid flow options');
  const controller = new AbortController(),
    abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const emit = (value) => console.log(JSON.stringify(value));
  try {
    let result;
    if (command === 'start') result = flow.start(root, id, { publish, deployConfig });
    else if (command === 'status') result = flow.next(flow.read(root, id));
    else {
      let body = '';
      for await (const bytes of process.stdin) {
        body += bytes;
        if (body.length > 4 * 1024 * 1024) throw Error('Oversized connector reply');
      }
      result = await flow.advance(root, id, body.trim() ? JSON.parse(body) : {}, {
        emit,
        signal: controller.signal,
      });
    }
    emit({ event: 'result', ...result });
    if (result.phase === 'failed' || result.interrupted) process.exitCode = 1;
    return result;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
if (require.main === module)
  main().catch(() => {
    console.error('Release follow failed; inspect its private state');
    process.exitCode = 1;
  });
module.exports = { main };
