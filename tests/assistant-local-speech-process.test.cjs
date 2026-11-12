const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  runLocalSpeechProcess,
} = require('../src/server/modules/assistant/providers/local-speech/local-speech-process.cjs');
function child() {
  const value = new EventEmitter();
  value.pid = 1234;
  value.exitCode = null;
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.kill = () => {
    value.exitCode = 1;
    queueMicrotask(() => value.emit('close', 1));
    return true;
  };
  return value;
}
const request = () => ({
  executable: '/synthetic/whisper',
  args: ['--prompt', 'literal; & text'],
  cwd: '/synthetic/temp',
  env: {},
  deadline: Date.now() + 1000,
});
test('native whisper launches without a shell or visible window and exposes no captured transcript', async () => {
  let observed;
  await runLocalSpeechProcess(request(), {
    spawn(executable, args, options) {
      observed = { executable, args, options };
      const value = child();
      queueMicrotask(() => {
        value.stdout.write('synthetic-transcript');
        value.stderr.write('synthetic-diagnostic');
        value.exitCode = 0;
        value.emit('close', 0);
      });
      return value;
    },
  });
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
  assert.deepEqual(observed.args, ['--prompt', 'literal; & text']);
});
test('a silent native process is terminated at the deadline before the promise rejects', async () => {
  let value;
  await assert.rejects(
    runLocalSpeechProcess(
      { ...request(), deadline: Date.now() + 50 },
      {
        spawn() {
          value = child();
          return value;
        },
      },
    ),
    { status: 504 },
  );
  assert.equal(value.exitCode, 1);
});
test('overlong native diagnostics terminate the process without returning their contents', async () => {
  await assert.rejects(
    runLocalSpeechProcess(request(), {
      spawn() {
        const value = child();
        queueMicrotask(() => value.stderr.write('private-synthetic-output'.repeat(4000)));
        return value;
      },
    }),
    (error) => {
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /private-synthetic-output/);
      return true;
    },
  );
});
