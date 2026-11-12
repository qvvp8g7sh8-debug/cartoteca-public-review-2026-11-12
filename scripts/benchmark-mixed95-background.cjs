// No application HTTP listener. Only the bounded job-owned local control socket.
const { readJob, controlIdentity, socketPath } = require('./benchmark-mixed95-profile.cjs');
const control = require('./benchmark-mixed95-control.cjs');
const { createRole } = require('./benchmark-mixed95-runtime.cjs');
async function start({ jobFile } = {}) {
  const job = readJob(jobFile);
  if (job.topology !== 'split') throw Error('Dedicated background requires split topology');
  const runtime = await createRole(job, 'background');
  let phases, local;
  try {
    await runtime.prepare();
    if (runtime.server.address() !== null)
      throw Error('Background application listener must remain absent');
    phases = control.createPhases(controlIdentity(job, 'background'), runtime.handlers());
    local = await control.listen(socketPath(job, 'background'), phases);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  let closing;
  const close = () =>
    (closing ||= (async () => {
      await local.close();
      await runtime.close();
    })());
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  return { runtime, phases, close, job };
}
module.exports = { start };
if (require.main === module)
  start({ jobFile: process.argv[2] })
    .then(({ job }) => {
      const ready = {
        ready: true,
        role: 'background',
        identity: controlIdentity(job, 'background'),
        port: null,
      };
      process.send?.(ready);
      console.log(JSON.stringify(ready));
    })
    .catch((error) => {
      console.error(JSON.stringify({ ready: false, error: error.message.slice(0, 300) }));
      process.exitCode = 1;
    });
