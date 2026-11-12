const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runProcess } = require('../src/server/modules/assistant/providers/codex/codex-process.cjs');
const {
  runLocalSpeechProcess,
} = require('../src/server/modules/assistant/providers/local-speech/local-speech-process.cjs');
function nativeChild() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}
for (const kind of ['codex', 'whisper']) {
  const run = kind === 'codex' ? runProcess : runLocalSpeechProcess;
  test(
    kind + ' revokes a silent process on the guard poll and preserves the access error',
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
      let permitted = true,
        kills = 0,
        guards = 0;
      const child = nativeChild();
      const terminate = () => {
        kills++;
        child.exitCode = 1;
        queueMicrotask(() => child.emit('close', 1));
      };
      child.kill = terminate;
      const pending = run(
        {
          executable: '/synthetic/native',
          args: [],
          cwd: '/synthetic',
          env: {},
          deadline: 9000,
          guard() {
            guards++;
            if (!permitted) throw Object.assign(Error('Synthetic access revoked'), { status: 403 });
          },
        },
        { spawn: () => child, terminate },
      );
      const rejected = assert.rejects(pending, {
        status: 403,
        message: 'Synthetic access revoked',
      });
      permitted = false;
      t.mock.timers.tick(250);
      await rejected;
      assert.equal(kills, 1);
      const after = guards;
      t.mock.timers.tick(10000);
      assert.equal(guards, after, 'finished process must not leave access polls running');
    },
  );
  test(
    kind + ' quarantines an unkillable process and ignores its late successful close',
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
      let permitted = true,
        kills = 0,
        guards = 0;
      const child = nativeChild();
      const terminate = () => {
        kills++;
        return false;
      };
      child.kill = terminate;
      const pending = run(
        {
          executable: '/synthetic/native',
          args: [],
          cwd: '/synthetic',
          env: {},
          deadline: 9000,
          guard() {
            guards++;
            if (!permitted) throw Object.assign(Error('Synthetic access revoked'), { status: 403 });
          },
        },
        { spawn: () => child, terminate },
      );
      const rejected = assert.rejects(pending, (error) => {
        assert.equal(error.status, 503);
        assert.equal(
          error[kind === 'codex' ? 'codexCleanupFailed' : 'localSpeechCleanupFailed'],
          true,
        );
        assert.doesNotMatch(error.message, /Synthetic access|native|synthetic/);
        return true;
      });
      permitted = false;
      t.mock.timers.tick(250);
      assert.equal(kills, 1);
      t.mock.timers.tick(5000);
      await rejected;
      const after = guards;
      child.exitCode = 0;
      child.emit('close', 0);
      t.mock.timers.tick(10000);
      assert.equal(guards, after, 'late close cannot revive guards or a completed request');
      assert.equal(kills, 1);
    },
  );
}
