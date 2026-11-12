const { spawn } = require('node:child_process');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { fail } = require('../../../../../shared/errors.cjs');

function terminateTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    const killer = spawn(
      path.join(system, 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    );
    killer.once('error', () => child.kill());
    killer.once('close', (code) => {
      if (code && child.exitCode === null) child.kill();
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}
function runProcess(
  {
    executable,
    args,
    cwd,
    env,
    input = '',
    deadline,
    guard,
    stdoutLimit = 131072,
    stderrLimit = 16384,
    onStdout = null,
  },
  dependencies = {},
) {
  const spawnImpl = dependencies.spawn || spawn;
  const terminate = dependencies.terminate || terminateTree;
  return new Promise((resolve, reject) => {
    let child,
      timer,
      poll,
      killTimer,
      finished = false,
      failure = null;
    let stdout = '',
      stderr = '',
      stdoutBytes = 0,
      stderrBytes = 0;
    const decoder = new StringDecoder('utf8');
    function finish(error, code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      clearTimeout(killTimer);
      if (error) reject(error);
      else if (code !== 0)
        reject(
          Object.assign(
            fail(502, 'Локальный Codex отклонил запуск. Проверьте вход и настройки изоляции.'),
            { codexExitCode: code },
          ),
        );
      else resolve({ stdout, stderr });
    }
    function stop(error) {
      if (finished || failure) return;
      failure = error;
      try {
        terminate(child);
      } catch {
        child.kill();
      }
      killTimer = setTimeout(() => {
        const stuck = fail(503, 'Процесс Codex не остановился. Перезапустите локальную Картотеку.');
        stuck.codexCleanupFailed = true;
        finish(stuck);
      }, 5000);
    }
    try {
      guard();
      if (Date.now() >= deadline) throw fail(504, 'Истекло время ответа Codex.');
      child = spawnImpl(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(error.status ? error : fail(503, 'Не удалось запустить локальный Codex.'));
      return;
    }
    child.once('error', () => {
      const error = fail(503, 'Не удалось запустить локальный Codex.');
      if (child.pid && child.exitCode === null) stop(error);
      else finish(failure || error);
    });
    child.once('close', (code) => {
      if (failure) {
        finish(failure);
        return;
      }
      try {
        guard();
        const tail = decoder.end();
        if (tail) {
          stdout += tail;
          onStdout?.(tail);
        }
        finish(null, code);
      } catch (error) {
        finish(error);
      }
    });
    child.stdout.on('data', (chunk) => {
      if (failure || finished) return;
      try {
        guard();
        stdoutBytes += chunk.length;
        if (stdoutBytes > stdoutLimit) throw fail(502, 'Ответ Codex превышает ограничение.');
        const text = decoder.write(chunk);
        stdout += text;
        onStdout?.(text);
      } catch (error) {
        stop(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (failure || finished) return;
      stderrBytes += chunk.length;
      if (stderrBytes > stderrLimit) {
        stop(fail(502, 'Диагностика Codex превышает ограничение.'));
        return;
      }
      stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {
      if (!finished && !failure) stop(fail(502, 'Не удалось передать команду Codex.'));
    });
    timer = setTimeout(
      () => stop(fail(504, 'Истекло время ответа Codex.')),
      Math.max(1, deadline - Date.now()),
    );
    poll = setInterval(() => {
      try {
        guard();
      } catch (error) {
        stop(error);
      }
    }, 250);
    child.stdin.end(input);
  });
}
module.exports = { runProcess };
