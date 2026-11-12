const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { controlIdentity, socketPath } = require('../../scripts/benchmark-mixed95-profile.cjs');
const { call } = require('../../scripts/benchmark-mixed95-control.cjs');
async function waitFor(predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  throw Error('Finite synthetic95 condition did not complete');
}
function spawnRole(f, role) {
  const environment = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])
    if (process.env[name]) environment[name] = process.env[name];
  const file = path.join(
    f.sourceRoot,
    'scripts',
    role === 'background' ? 'benchmark-mixed95-background.cjs' : 'benchmark-mixed95-server.cjs',
  );
  const child = fork(file, [f.jobFile], {
    cwd: f.sourceRoot,
    env: environment,
    execArgv: ['--max-old-space-size=384'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  f.children.push(child);
  child.messages = [];
  const output = { stdout: '', stderr: '', droppedBytes: 0 };
  for (const name of ['stdout', 'stderr'])
    child[name].on('data', (chunk) => {
      if (Buffer.byteLength(output[name]) + chunk.length <= 65536) output[name] += chunk.toString();
      else output.droppedBytes += chunk.length;
    });
  child.on('message', (value) => {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 4096);
    assert.deepEqual(value.identity, controlIdentity(f.job, role));
    if (child.messages.length < 64) child.messages.push(value);
  });
  child.once('exit', (code, signal) =>
    fs.writeFileSync(
      path.join(f.controlDirectory, role + '-process-' + child.pid + '.json'),
      JSON.stringify({ role, pid: child.pid, code, signal, output }),
      { flag: 'wx', mode: 0o600 },
    ),
  );
  child.ready = waitFor(() => {
    if (child.exitCode !== null)
      throw Error('Synthetic95 role exited before ready: ' + output.stderr.slice(0, 600));
    return child.messages.find((value) => value.ready === true);
  }, 20000);
  child.output = output;
  return child;
}
const command = (f, role, verb) =>
  call(socketPath(f.job, role), controlIdentity(f.job, role), verb);
async function api(f, route, { actor, method = 'GET', body, operationId } = {}) {
  const response = await fetch(f.base + route, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      ...f.headers(actor),
      ...(operationId ? { 'X-Cartoteca-Operation': operationId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function stopPair(f) {
  const owner = f.job.topology === 'combined' ? 'sut' : 'background';
  const background = await command(f, owner, 'stop');
  const web = owner === 'sut' ? background : await command(f, 'api', 'stop');
  return { web, background };
}
module.exports = { waitFor, spawnRole, command, api, stopPair };
