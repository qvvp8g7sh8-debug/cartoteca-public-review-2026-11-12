const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { fail } = require('../../../../../shared/errors.cjs');
const { boundedText } = require('../../interpretation/intent-schema.cjs');
const { localEnabled, findRuntime, childEnvironment } = require('./local-speech-config.cjs');
const { validateLocalAudio } = require('./local-speech-audio.cjs');
const { runLocalSpeechProcess } = require('./local-speech-process.cjs');
const { localSpeechArguments } = require('./local-speech-arguments.cjs');
async function cleanup(temp) {
  if (!temp) return;
  if (
    path.dirname(temp.directory) !== temp.parent ||
    !path.basename(temp.directory).startsWith('cartoteca-local-speech-')
  )
    throw fail(503, 'Не удалось удалить временную запись распознавания.');
  const stat = await fs.lstat(temp.directory);
  if (stat.isSymbolicLink() || (await fs.realpath(temp.directory)) !== temp.directory)
    throw fail(503, 'Не удалось удалить временную запись распознавания.');
  await fs.rm(temp.directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
}
function createLocalSpeechRuntime(options = {}, dependencies = {}) {
  const eligible = localEnabled(options);
  const directory = options.directory || 'C:\\Cartoteca\\tools\\whisper';
  const probe = dependencies.findRuntime || findRuntime;
  const runtime = eligible ? probe(directory) : null;
  const execute = dependencies.runProcess || runLocalSpeechProcess;
  const threads = Number.isInteger(options.threads) ? Math.max(1, Math.min(4, options.threads)) : 4;
  let busy = false,
    poisoned = false;
  return {
    available: eligible,
    get sttAvailable() {
      return Boolean(runtime && !poisoned);
    },
    ttsAvailable: eligible,
    async run({ kind, payload, provider, timeoutMs, guard = () => {}, onOutbound = () => {} }) {
      if (!eligible)
        throw fail(503, 'Локальная речь доступна только в разрешённом локальном режиме.');
      if (
        provider?.provider !== 'local' ||
        !['stt', 'tts'].includes(kind) ||
        provider.model !== (kind === 'stt' ? 'whisper-base' : 'system-ru') ||
        (kind === 'tts' && provider.voice !== 'ru-local')
      )
        throw fail(400, 'Некорректные настройки локальной речи.');
      guard();
      if (kind === 'tts') {
        if (
          typeof payload?.input !== 'string' ||
          !payload.input.trim() ||
          payload.input.length > 1000
        )
          throw fail(400, 'Нет текста для локального озвучивания.');
        return { text: payload.input, audioBase64: null, mimeType: null, local: true };
      }
      if (!runtime || poisoned)
        throw fail(503, 'Локальное распознавание не установлено. Обратитесь к администратору.');
      if (busy) throw fail(429, 'Локальное распознавание уже занято. Дождитесь ответа.');
      const bytes = validateLocalAudio(payload);
      const prompt =
        payload.prompt === undefined
          ? ''
          : boundedText(payload.prompt, 4000, 'словарь распознавания').trim();
      if (!Number.isInteger(timeoutMs) || timeoutMs < 3000 || timeoutMs > 30000)
        throw fail(400, 'Некорректное время ожидания распознавания.');
      busy = true;
      const deadline = Date.now() + timeoutMs;
      let temp;
      try {
        const current = probe(directory);
        if (
          !current ||
          current.executable !== runtime.executable ||
          current.model !== runtime.model
        )
          throw fail(503, 'Локальное распознавание недоступно. Перезапустите локальную Картотеку.');
        const parent = await fs.realpath(os.tmpdir());
        const temporary = await fs.mkdtemp(path.join(parent, 'cartoteca-local-speech-'));
        temp = { parent, directory: temporary };
        if (path.dirname(await fs.realpath(temporary)) !== parent)
          throw fail(503, 'Не удалось подготовить временную запись распознавания.');
        const input = path.join(temporary, 'input.wav'),
          output = path.join(temporary, 'result');
        await fs.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
        const args = await localSpeechArguments({
          platform: dependencies.platform || process.platform,
          directory: temporary,
          model: runtime.model,
          input,
          output,
          threads,
          prompt,
        });
        guard();
        if (Date.now() >= deadline) throw fail(504, 'Истекло время локального распознавания.');
        const admitted = onOutbound();
        if (admitted && typeof admitted.then === 'function') await admitted;
        guard();
        if (Date.now() >= deadline) throw fail(504, 'Истекло время локального распознавания.');
        await execute({
          executable: runtime.executable,
          args,
          cwd: temporary,
          env: childEnvironment(temporary),
          deadline,
          guard,
        });
        guard();
        const file = output + '.txt',
          stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 16384)
          throw fail(502, 'Локальное распознавание не вернуло короткий текст.');
        const handle = await fs.open(file, 'r');
        let outputBytes;
        try {
          const buffer = Buffer.alloc(16385);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 16384) throw fail(502, 'Ответ распознавания превышает ограничение.');
          outputBytes = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(outputBytes).trim();
        if (!text || text.includes('\u0000'))
          throw fail(400, 'Речь не распознана. Попробуйте короткую фразу.');
        guard();
        return { text, local: true };
      } catch (error) {
        if (error.localSpeechCleanupFailed) poisoned = true;
        if (error.status) throw error;
        throw fail(502, 'Не удалось выполнить локальное распознавание. Попробуйте ещё раз.');
      } finally {
        try {
          await cleanup(temp);
        } catch {
          poisoned = true;
          throw fail(
            503,
            'Не удалось удалить временную запись. Перезапустите локальную Картотеку.',
          );
        } finally {
          busy = false;
        }
      }
    },
  };
}
module.exports = { createLocalSpeechRuntime };
