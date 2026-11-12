const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../scripts/release/flow-follow.js'), 'utf8');
const follow = new Function(source + '\nreturn followRelease;')();
const reply = (value) => ({ structuredContent: { content: JSON.stringify(value) } });
const local = (state) => ({
  output: JSON.stringify({ event: 'result', id: 'synthetic', ...state }) + '\n',
  exit_code: 0,
});
test('Codex bridge chains metadata and connector download without exposing the file reference', async () => {
  const events = [],
    calls = [],
    inputs = [];
  const reference = 'https://synthetic.oaiusercontent.com/file?sig=SYNTHETIC_SECRET';
  const tools = {
    exec_command: async (args) => {
      calls.push('local');
      if (!args.cmd.startsWith("@'"))
        return local({
          phase: 'ci',
          action: {
            kind: 'ci',
            url: 'https://synthetic.invalid/run',
            jobsUrl: 'https://synthetic.invalid/jobs',
          },
        });
      const input = JSON.parse(args.cmd.split('\n')[1]);
      inputs.push(input);
      if (input.kind === 'ci')
        return local({
          phase: 'artifacts',
          action: { kind: 'artifacts', url: 'https://synthetic.invalid/artifacts' },
        });
      if (input.kind === 'artifacts')
        return local({
          phase: 'reference',
          action: {
            kind: 'reference',
            repository: 'synthetic/repository',
            artifactId: 5,
            name: 'verified-release',
          },
        });
      if (input.kind === 'reference') return local({ phase: 'ready' });
      throw Error('Unexpected synthetic action');
    },
    mcp__codex_apps__github_fetch: async ({ url }) => {
      calls.push(url);
      if (url.endsWith('/jobs'))
        return reply({
          jobs: [{ id: 1, name: 'package', status: 'completed', conclusion: 'success', steps: [] }],
          total_count: 1,
        });
      if (url.endsWith('/run')) return reply({ id: 7, status: 'completed', conclusion: 'success' });
      if (url.endsWith('/artifacts'))
        return reply({ total_count: 1, artifacts: [{ id: 5, workflow_run: {} }] });
      throw Error('Unexpected synthetic URL');
    },
    mcp__codex_apps__github_download_workflow_artifact: async (args) => {
      calls.push('connector-download');
      assert.equal(args.artifact_id, 5);
      return { structuredContent: { file_uri: { download_url: reference } } };
    },
  };
  const state = await follow(
    tools,
    { id: 'synthetic', mode: 'continue', workspace: 'SYNTHETIC_WORKSPACE' },
    (value) => events.push(value),
  );
  assert.equal(state.phase, 'ready');
  assert.deepEqual(
    inputs.map((input) => input.kind),
    ['ci', 'artifacts', 'reference'],
  );
  assert.equal(inputs[2].url, reference);
  assert.ok(calls.includes('connector-download'));
  assert.equal(JSON.stringify({ state, events }).includes('SYNTHETIC_SECRET'), false);
});
test('status only reads the local journal and never contacts GitHub', async () => {
  let calls = 0;
  const state = await follow(
    {
      exec_command: async () => {
        calls++;
        return local({ phase: 'ready' });
      },
    },
    { id: 'synthetic', mode: 'status' },
    () => {},
  );
  assert.equal(state.phase, 'ready');
  assert.equal(calls, 1);
});
test('continuation finishes independent verification without launching another publication', async () => {
  const commands = [];
  const state = await follow(
    {
      exec_command: async (args) => {
        commands.push(args.cmd);
        return local({ phase: commands.length === 1 ? 'verification' : 'completed' });
      },
    },
    { id: 'synthetic', mode: 'continue' },
    () => {},
  );
  assert.equal(state.phase, 'completed');
  assert.equal(commands.length, 2);
  assert.ok(commands[1].includes(' advance '));
  assert.equal(
    commands.some((command) => command.includes('--publish')),
    false,
  );
});
