const { spawn } = require('node:child_process');
const { fail } = require('../../../../../shared/errors.cjs');
function runLocalSpeechProcess(
  { executable, args, cwd, env, deadline, guard = () => {} },
  dependencies = {},
) {
  const spawnImpl = dependencies.spawn || spawn;
  return new Promise((resolve, reject) => {
    let child,
      timer,
      poll,
      killTimer,
      failure = null,
      finished = false;
    const counts = { stdout: 0, stderr: 0 };
    function finish(error, code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      clearTimeout(killTimer);
      if (error) reject(error);
      else if (code !== 0)
        reject(fail(502, 'Локальное распознавание не завершилось. Попробуйте короткую запись.'));
      else resolve();
    }
    function stop(error) {
      if (finished || failure) return;
      failure = error;
      killTimer = setTimeout(
        () =>
          finish(
            Object.assign(
              fail(503, 'Процесс распознавания не остановился. Перезапустите локальную Картотеку.'),
              { localSpeechCleanupFailed: true },
            ),
          ),
        5000,
      );
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    try {
      guard();
      if (Date.now() >= deadline) throw fail(504, 'Истекло время локального распознавания.');
      child = spawnImpl(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(error.status ? error : fail(503, 'Не удалось запустить локальное распознавание.'));
      return;
    }
    child.once('error', () => {
      const error = fail(503, 'Не удалось запустить локальное распознавание.');
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
        finish(null, code);
      } catch (error) {
        finish(error);
      }
    });
    for (const name of ['stdout', 'stderr'])
      child[name].on('data', (chunk) => {
        if (finished || failure) return;
        counts[name] += chunk.length;
        if (counts[name] > 65536) {
          stop(fail(502, 'Диагностика распознавания превышает ограничение.'));
          return;
        }
        try {
          guard();
        } catch (error) {
          stop(error);
        }
      });
    timer = setTimeout(
      () => stop(fail(504, 'Истекло время локального распознавания.')),
      Math.max(1, deadline - Date.now()),
    );
    poll = setInterval(() => {
      try {
        guard();
      } catch (error) {
        stop(error);
      }
    }, 250);
  });
}
module.exports = { runLocalSpeechProcess };
