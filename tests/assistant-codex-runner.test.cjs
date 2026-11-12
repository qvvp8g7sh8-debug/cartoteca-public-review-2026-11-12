const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCodexRuntime } = require('../src/server/modules/assistant/providers/codex/codex.cjs');
const {
  childEnvironment,
  inferenceArgs,
  overrides,
} = require('../src/server/modules/assistant/providers/codex/codex-config.cjs');
const { createOutputParser } = require('../src/server/modules/assistant/providers/codex/codex-output.cjs');
const { runProcess } = require('../src/server/modules/assistant/providers/codex/codex-process.cjs');

const local = {
  enabled: true,
  production: false,
  host: '127.0.0.1',
  origin: '',
  additionalOrigins: [],
  releaseGate: false,
  processRole: 'combined',
};
const request = {
  payload: {
    messages: [
      { role: 'system', content: 'Синтетический диспетчер.' },
      { role: 'user', content: 'Календарь завтра.' },
    ],
  },
  provider: { provider: 'codex', model: 'codex-default' },
  timeoutMs: 10000,
};
function events(intent = { intent: 'calendar', date: '2026-10-16' }) {
  return (
    [
      { type: 'thread.started', thread_id: 'synthetic' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'a', type: 'agent_message', text: JSON.stringify(intent) },
      },
      { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 10 } },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n'
  );
}
function harness(options = {}) {
  const calls = [];
  let turns = 0;
  const runtime = createCodexRuntime(local, {
    env: {
      PATH: '/synthetic',
      OPENAI_API_KEY: 'synthetic-must-not-pass',
      CODEX_HOME: '/synthetic-auth-home',
    },
    findExecutable: () => '/synthetic/codex',
    runProcess: async (call) => {
      calls.push(call);
      call.guard();
      if (call.args[0] === '--version')
        return { stdout: (options.version || 'codex-cli 0.154.0') + '\n', stderr: '' };
      if (call.args[0] === 'login')
        return { stdout: '', stderr: options.auth || 'Logged in using ChatGPT\n' };
      if (call.args[0] === 'mcp')
        return {
          stdout: JSON.stringify([{ name: 'synthetic.server', enabled: true }]),
          stderr: '',
        };
      turns++;
      if (options.beforeReply) await options.beforeReply(call);
      call.onStdout(options.output || events());
      return { stdout: '', stderr: '' };
    },
  });
  return { runtime, calls, turnCount: () => turns };
}
test('Codex stays unavailable outside the explicitly enabled loopback preview', () => {
  for (const override of [
    { enabled: false },
    { production: true },
    { host: '0.0.0.0' },
    { host: 'localhost' },
    { origin: 'https://synthetic.invalid' },
    { additionalOrigins: ['https://synthetic.invalid'] },
    { additionalOrigins: undefined },
    { releaseGate: true },
    { processRole: 'worker' },
  ]) {
    let searched = false;
    const runtime = createCodexRuntime(
      { ...local, ...override },
      {
        findExecutable() {
          searched = true;
          return '/synthetic/codex';
        },
      },
    );
    assert.equal(runtime.available, false);
    assert.equal(searched, false);
  }
});
test('child environment excludes API credentials, endpoint overrides and executable injection', () => {
  const result = childEnvironment({
    PATH: '/synthetic',
    CODEX_HOME: '/synthetic-home',
    SystemRoot: 'C:\\Windows',
    OPENAI_API_KEY: 'synthetic',
    CODEX_API_KEY: 'synthetic',
    TIMEWEB_API_KEY: 'synthetic',
    OPENAI_BASE_URL: 'https://synthetic.invalid',
    NODE_OPTIONS: '--require /synthetic.js',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'synthetic',
    RUST_LOG: 'trace',
  });
  assert.deepEqual(
    Object.keys(result).sort(),
    ['CODEX_HOME', 'PATH', 'RUST_LOG', 'SystemRoot'].sort(),
  );
  assert.equal(result.RUST_LOG, 'off');
});
test('inference args preserve policies and use an explicit restricted profile', () => {
  const args = inferenceArgs(
    '/synthetic-empty',
    { CODEX_HOME: '/synthetic-auth' },
    'codex-default',
    ['synthetic.server'],
  );
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ephemeral'));
  assert.ok(!args.includes('--ignore-rules'));
  assert.ok(!args.includes('--sandbox'));
  assert.ok(!args.includes('--model'));
  assert.ok(args.some((arg) => arg.includes('.filesystem={') && arg.includes('":root"="deny"')));
  assert.ok(args.includes('mcp_servers."synthetic.server".enabled=false'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
});
test('one request authenticates first, disables configured MCP and returns only a validated intent', async () => {
  const f = harness();
  let outbound = 0;
  const result = await f.runtime.run({ ...request, onOutbound: () => outbound++ });
  assert.deepEqual(JSON.parse(result.text), { intent: 'calendar', date: '2026-10-16' });
  assert.deepEqual(result.usage, { input_tokens: 200, output_tokens: 10 });
  assert.equal(f.turnCount(), 1);
  assert.equal(outbound, 1);
  assert.deepEqual(
    f.calls.map((call) => call.args[0]),
    ['--version', 'login', 'mcp', 'exec'],
  );
  assert.equal(new Set(f.calls.map((call) => call.deadline)).size, 1);
  assert.ok(f.calls[3].args.includes('mcp_servers."synthetic.server".enabled=false'));
  assert.equal(f.calls[3].env.OPENAI_API_KEY, undefined);
  assert.equal(fs.existsSync(f.calls[0].cwd), false);
});
test('API-key login and unsupported CLI versions stop before inference', async () => {
  const f = harness({ auth: 'Logged in using an API key' });
  let outbound = 0;
  await assert.rejects(f.runtime.run({ ...request, onOutbound: () => outbound++ }), /Войдите/);
  assert.equal(f.turnCount(), 0);
  assert.equal(outbound, 0);
  assert.equal(fs.existsSync(f.calls[0].cwd), false);
  const old = createCodexRuntime(local, {
    findExecutable: () => '/synthetic/codex',
    runProcess: async () => ({ stdout: 'codex-cli 0.100.0\n', stderr: '' }),
  });
  await assert.rejects(
    old.run(request),
    (error) => error.status === 503 && /версия Codex CLI пока не поддержана/.test(error.message),
  );
});
test('active command has no parallel queue and revocation prevents its result', async () => {
  let release, active;
  const waiting = new Promise((resolve) => {
    active = resolve;
  });
  const f = harness({
    beforeReply: async () => {
      active();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  let permitted = true;
  const run = f.runtime.run({
    ...request,
    guard() {
      if (!permitted) throw Object.assign(new Error('synthetic revoked'), { status: 403 });
    },
  });
  await waiting;
  await assert.rejects(f.runtime.run(request), (error) => error.status === 429);
  permitted = false;
  release();
  await assert.rejects(run, (error) => error.status === 403);
});
test('parser rejects tool events, truncated runs and unsupported business actions', () => {
  const tool = createOutputParser();
  assert.throws(
    () =>
      tool.push(
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }) + '\n',
      ),
    /инструмент/,
  );
  const truncated = createOutputParser();
  truncated.push('{"type":"turn.started"}\n');
  assert.throws(() => truncated.finish(), /не завершил/);
  const unsupported = createOutputParser();
  unsupported.push(events({ intent: 'deletePatient' }));
  assert.throws(() => unsupported.finish(), /неподдерживаемое/);
});
function processHarness(behaviour) {
  const child = new EventEmitter();
  child.pid = 123456;
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return {
    spawn(executable, args, options) {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      setImmediate(() => behaviour(child));
      return child;
    },
    terminate() {
      setImmediate(() => {
        child.exitCode = 1;
        child.emit('close', 1);
      });
    },
  };
}
test('process transport aborts oversized output without exposing stderr', async () => {
  const deps = processHarness((child) => {
    child.stderr.write('synthetic-private-diagnostic');
    child.stdout.write(Buffer.alloc(17, 65));
  });
  await assert.rejects(
    runProcess(
      {
        executable: '/synthetic',
        args: [],
        cwd: '/synthetic',
        env: {},
        input: '{}',
        deadline: Date.now() + 1000,
        guard() {},
        stdoutLimit: 16,
      },
      deps,
    ),
    (error) => error.status === 502 && !error.message.includes('private'),
  );
});
test('deadline and guard apply during a silent child process', async () => {
  await assert.rejects(
    runProcess(
      {
        executable: '/synthetic',
        args: [],
        cwd: '/synthetic',
        env: {},
        deadline: Date.now() + 20,
        guard() {},
      },
      processHarness(() => {}),
    ),
    (error) => error.status === 504,
  );
  let allowed = true;
  const deps = processHarness(() => {
    allowed = false;
  });
  await assert.rejects(
    runProcess(
      {
        executable: '/synthetic',
        args: [],
        cwd: '/synthetic',
        env: {},
        deadline: Date.now() + 1000,
        guard() {
          if (!allowed) throw Object.assign(new Error('synthetic revoked'), { status: 403 });
        },
      },
      deps,
    ),
    (error) => error.status === 403,
  );
});

test('installed desktop CLI version reaches the same isolated inference contract', async () => {
  const current = harness({ version: 'codex-cli 0.162.0-alpha.17.2' });
  await current.runtime.run(request);
  assert.equal(current.turnCount(), 1);
  const future = harness({ version: 'codex-cli 0.163.0' });
  await assert.rejects(future.runtime.run(request), (error) => error.status === 503);
  assert.equal(future.turnCount(), 0);
});


test('exact desktop alpha omits only the removed legacy image setting and retains strict tool isolation', () => {
  const desktop = 'codex-cli 0.162.0-alpha.17.2';
  const env = { CODEX_HOME: '/synthetic-auth' };
  const alpha = inferenceArgs('/synthetic-empty', env, 'codex-default', ['synthetic.server'], desktop);
  assert.ok(!alpha.includes('tools.view_image=false'));
  assert.ok(alpha.includes('features.view_image=false'));
  for (const flag of ['--strict-config', '--ignore-user-config', '--ephemeral', '--output-schema']) assert.ok(alpha.includes(flag));
  for (const setting of [
    'features.shell_tool=false',
    'features.browser_use=false',
    'features.apps=false',
    'features.multi_agent=false',
    'forced_login_method="chatgpt"',
    'approval_policy="never"',
    'mcp_servers."synthetic.server".enabled=false',
  ]) assert.ok(alpha.includes(setting));
  assert.ok(alpha.some((arg) => arg.includes('.network.enabled=false')));
  assert.ok(alpha.some((arg) => arg.includes('.filesystem={') && arg.includes('":root"="deny"')));
  const legacy = inferenceArgs('/synthetic-empty', env, 'codex-default', ['synthetic.server'], 'codex-cli 0.154.7');
  assert.ok(legacy.includes('tools.view_image=false'));
  assert.ok(legacy.includes('features.view_image=false'));
  const alphaStartup = new Set(['suppress_unstable_features_warning=true', 'features.code_mode_only=false']);
  const ordinaryAlpha = alpha.filter((arg, index) => !alphaStartup.has(arg) && !(arg === '-c' && alphaStartup.has(alpha[index + 1])));
  assert.deepEqual(legacy.filter((arg, index) => arg !== 'tools.view_image=false' && !(arg === '-c' && legacy[index + 1] === 'tools.view_image=false')), ordinaryAlpha);
  assert.ok(!overrides('/synthetic-empty', env, [], desktop).includes('tools.view_image=false'));
  assert.ok(overrides('/synthetic-empty', env).includes('tools.view_image=false'));
});

test('runtime carries the verified CLI version into authentication, MCP listing and inference overrides', async () => {
  for (const version of ['codex-cli 0.162.0-alpha.17.2', 'codex-cli 0.154.7']) {
    const f = harness({ version });
    const result = await f.runtime.run(request);
    assert.deepEqual(JSON.parse(result.text), { intent: 'calendar', date: '2026-10-16' });
    assert.equal(f.turnCount(), 1);
    assert.deepEqual(f.calls.map((call) => call.args[0]), ['--version', 'login', 'mcp', 'exec']);
    for (const call of f.calls.slice(1)) {
      assert.equal(call.args.includes('tools.view_image=false'), version.startsWith('codex-cli 0.154.'));
      assert.ok(call.args.includes('features.view_image=false'));
      assert.ok(call.args.includes('features.shell_tool=false'));
      assert.ok(call.args.some((arg) => arg.includes('.network.enabled=false')));
    }
    assert.ok(f.calls.at(-1).args.includes('--strict-config'));
    assert.ok(f.calls.at(-1).args.includes('mcp_servers."synthetic.server".enabled=false'));
    assert.equal(fs.existsSync(f.calls[0].cwd), false);
  }
});


test('provider error items fail closed without being called tool attempts or leaking their diagnostics', () => {
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    const parser = createOutputParser();
    parser.push(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-error-thread' }) + '\n');
    assert.throws(() => parser.push(JSON.stringify({
      type,
      item: {
        id: 'synthetic-error-item',
        type: 'error',
        message: 'SYNTHETIC_PRIVATE_ERROR_MESSAGE',
        source: 'SYNTHETIC_PRIVATE_ERROR_SOURCE',
      },
    }) + '\n'), (error) => {
      assert.equal(error.status, 502);
      assert.match(error.message, /Codex/);
      assert.doesNotMatch(error.message, /инструмент|SYNTHETIC_PRIVATE_ERROR/);
      return true;
    });
    assert.throws(() => parser.finish(), (error) => error.status === 502);
  }
  const tool = createOutputParser();
  assert.throws(() => tool.push(JSON.stringify({
    type: 'item.completed', item: { id: 'synthetic-tool', type: 'command_execution', command: 'synthetic-never-run' },
  }) + '\n'), (error) => error.status === 502 && /инструмент/.test(error.message));
});


const knownCodeModeNotice = "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
const desktopAlpha = 'codex-cli 0.162.0-alpha.17.2';
const startupEvent = (extra = {}) => ({ type: 'item.completed', item: { id: 'synthetic-notice', type: 'error', message: knownCodeModeNotice }, ...extra });
const eventLines = (values) => values.map((event) => JSON.stringify(event)).join('\n') + '\n';
const threadStarted = { type: 'thread.started', thread_id: 'synthetic-startup' };
const turnStarted = { type: 'turn.started' };
const finalAgent = { type: 'item.completed', item: { id: 'synthetic-final', type: 'agent_message', text: JSON.stringify({ intent: 'prepareAppointment' }) } };
const turnCompleted = { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } };

test('exact alpha startup configuration keeps code mode and its host disabled without legacy startup warnings', () => {
  const alpha = inferenceArgs('/synthetic-empty', {}, 'codex-default', [], desktopAlpha);
  for (const setting of ['suppress_unstable_features_warning=true', 'features.code_mode_only=false', 'features.code_mode=false', 'features.code_mode_host=false', 'features.shell_tool=false']) assert.ok(alpha.includes(setting));
  assert.ok(alpha.includes('--strict-config'));
  assert.ok(!alpha.includes('tools.view_image=false'));
  for (const version of ['', 'codex-cli 0.154.7']) {
    const legacy = inferenceArgs('/synthetic-empty', {}, 'codex-default', [], version);
    assert.ok(!legacy.includes('suppress_unstable_features_warning=true'));
    assert.ok(!legacy.includes('features.code_mode_only=false'));
    assert.ok(legacy.includes('tools.view_image=false'));
  }
});

test('exact alpha accepts one known code-mode startup notice without treating it as model output', () => {
  const parser = createOutputParser({ installedVersion: desktopAlpha });
  parser.push(eventLines([threadStarted, startupEvent(), turnStarted, finalAgent, turnCompleted]));
  const result = parser.finish();
  assert.deepEqual(JSON.parse(result.text), { intent: 'prepareAppointment' });
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 20 });
  const incomplete = createOutputParser({ installedVersion: desktopAlpha });
  incomplete.push(eventLines([threadStarted, startupEvent()]));
  assert.throws(() => incomplete.finish(), (error) => error.status === 502);
});

test('startup notice compatibility rejects every other version, timing, duplicate and message variant', () => {
  for (const options of [undefined, { installedVersion: 'codex-cli 0.154.7' }, { installedVersion: 'codex-cli 0.162.0-alpha.17.3' }]) {
    const parser = createOutputParser(options);
    assert.throws(() => parser.push(eventLines([threadStarted, startupEvent()])), (error) => error.status === 502 && !error.message.includes(knownCodeModeNotice));
  }
  for (const sequence of [
    [startupEvent()],
    [threadStarted, turnStarted, startupEvent()],
    [threadStarted, startupEvent(), startupEvent()],
    [threadStarted, finalAgent, startupEvent()],
    [threadStarted, startupEvent({ type: 'item.started' })],
    [threadStarted, startupEvent({ type: 'item.updated' })],
    [threadStarted, startupEvent({ item: { type: 'error', message: knownCodeModeNotice + ' ' } })],
    [threadStarted, startupEvent({ item: { type: 'error', message: 'SYNTHETIC_PRIVATE_OTHER_ERROR' } })],
    [threadStarted, startupEvent(), turnStarted, startupEvent({ item: { type: 'error', message: 'SYNTHETIC_PRIVATE_MODEL_ERROR' } })],
    [threadStarted, startupEvent(), turnStarted, { type: 'item.completed', item: { type: 'command_execution', command: 'synthetic-never-run' } }],
  ]) {
    const parser = createOutputParser({ installedVersion: desktopAlpha });
    assert.throws(() => parser.push(eventLines(sequence)), (error) => error.status === 502 && !/SYNTHETIC_PRIVATE_|Code Mode is unavailable/.test(error.message));
  }
});

test('runtime opts into the known startup notice only for its verified exact alpha version', async () => {
  const output = eventLines([threadStarted, startupEvent(), turnStarted, finalAgent, turnCompleted]);
  const alpha = harness({ version: desktopAlpha, output });
  const result = await alpha.runtime.run(request);
  assert.deepEqual(JSON.parse(result.text), { intent: 'prepareAppointment' });
  assert.equal(alpha.turnCount(), 1);
  const legacy = harness({ version: 'codex-cli 0.154.7', output });
  await assert.rejects(legacy.runtime.run(request), (error) => error.status === 502);
});
