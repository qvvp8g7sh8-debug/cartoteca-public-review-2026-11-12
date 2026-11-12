const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexRuntime } = require('../src/server/modules/assistant/providers/codex/codex.cjs');
const local = {
  enabled: true,
  production: false,
  host: '127.0.0.1',
  origin: '',
  additionalOrigins: [],
  releaseGate: false,
  processRole: 'combined',
};
const request = () => ({
  provider: { provider: 'codex', model: 'codex-default' },
  payload: {
    messages: [
      { role: 'system', content: 'Синтетический классификатор' },
      { role: 'user', content: 'Календарь' },
    ],
  },
  timeoutMs: 3000,
});
function fixture(t, options = {}) {
  const calls = [];
  let failAuth = options.failAuth;
  const runtime = createCodexRuntime(local, {
    env: { PATH: '/synthetic' },
    findExecutable: () => '/synthetic/codex',
    runProcess: async (call) => {
      calls.push(call);
      if (call.args[0] === '--version') return { stdout: 'codex-cli 0.154.0\n', stderr: '' };
      if (call.args[0] === 'login') {
        if (failAuth) {
          failAuth = false;
          throw Object.assign(Error('synthetic login expired'), { codexExitCode: 1 });
        }
        return { stdout: 'Logged in using ChatGPT\n', stderr: '' };
      }
      if (call.args[0] === 'mcp') return { stdout: '[]', stderr: '' };
      if (options.cleanupFailure)
        throw Object.assign(Error('synthetic process did not exit'), {
          status: 503,
          codexCleanupFailed: true,
        });
      call.onStdout(
        [
          { type: 'thread.started', thread_id: 'synthetic' },
          { type: 'turn.started' },
          {
            type: 'item.completed',
            item: { id: 'reply', type: 'agent_message', text: '{"intent":"calendar"}' },
          },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ]
          .map((value) => JSON.stringify(value))
          .join('\n') + '\n',
      );
      return { stdout: '', stderr: '' };
    },
  });
  t.after(() => {
    for (const directory of new Set(calls.map((call) => call.cwd))) {
      const target = path.resolve(directory);
      if (
        path.dirname(target) !== fs.realpathSync(os.tmpdir()) ||
        !path.basename(target).startsWith('cartoteca-codex-')
      )
        throw Error('Unsafe synthetic Codex cleanup');
      if (fs.existsSync(target)) {
        if (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target)
          throw Error('Synthetic directory changed');
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  });
  return { runtime, calls };
}
test('a quarantined Codex process is advertised unavailable and cannot dispatch a new request until restart', async (t) => {
  const f = fixture(t, { cleanupFailure: true });
  assert.equal(f.runtime.available, true);
  await assert.rejects(f.runtime.run(request()), { status: 503, codexCleanupFailed: true });
  assert.equal(f.runtime.available, false);
  const count = f.calls.length;
  await assert.rejects(f.runtime.run(request()), { status: 503 });
  assert.equal(f.calls.length, count);
});
test('a revoked request before dispatch leaves the installed Codex runtime eligible for a later valid request', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.runtime.run({
      ...request(),
      guard() {
        throw Object.assign(Error('Synthetic scope revoked'), { status: 403 });
      },
    }),
    { status: 403 },
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.runtime.available, true);
  assert.equal(JSON.parse((await f.runtime.run(request())).text).intent, 'calendar');
});
test('expired ChatGPT authentication fails before inference and does not permanently disable the installed runtime', async (t) => {
  const f = fixture(t, { failAuth: true });
  await assert.rejects(f.runtime.run(request()), { status: 503 });
  assert.equal(
    f.calls.some((call) => call.args[0] === 'exec'),
    false,
  );
  assert.equal(f.runtime.available, true);
  assert.equal(JSON.parse((await f.runtime.run(request())).text).intent, 'calendar');
});
